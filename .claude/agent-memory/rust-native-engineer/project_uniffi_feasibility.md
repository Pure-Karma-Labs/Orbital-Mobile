---
name: uniffi-bindgen-react-native feasibility decision
description: Decision to proceed with uniffi-bindgen-react-native for wrapping libsignal v0.83.0 in Orbital-Mobile, with fallback triggers defined
type: project
---

Decided to proceed with uniffi-bindgen-react-native as primary approach for wrapping libsignal.

**Why:** Nicegram has production precedent wrapping libsignal with this exact toolchain. Type safety across Swift/Kotlin/TypeScript from a single Rust source is a significant maintenance advantage over manual Turbo Modules (which would require 3 separate implementations staying in sync).

**How to apply:** 
- PoC target: IdentityKeyPair.generate() end-to-end on both platforms
- Store callbacks: implement on native side (Swift/Kotlin with direct SQLCipher access), not through JS
- Fallback triggers: RN 0.82+ incompatibility, broken callback interfaces, unusable TS bindings, or >30min build times per target
- Full feasibility doc written to docs/uniffi-udl-feasibility.md on 2026-04-07
