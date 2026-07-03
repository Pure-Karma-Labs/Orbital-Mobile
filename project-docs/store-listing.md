# Orbital — Store Listing Metadata

Reference document for App Store Connect and Google Play Console submissions.

---

## App Identity

- **App Name**: Orbital
- **Developer**: Pure Karma Labs
- **Contact Email**: support@orbitl.org
- **Support URL**: https://orbitl.org
- **Marketing URL**: https://orbitl.org
- **Privacy Policy URL**: https://orbitl.org/privacy
- **Terms of Service URL**: https://orbitl.org/terms
- **Account Deletion URL**: https://orbitl.org/account-deletion

---

## Short Descriptions

### App Store Subtitle (max 30 chars)
```
Family. Friends. Community.
```
(27 chars)

### Play Store Short Description (max 80 chars)
```
Family. Friends. Community. Private, encrypted groups for the people who matter.
```
(80 chars)

---

## Full Description (max 4000 chars — shared across both stores)

```
Orbital is a private social network built for families. Create invite-only groups called "orbits," share photos, plan events, and have real conversations — all protected by end-to-end encryption.

YOUR FAMILY, YOUR SPACE

Unlike big social networks, Orbital is designed for the people who matter most. Create an orbit for your family, invite members with a secure code, and start sharing. No algorithms, no ads, no strangers.

END-TO-END ENCRYPTED

Every message, photo, and conversation in Orbital is encrypted using the Signal Protocol — the same technology trusted by journalists, activists, and security experts worldwide. Not even we can read your messages.

KEY FEATURES

- Private Groups: Create invite-only orbits for your family or close circle
- Encrypted Messaging: Real-time threads and direct messages with end-to-end encryption
- Photo Sharing: Share photos in a secure gallery that only your group can see
- Rich Link Previews: Share articles and videos with automatic previews
- Multi-Device Sync: Your encrypted orbit stays in sync across your devices
- No Ads, No Tracking: Your family's conversations are not a product
- Invite Codes: Add members with secure, one-time invite codes
- Offline Access: Read your messages even without an internet connection
- Dark Mode: Easy on the eyes, day or night

BUILT FOR FAMILIES

Orbital was created because families deserve a private place to communicate — not a feed full of ads and algorithmic recommendations. Whether you're planning a birthday dinner, sharing vacation photos, or just staying in touch, Orbital keeps your conversations private and your data yours.

OPEN SOURCE

Orbital is open source. You can inspect our code, verify our security claims, and see exactly how your data is handled. Transparency is not optional — it's a feature.
```
(1,389 chars)

---

## Category

| Store | Category |
|-------|----------|
| App Store | Social Networking |
| Play Store | Communication |

---

## Keywords (App Store only, max 100 chars, comma-separated)

```
family,messaging,encrypted,private,groups,chat,photos,secure,signal,social
```
(76 chars)

---

## Content Rating

### App Store (Apple)
- Age Rating: **18+** (defensive posture; minors should not be social networking)
- Content Descriptions: None (no violence, gambling, profanity, etc.)
- Made for Kids: **No**
- Note: Apple's rating system (Jan 2026) uses 4+, 9+, 13+, 16+, 18+. Encryption does not affect age rating.

### Play Store (IARC Questionnaire Answers)
- Target age group: **18+** (Adults)
- Is the app designed for children under 13? **No**
- Does the app contain violence? **No**
- Does the app contain sexual content? **No**
- Does the app contain profanity? **No**
- Does the app allow user-generated content? **Yes** (encrypted messages/photos)
- Does the app allow users to interact with each other? **Yes** (messaging)
- Does the app share user location? **No**
- Does the app contain ads? **No**
- Does the app allow purchases? **No**
- Does the app use encryption? **Yes** (Signal Protocol, AES-256-GCM)

---

## Assets Checklist

### Both Stores
- [x] Short description
- [x] Full description
- [x] App category
- [x] Contact email (support@orbitl.org — needs mailbox setup)
- [x] Content rating questionnaire answers

### App Store
- [x] Screenshots: `project-docs/app-store-screenshots/01-11_*.png` (iPhone 17 Pro Max, 6.7")
- [x] Keywords
- [x] Support URL: https://orbitl.org
- [x] Marketing URL: https://orbitl.org

### Play Store
- [x] Screenshots: `project-docs/app-store-screenshots/android_01-11_*.png`
- [x] Hi-res icon: `project-docs/play-store-icon-512.png` (512x512)
- [x] Feature graphic: `project-docs/play-store-feature-graphic.png` (1024x500)

---

## Notes

- App Store screenshots are from iPhone 17 Pro Max (6.7"). Apple will scale for 6.5" and 5.5" displays.
- Play Store screenshots are from Pixel 7 API 34 emulator.
- Invite code screenshots (iOS #11, Android #11) must be redacted before upload.
- support@orbitl.org mailbox needs to be provisioned before submission.
- Data Safety form answers are documented separately in `docs/play-store-data-safety.md`.

### Platform variants

App Store copy must never mention Android or cross-platform availability. The Play Store variant may reference cross-platform sync if desired.
