# Orbital Mobile App — Migration & Development Spec

## Context

Orbital is a private social network for families, built on Signal's E2EE foundation. The desktop app (Orbital-Desktop) is a fork of Signal-Desktop, which creates maintenance burden and limits portability. This spec defines how to build native-quality iOS and Android apps using React Native, sharing the same orbital-backend and encryption protocol — without forking Signal's mobile codebases.

**Key decisions made:**
- **Framework:** React Native (not fully native Swift/Kotlin — avoids replicating the Signal fork problem on mobile)
- **Crypto:** Turbo Modules wrapping `@signalapp/libsignal-client` Rust binaries via uniffi-bindgen-react-native
- **Multi-device:** Phone-only for beta (no simultaneous desktop + mobile)
- **Backend:** Existing orbital-backend with targeted additions (push notifications)

**Repository:** New repo (`Orbital-Mobile` or similar). Developers have read access to `alexg-g/Orbital-Desktop` (public).

---

## Part 1: Architecture Overview

```
┌──────────────────────────────────────────────────────┐
│                  React Native App                     │
│                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │  UI Layer    │  │  State/Logic │  │  Crypto    │ │
│  │  (React)     │  │  (Services)  │  │  (Turbo)   │ │
│  │              │  │              │  │            │ │
│  │  Screens:    │  │  Auth        │  │  libsignal │ │
│  │  - Login     │  │  Groups      │  │  via       │ │
│  │  - Inbox     │  │  Threads     │  │  uniffi    │ │
│  │  - Thread    │  │  Media       │  │  bindings  │ │
│  │  - Settings  │  │  WebSocket   │  │            │ │
│  │  - Composer  │  │  Crypto      │  │  Native:   │ │
│  │  - Gallery   │  │              │  │  Swift/    │ │
│  └──────────────┘  └──────────────┘  │  Kotlin    │ │
│                                      └────────────┘ │
└──────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────┐
│              orbital-backend (unchanged)              │
│                                                      │
│  REST API (https://api.orbitl.org)                   │
│  WebSocket (wss://api.orbitl.org/v1/websocket)       │
│  + NEW: Push notification dispatch (APNs/FCM)        │
└──────────────────────────────────────────────────────┘
```

---

## Part 2: Crypto — libsignal Turbo Module

### The Problem

`@signalapp/libsignal-client` uses Node-API (NAPI) bindings. React Native's Hermes engine does not support NAPI. The official npm package cannot be used directly.

### The Solution: uniffi-bindgen-react-native

[uniffi-bindgen-react-native](https://github.com/jhugman/uniffi-bindgen-react-native) (backed by Mozilla) auto-generates TypeScript Turbo Module bindings from Rust code. Mozilla uses UniFFI at scale in Firefox mobile (hundreds of millions of users).

**Approach:** Create a thin Rust crate that wraps only the libsignal functions Orbital actually uses, annotated with UniFFI proc macros. uniffi-bindgen generates Swift, Kotlin, and TypeScript bindings automatically.

### Minimal libsignal API Surface Needed

Based on analysis of Orbital-Desktop's actual usage, these are the ~15-20 functions needed:

#### Session Management (X3DH + Double Ratchet)
| Function | Purpose | Desktop reference |
|----------|---------|-------------------|
| `processPreKeyBundle()` | Establish session with new recipient | `ts/textsecure/OutgoingMessage.ts` |
| `signalEncrypt()` | Encrypt message for 1-on-1 session | `ts/textsecure/OutgoingMessage.ts` |
| `signalDecrypt()` | Decrypt incoming 1-on-1 message | `ts/textsecure/MessageReceiver.ts` |
| `signalDecryptPreKey()` | Decrypt first message (pre-key) | `ts/textsecure/MessageReceiver.ts` |

#### Sender Keys (Group Messaging)
| Function | Purpose | Desktop reference |
|----------|---------|-------------------|
| `groupEncrypt()` | Encrypt for group using Sender Key | `ts/util/sendToGroup.preload.ts` |
| `groupDecrypt()` | Decrypt group message | `ts/textsecure/MessageReceiver.ts` |
| `SenderKeyDistributionMessage.create()` | Generate sender key for distribution | `ts/util/sendToGroup.preload.ts` |
| `SenderKeyDistributionMessage.process()` | Process received sender key | `ts/textsecure/MessageReceiver.ts` |

#### Key Generation
| Function | Purpose |
|----------|---------|
| `IdentityKeyPair.generate()` | Generate long-term identity key |
| `generatePreKey()` | Generate one-time pre-keys |
| `generateSignedPreKey()` | Generate signed pre-key |
| `generateKyberPreKey()` | Generate post-quantum pre-key |

#### Sealed Sender
| Function | Purpose |
|----------|---------|
| `sealedSenderEncrypt()` | Encrypt with hidden sender metadata |
| `sealedSenderDecryptToUsmc()` | Decrypt sealed sender message |

### Store Interfaces to Implement

The mobile app must implement these persistent stores (SQLite-backed):

```
SignalProtocolStore
├── IdentityKeyStore     → getIdentityKeyPair(), saveIdentity(), isTrustedIdentity()
├── SessionStore         → loadSession(), storeSession()
├── PreKeyStore          → loadPreKey(), removePreKey()
├── SignedPreKeyStore    → loadSignedPreKey()
├── KyberPreKeyStore     → loadKyberPreKey(), markKyberPreKeyUsed()
└── SenderKeyStore       → saveSenderKey(), getSenderKey()
```

**Desktop reference:** `ts/SignalProtocolStore.preload.ts` (2,855 lines) — but mobile implementation will be much simpler since we only need the subset above, not Signal's full multi-device complexity.

### Alternative Path (if uniffi-bindgen proves difficult)

Write manual Turbo Modules for only the ~15-20 functions above:
- **iOS:** Swift wrapper calling `libsignal-ffi.a` (the same `.a` file Signal-iOS uses)
- **Android:** Kotlin wrapper calling `libsignal_jni.so` (the same `.so` Signal-Android uses)
- **JS:** TypeScript interface exposed via JSI

This is more manual work but avoids the uniffi toolchain dependency.

### Key Risk: libsignal is not a stable public API

Signal does not publish libsignal-ffi as a versioned, stable API. Breaking changes can occur between releases. **Mitigation:** Pin to a specific libsignal version (currently v0.83.0 on desktop) and only upgrade deliberately.

---

## Part 3: Backend Changes Required

### Current State (No Changes Needed)
The existing orbital-backend API is **fully compatible** with mobile clients as-is. All 35+ endpoints use standard REST + JWT auth. The WebSocket protocol is platform-agnostic.

### New: Push Notification Service

**Why:** Mobile apps can't maintain persistent WebSocket connections when backgrounded. Push notifications are required for message delivery.

**Implementation:**

```
┌─────────────────────────────────────────┐
│           orbital-backend               │
│                                         │
│  New table: device_tokens               │
│  ┌─────────────────────────────────┐    │
│  │ user_id    (FK → users)        │    │
│  │ platform   ('ios' | 'android') │    │
│  │ token      (APNs/FCM token)    │    │
│  │ created_at                     │    │
│  │ updated_at                     │    │
│  └─────────────────────────────────┘    │
│                                         │
│  New endpoints:                         │
│  POST /api/devices/register             │
│  DELETE /api/devices/:tokenId           │
│                                         │
│  New service: pushNotificationService   │
│  - sendPush(userId, payload)            │
│  - Uses APNs (iOS) + FCM (Android)     │
│  - Triggered alongside WebSocket        │
│    broadcasts in signalWebSocket.js     │
└─────────────────────────────────────────┘
```

**Push payload (encrypted):**
```json
{
  "type": "new_thread | new_reply | new_message",
  "conversation_id": "uuid",
  "thread_id": "uuid (if applicable)",
  "sender_display_name": "string",
  "notification_body": "encrypted (client decrypts)"
}
```

**Note:** Push payloads should contain minimal metadata. The app fetches full encrypted content via API on open.

### New: App Version Check (Optional)

```
GET /api/version/check?platform=ios&version=1.0.0
→ { "update_required": false, "latest_version": "1.0.0" }
```

---

## Part 4: Complete API Reference

The mobile app connects to the same API the desktop app uses. Full endpoint listing:

### Authentication (no auth required)
| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/signup` | Register (requires invite code + email) |
| POST | `/api/login` | Authenticate → JWT (30-day) |
| POST | `/api/verify-token` | Validate JWT |
| GET | `/api/users/:username/public-key` | Get public key for key exchange |

### Groups/Orbits
| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/groups` | Create orbit |
| POST | `/api/groups/join` | Join via invite code |
| GET | `/api/groups` | List user's orbits |
| GET | `/api/groups/:id/members` | List members |
| GET | `/api/groups/:id/key` | Get encrypted group key |
| GET | `/api/groups/:id/quota` | Storage quota status |
| DELETE | `/api/groups/:id/members/:userId` | Remove member (creator only) |
| POST | `/api/groups/dm` | Create/get DM conversation |
| GET | `/api/groups/dms` | List DM conversations |

### Threads
| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/threads` | Create thread (supports client-generated UUID) |
| GET | `/api/groups/:id/threads` | List threads (paginated, sorted) |
| GET | `/api/threads/:id` | Get thread detail + media |
| GET | `/api/threads/:id/replies` | Get replies (nested, Reddit-style) |
| POST | `/api/threads/:id/replies` | Post reply (supports nesting via parent_reply_id) |

### Signal Protocol Relay
| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/v1/messages` | Send encrypted envelope |
| GET | `/v1/messages` | Fetch envelopes (since timestamp, paginated) |
| DELETE | `/v1/messages/:id` | Delete message (sender only) |

### Media
| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/media/upload/chunk` | Chunked upload (5MB chunks, 500MB max) |
| GET | `/api/media/:id/download` | Download encrypted media |

### User Profile
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/users/me` | Current user profile |
| GET | `/api/users/:id` | Public profile (shared group required) |
| POST | `/api/users/avatar` | Upload avatar (multipart, 5MB max) |
| DELETE | `/api/users/avatar` | Remove avatar |
| PUT | `/api/users/display-name` | Update display name (1-15 chars) |

### Invites
| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/invites/generate` | Generate invite code for email |
| POST | `/api/invites/generate-link` | Generate deep link (`orbital://invite/CODE`) |
| GET | `/api/invites/status/:code` | Check invite status |
| GET | `/api/invites/group/:id` | Invite history (creator only) |

### WebSocket (wss://api.orbitl.org/v1/websocket)

**Connection:** JWT token in query param `?token=...`
**Heartbeat:** 30-second ping/pong

**Events received:**
- `new_message` — Signal Protocol encrypted envelope
- `new_thread` — Thread created in subscribed group
- `new_reply` — Reply posted to thread
- `display_name_changed` — User updated display name

**Events sent:**
- `ping` → receives `pong`
- `subscribe` → subscribe to conversation updates
- `typing` → typing indicator (stub)

---

## Part 5: Client Data Model & Encryption

### Encryption Architecture

All content is encrypted client-side before transmission. The server is zero-knowledge.

**Encrypted fields:**
- Thread titles and bodies (`encrypted_title`, `encrypted_body` + IVs)
- Reply bodies (`encrypted_body` + IV)
- Group names (`encrypted_name`)
- Group keys (`encrypted_group_key` — per-member copy)
- Media metadata (`encrypted_metadata` — contains filename, type, dimensions)
- Signal message envelopes (`encrypted_envelope` — protobuf)

**Encryption scheme for thread content:** AES-GCM with per-field IVs (64-char hex), using the group key.

**Encryption scheme for media:** AES-256-CBC with HMAC-SHA256 (keys stored in `attachmentKeys` as base64).

### Local Storage Schema (SQLite/SQLCipher on device)

The mobile app needs local tables mirroring the server schema:

```sql
-- Threads (decrypted locally)
orbital_threads (
  id TEXT PRIMARY KEY,
  group_id TEXT,
  author_id TEXT,
  author_username TEXT,
  encrypted_title TEXT,
  encrypted_body TEXT,
  title_iv TEXT,
  body_iv TEXT,
  reply_count INTEGER,
  media_count INTEGER,
  created_at INTEGER,
  last_reply_at INTEGER,
  pending_sync INTEGER DEFAULT 0  -- offline-first support
)

-- Media with 7-day server retention + permanent local storage
orbital_media (
  id TEXT PRIMARY KEY,
  media_id TEXT,
  thread_id TEXT,
  group_id TEXT,
  attachment_keys TEXT,     -- base64(AES-256 + HMAC keys)
  plaintext_hash TEXT,
  digest TEXT,
  size INTEGER,
  content_type TEXT,
  file_name TEXT,
  blur_hash TEXT,
  width INTEGER,
  height INTEGER,
  duration REAL,
  expires_at INTEGER,       -- 7-day server expiration
  local_path TEXT,          -- permanent local path after download
  downloaded INTEGER DEFAULT 0,
  created_at INTEGER,
  uploaded_by TEXT
)

-- Signal Protocol stores (see Part 2)
signal_sessions (...)
signal_pre_keys (...)
signal_signed_pre_keys (...)
signal_sender_keys (...)
signal_identity_keys (...)
```

---

## Part 6: Screens to Build

Based on desktop component analysis (`ts/components/orbital/`), the mobile app needs these screens:

### 1. Auth Flow
- **Login Screen** — username + password → JWT
- **Signup Screen** — username + password + email + invite code
- Reference: `OrbitalLogin.tsx`

### 2. Inbox (Main Screen)
- **Tab bar:** Threads | Chats | Settings
- **Orbit selector** at top (switch between groups)
- **Thread list** with day separators, search, unread indicators
- Reference: `OrbitalInbox.tsx`, `OrbitalThreadList.tsx`

### 3. Thread Detail
- Thread title + original post (level 0)
- Nested replies with color-coded depth (Blue → Purple alternating)
- Indentation: `24px * min(level, 4)` (caps at 96px)
- Reply composer at bottom with media attachment support
- Reference: `OrbitalThreadDetail.tsx`, `OrbitalMessage.tsx`

### 4. Composer
- Rich text input (thread title + body, or reply body)
- Media attachment picker (camera, gallery)
- Upload progress indicator with quota checking
- Draft persistence
- Reference: `OrbitalComposer.tsx`

### 5. Media Gallery & Lightbox
- Photo grid layouts (1, 2, 3, 4+ photos)
- Full-screen lightbox with swipe navigation
- Video playback
- Download progress indicator
- Expiration warnings (< 1 day left on server)
- Reference: `OrbitalPhotoGallery.tsx`, `OrbitalPhotoLightbox.tsx`, `OrbitalMediaViewer.tsx`

### 6. Settings
- Profile (display name, avatar)
- Notifications
- Privacy
- Storage/files (quota usage)
- Orbit management (invite members)
- Reference: `OrbitalSettings.tsx` and sub-pages

### 7. Group Management
- Create orbit modal
- Join orbit via invite code or deep link (`orbital://invite/CODE`)
- Member list
- Reference: `CreateGroupModal.tsx`, `JoinGroupModal.tsx`, `GroupSelector.tsx`

### Visual Design
- **Font:** Verdana (retro 2000s aesthetic) — use closest mobile equivalent
- **Reply depth colors:** Blue (levels 0-1) → Purple (levels 2-3), alternating
- **Day separators:** ASCII art styling
- Design tokens in `stylesheets/_orbital-variables.scss`

---

## Part 7: Implementation Phases

### Phase 1: Foundation (Weeks 1-4)
- [ ] Initialize React Native project (RN 0.82+, New Architecture)
- [ ] Set up uniffi-bindgen-react-native toolchain
- [ ] Create thin Rust crate wrapping libsignal v0.83.0 (pin version)
- [ ] Implement ~15-20 libsignal function bindings
- [ ] Implement SignalProtocolStore (SQLite-backed, ~6 store interfaces)
- [ ] Build auth flow (login, signup, JWT storage)
- [ ] Connect to orbital-backend REST API

### Phase 2: Core Features (Weeks 5-8)
- [ ] Thread list screen with pagination and search
- [ ] Thread detail with nested replies
- [ ] Thread/reply creation with encryption
- [ ] Group management (create, join, list members)
- [ ] WebSocket integration for real-time updates
- [ ] Basic offline-first support (client-generated UUIDs, pending sync)

### Phase 3: Media & Polish (Weeks 9-12)
- [ ] Media upload (chunked, encrypted, with progress)
- [ ] Media download with lazy loading
- [ ] Photo gallery and lightbox
- [ ] Video playback
- [ ] Push notifications (backend + mobile)
- [ ] Deep link handling (`orbital://invite/CODE`)
- [ ] Settings screens
- [ ] Draft persistence

### Phase 4: Beta (Weeks 13-16)
- [ ] Internal dogfooding
- [ ] Performance optimization
- [ ] TestFlight (iOS) + Play Store internal testing (Android)
- [ ] Security audit of crypto module
- [ ] Crash reporting and analytics (privacy-preserving)

---

## Part 8: Key Reference Files in Orbital-Desktop

These files in the desktop codebase serve as the authoritative reference:

### Crypto / Signal Protocol
| File | Lines | Purpose |
|------|-------|---------|
| `ts/SignalProtocolStore.preload.ts` | 2,855 | Complete protocol store — reference for mobile store implementation |
| `ts/LibSignalStores.preload.ts` | 330 | Store interface wrappers (Sessions, IdentityKeys, PreKeys, etc.) |
| `ts/util/sendToGroup.preload.ts` | — | Group encryption with Sender Keys |
| `ts/textsecure/OutgoingMessage.ts` | — | Message encryption pipeline |
| `ts/textsecure/MessageReceiver.ts` | — | Message decryption pipeline |
| `ts/textsecure/getKeysForServiceId.preload.ts` | — | Pre-key bundle fetching |

### Services (API integration patterns)
| File | Purpose |
|------|---------|
| `ts/services/orbitalThreads.preload.ts` | Thread CRUD — replicate API calls |
| `ts/services/orbitalGroups.preload.ts` | Group management |
| `ts/services/orbitalMedia.preload.ts` | Media operations |
| `ts/services/orbitalMediaUpload.preload.ts` | Chunked upload pipeline |
| `ts/services/orbitalMediaDownload.preload.ts` | Download with lazy loading |
| `ts/services/orbitalWebSocket.preload.ts` | WebSocket connection management |
| `ts/services/orbitalAuth.preload.ts` | Authentication |
| `ts/services/orbitalQuota.preload.ts` | Storage quota tracking |

### Types (data model contracts)
| File | Purpose |
|------|---------|
| `ts/types/OrbitalThread.std.ts` | Thread/reply type definitions |
| `ts/types/OrbitalMedia.std.ts` | Media attachment types with encryption metadata |
| `ts/types/OrbitalMediaSync.std.ts` | Async media recovery types |
| `ts/types/Nav.std.ts` | DisplayMode enum, settings page enum |

### UI Components (screen references)
| File | Purpose |
|------|---------|
| `ts/components/orbital/OrbitalInbox.tsx` | Main orchestration — state management hub |
| `ts/components/orbital/OrbitalThreadList.tsx` | Thread list with search + day separators |
| `ts/components/orbital/OrbitalThreadDetail.tsx` | Thread view with nested replies |
| `ts/components/orbital/OrbitalComposer.tsx` | Rich text + media composer |
| `ts/components/orbital/OrbitalPhotoGallery.tsx` | Photo grid layouts |
| `ts/components/orbital/OrbitalSettings.tsx` | Settings container |

### Backend
| File | Purpose |
|------|---------|
| `orbital-backend/schema.sql` | Complete database schema |
| `orbital-backend/src/routes/*.js` | All API route handlers |
| `orbital-backend/src/websocket/signalWebSocket.js` | WebSocket server implementation |
| `orbital-backend/src/middleware/auth.js` | JWT auth middleware |
| `orbital-backend/src/services/groupService.js` | Group business logic |

---

## Part 9: Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| uniffi-bindgen-react-native not yet 1.0 | Medium | Mozilla backs it; matrix-rust-sdk uses it in production. Fallback: manual Turbo Modules for ~15 functions |
| libsignal has no stable public FFI API | High | Pin to v0.83.0, wrap minimal surface, upgrade deliberately |
| No one has wrapped libsignal via uniffi before | Medium | We only need ~15-20 functions, not all 302. Proof-of-concept in Phase 1 |
| React Native crypto performance | Low | JSI provides synchronous native calls; crypto runs in native Rust, not JS |
| Media upload/download on cellular | Medium | Chunked uploads (5MB), resume support, WiFi-only option |
| Push notification reliability | Medium | Dual delivery: push + WebSocket catch-up on app open |
| SQLite concurrent access | Low | Use WAL mode, single writer pattern |

---

## Part 10: What This Spec Does NOT Cover (Deferred)

- **Multi-device support** — deferred post-beta (requires device registration, per-device keys, message fan-out)
- **Desktop <> mobile account migration** — beta is phone-only; users create new accounts
- **App Store submission** — will need Apple/Google review prep
- **Analytics / crash reporting** — pick privacy-preserving solution during beta
- **Accessibility** — important but not in initial spec scope
- **Localization / i18n** — English-only for beta

---

## Verification

Before handing off to the mobile team, verify:

1. **Backend compatibility:** Run `npm test` in `orbital-backend/` — all integration tests pass, confirming API contracts
2. **Crypto proof-of-concept:** Build a minimal uniffi-bindgen-react-native project that calls `signalEncrypt()` / `signalDecrypt()` on both iOS and Android
3. **API documentation accuracy:** Test each endpoint listed in Part 4 against the running backend (`http://localhost:3000`)
4. **Storybook:** Run `pnpm run dev` in Orbital-Desktop to view component stories — these serve as visual specs for mobile screens
