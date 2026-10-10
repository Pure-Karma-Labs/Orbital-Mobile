# Play Store Data Safety Form Reference

Exact answers for the Google Play Console Data Safety questionnaire. Fill in the Play Console form using this document as reference.

## Overview

- **Does your app collect or share any of the required user data types?** Yes
- **Is all of the user data collected by your app encrypted in transit?** Yes (HTTPS + WSS)
- **Do you provide a way for users to request that their data is deleted?** Yes
- **Account deletion URL:** `https://orbitl.org/delete-account` (see issue #257)

## Data Types

### Collected

| Data type | Play Store category | Collected | Shared | Ephemeral | Required | Purpose |
|---|---|---|---|---|---|---|
| Email address | Personal info > Email address | Yes | No | No | Yes | Account management |
| Username | Personal info > Name | Yes | No | No | Yes | App functionality |
| Display name | Personal info > Name | Yes | No | No | No | App functionality |
| User ID | Personal info > User IDs | Yes | No | No | Yes (auto-generated) | App functionality |
| FCM push token | Device or other IDs | Yes | No | No | Yes | App functionality |
| Device UUID | Device or other IDs | Yes | No | No | Yes | App functionality |
| Crash logs | App info and performance > Crash logs | Yes | No | No | No | Analytics |
| Notification preferences (per-type toggles, muted thread/conversation IDs) | App activity > App interactions | Yes | No | No | No | App functionality |

### Not Collected (E2EE)

These data types are encrypted client-side before upload. The server stores only ciphertext that the developer cannot access. Per Google's Data Safety guidance, E2EE data is not considered "collected."

- **Messages** (text content of threads and replies)
- **Photos and videos** (media attachments)
- **Files** (uploaded documents)
- **Avatar images** (encrypted with per-upload attachment keys)

## Per-Type Details

### Email address
- **Is this data collected, shared, or both?** Collected
- **Is this data processed ephemerally?** No
- **Is this data required for your app, or can users choose whether it's collected?** Required
- **Why is this user data collected?** Account management, authentication
- **Is this data shared with any third parties?** No

### Name (username / display name)
- **Is this data collected, shared, or both?** Collected
- **Is this data processed ephemerally?** No
- **Is this data required for your app, or can users choose whether it's collected?** Username: required. Display name: optional.
- **Why is this user data collected?** App functionality
- **Is this data shared with any third parties?** No (visible to orbit members within the app, but not shared externally)

### User IDs
- **Is this data collected, shared, or both?** Collected
- **Is this data processed ephemerally?** No
- **Is this data required for your app, or can users choose whether it's collected?** Required (auto-generated UUID)
- **Why is this user data collected?** App functionality
- **Is this data shared with any third parties?** No

### Device or other IDs
- **Is this data collected, shared, or both?** Collected
- **Is this data processed ephemerally?** No
- **Is this data required for your app, or can users choose whether it's collected?** Required (FCM token for push notifications, device UUID for device management)
- **Why is this user data collected?** App functionality
- **Is this data shared with any third parties?** No

### Crash logs
- **Is this data collected, shared, or both?** Collected
- **Is this data processed ephemerally?** No
- **Is this data required for your app, or can users choose whether it's collected?** Collected automatically
- **Why is this user data collected?** Analytics (app stability monitoring)
- **Is this data shared with any third parties?** No (Sentry acts as a service provider / data processor on behalf of the developer — not considered "sharing" per Google's Data Safety policy)
- **Payload note (2026-09-24, issue #746):** crash reports carry no network URLs, UI text, touch labels or console output. The client drops `http`, `touch`, `ui.multiClick` and `console` breadcrumbs before send, disables sentry-cocoa's network breadcrumbs so native crash reports carry no request URLs, and reports a rebuilt error carrying only the error class, a scrubbed message and scrubbed frames; message content, media and key material never reach the payload.

### App interactions (notification preferences)
- **Is this data collected, shared, or both?** Collected
- **Is this data processed ephemerally?** No
- **Is this data required for your app, or can users choose whether it's collected?** Optional (only stored when the user changes a notification toggle or mutes a thread/conversation; defaults produce no stored rows)
- **Why is this user data collected?** App functionality (server-side push suppression: the server must know which notification types are disabled and which thread/conversation IDs are muted so it never dispatches those pushes — iOS displays pushes before the app can filter them)
- **Is this data shared with any third parties?** No
- **Decision record (2026-08-03, issue #449):** stored as bare IDs and booleans only — no content, titles, or names; deleted via user-account CASCADE; declared because muted-conversation IDs are server-readable behavioural metadata.

### Saving media and files to the device (no declaration change)

The in-app Save feature lets a user write a decrypted copy of a photo, video or file they can already open out of Orbital and onto their own device (iOS: the photo library via add-only PhotoKit access, or the Files document picker; Android: MediaStore `Pictures/Orbital`, `Movies/Orbital` or `Download/Orbital`, or the matching public directory on API 24-28). It changes **no** answer in this form.

- **Is this data collected, shared, or both?** Neither. Nothing new is collected and nothing new is shared.
- **Is any new data type introduced?** No. The source bytes are the already-declared E2EE media and files, which the server holds only as ciphertext.
- **Does saving transmit anything off the device?** No. The copy is written locally and never sent to the developer, the Orbital server, or any third party.
- **Who initiates it?** The user, per item, with an explicit in-app Save action in the full-screen media viewer. There is no automatic, background or bulk save.
- **Decision record (2026-10-09, issue #878):** the Save feature requires no Data Safety change, on three independent grounds.
  1. **The "data that never leaves the device" collection exemption.** Google's Data Safety guidance treats data as *collected* only when it is transmitted off the device. The saved copy is written to the user's own device, by the user's own action, and is never transmitted to the developer or to anyone else — so it is not collected, and no new data type is declared.
  2. **The user-initiated sharing / transfer exemption.** Google's guidance does not treat data that the user chooses to transfer with an explicit in-app action — a system share or save sheet, or a document picker — as *shared* by the app. Each save is one deliberate, per-item user action through the OS's own save surface, so the "Shared" column stays No for every declared type.
  3. **The user's own cloud account is not a developer transfer.** If a saved copy is subsequently backed up to Google Photos, Google Drive or iCloud, that happens in the user's own account under their own OS-level backup setting, after the file has left the app. It is not a transfer by or to the developer and is likewise outside this app's declaration.
- **Permission note (2026-10-09, issue #878):** the feature declares `WRITE_EXTERNAL_STORAGE` and `READ_EXTERNAL_STORAGE`, both scoped `android:maxSdkVersion="28"` (API 29+ writes through MediaStore and needs neither). They are requested only inside a user-initiated save, are never requested at launch or in the background, and grant the app no new data collection — they exist solely so the user's chosen copy can be written to shared storage on Android 7-9.
- **Disclosure note (2026-10-09, issue #878):** before the first save ever happens, the app shows a one-time in-app disclosure stating that saved copies are stored on the device without end-to-end encryption, may be backed up to the user's own cloud service (Google Photos on Android, iCloud Photos on iOS), can be read by other apps with photo or file access, and remain on the device after logout or account deletion. The original stays in Orbital's encrypted archive; saving is a copy.

## Security Practices

- **Is all of the user data collected by your app encrypted in transit?** Yes
- **Can users request that their data is deleted?** Yes (in-app account deletion in Settings, web-accessible at deletion URL)

## App Audience and Access

- **Is this app directed at children?** No
- **Target age group:** 18+ (deliberate on both stores — a defensive posture for a user-generated-content app, not an accident; do not lower it without the owner's decision)

## Cross-Reference

These declarations align with the iOS `PrivacyInfo.xcprivacy` privacy nutrition labels (5 declared types: EmailAddress, Name, UserID, DeviceID, CrashData). The Play Store form includes Device IDs split into FCM token + device UUID, which maps to the single iOS `DeviceID` type.
