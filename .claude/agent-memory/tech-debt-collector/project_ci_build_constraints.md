---
name: ci-build-constraints
description: Android Rust cross-compilation needs 60min timeout; Firebase config injected from GitHub secrets
metadata:
  type: project
---

Android builds that include Rust cross-compilation require a 60-minute timeout (default was insufficient). This was discovered during #95 ECIES work.

**Why:** The Rust cross-compilation step for Android (building for multiple ABIs) is significantly slower than iOS builds. The default CI timeout caused intermittent build failures that looked like flaky tests but were actually timeout kills.

**How to apply:** When adding new Rust native modules or expanding the uniffi surface, verify the Android build step still completes within the 60-minute window. If Rust crate dependencies grow substantially, the timeout may need further increase.

Firebase config files (`google-services.json`, `GoogleService-Info.plist`) are injected from GitHub secrets (`GOOGLE_SERVICES_JSON_BASE64`, `GOOGLE_SERVICE_INFO_PLIST_BASE64`) during CI. These are NOT checked into the repo.

Related: [[ecies-group-keys-status]]
