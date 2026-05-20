---
name: firebase-gcp-setup
description: Firebase project ID, service account, GCP org policy exception, and env var config for push notifications
metadata:
  type: reference
---

## Firebase Project

- Project name: `com.orbital.mobile`
- Project ID: `orbital-mobile-dc0cd`
- Service account: `orbital-push-service@orbital-mobile-dc0cd.iam.gserviceaccount.com`
- IAM role: `roles/firebasecloudmessaging.admin`

## Credentials

- Stored in `.env` on the PM2 droplet (134.199.230.235) as `FIREBASE_SERVICE_ACCOUNT_JSON`
- `PUSH_ENABLED=true` is live and active

## APNs

- APNs .p8 key uploaded to Firebase console
- Configured for both sandbox (development) and production environments
- iOS push goes through APNs via Firebase (not direct APNs connection)

## GCP Org Policy Note

- Org policy `iam.disableServiceAccountKeyCreation` was blocking key creation
- Workaround: conditional exception via resource tag `allow-sa-keys`
- Tag was removed after key generation — policy is re-enforced
- If a new service account key is ever needed, the tag procedure must be repeated

## pushService.js Initialization

- `firebase-admin` is lazily initialized on first push dispatch
- `PUSH_ENABLED` env guard — if false/unset, no pushes are sent (safe for local dev)
- `handleSendError` deactivates tokens on these FCM error codes:
  - `registration-token-not-registered`
  - `invalid-registration-token`
  - `invalid-argument`
