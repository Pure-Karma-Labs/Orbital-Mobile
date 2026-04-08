---
name: uniffi-bindgen-react-native feasibility — validated with caveats
description: uniffi 0.31.0 works for stateless functions; Arc<dyn CallbackInterface> in Object constructors and async_trait(?Send) remain blockers for store-backed operations
type: project
---

uniffi-bindgen-react-native 0.31.0-2 is validated as the binding toolchain. Issues #7-9 completed on 2026-04-07.

**What works:** Stateless exported functions (key generation, serialization utilities) generate correct Swift/Kotlin/TypeScript bindings. Callback interface trait definitions compile and generate. The full ubrn build pipeline (build:ios, build:android) produces .xcframework and .so outputs.

**What is blocked:** Store-backed protocol operations (encrypt, decrypt, session management) require passing Arc<dyn CallbackInterface> into Object constructors. uniffi 0.31.0 does not generate the FfiConverterArc impl for callback interfaces. Additionally, libsignal's store traits use #[async_trait(?Send)] which produces non-Send futures, incompatible with uniffi's Send requirement for async exports.

**Why this matters:** The 10 stubbed functions (session/group/sealed sender) cannot be implemented until either (1) uniffi gains callback interface Arc support in Object constructors, or (2) we adopt the native-side client pattern where Swift/Kotlin hold stores and call libsignal directly.

**How to apply:**
- The 8 working functions are sufficient for Phase 1 key generation PoC
- For Phase 2 session operations, plan for the native-side client pattern as the likely resolution path
- Monitor uniffi releases for Arc<dyn Trait> support — this would simplify the architecture significantly
- Fallback triggers from original decision still apply: RN 0.82+ incompatibility, >30min build times per target
