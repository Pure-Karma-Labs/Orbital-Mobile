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
| User ID | App activity > Other user-generated content | Yes | No | No | Yes (auto-generated) | App functionality |
| FCM push token | Device or other IDs | Yes | No | No | Yes | App functionality |
| Device UUID | Device or other IDs | Yes | No | No | Yes | App functionality |
| Crash logs | App info and performance > Crash logs | Yes | Yes (Sentry) | No | No | Analytics |

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
- **Is this data collected, shared, or both?** Both (shared with Sentry for crash reporting)
- **Is this data processed ephemerally?** No
- **Is this data required for your app, or can users choose whether it's collected?** Collected automatically
- **Why is this user data collected?** Analytics (app stability monitoring)
- **Is this data shared with any third parties?** Yes
  - **Third party:** Sentry (functional.software GmbH)
  - **Purpose:** App diagnostics and crash reporting
  - **Is this data transferred as part of a service provider relationship?** Yes (Sentry acts as a data processor)
  - **Is this data sold?** No

## Security Practices

- **Is all of the user data collected by your app encrypted in transit?** Yes
- **Can users request that their data is deleted?** Yes (in-app account deletion in Settings, web-accessible at deletion URL)

## App Audience and Access

- **Is this app directed at children?** No
- **Target age group:** 13+

## Cross-Reference

These declarations align with the iOS `PrivacyInfo.xcprivacy` privacy nutrition labels (5 declared types: EmailAddress, Name, UserID, DeviceID, CrashData). The Play Store form includes Device IDs split into FCM token + device UUID, which maps to the single iOS `DeviceID` type.
