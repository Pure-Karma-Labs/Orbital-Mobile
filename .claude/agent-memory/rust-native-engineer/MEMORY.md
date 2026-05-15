# Rust Native Engineer Memory Index

- [uniffi feasibility](project_uniffi_feasibility.md) — RESOLVED: Arc<dyn CallbackInterface> blocker solved via Preloaded Store Pattern (Input/Result records + InMemSignalProtocolStore); store_adapters.rs is dead code
- [libsignal dependencies](project_libsignal_dependencies.md) — Git dep required, Signal forks of boring/curve25519 must be patched in Cargo.toml
- [libsignal API quirks](project_libsignal_api_quirks.md) — DeviceId is NonZeroU8, GenericSignedPreKey trait import, PreKeyBundle 10-arg constructor
- [cross-compilation setup](project_cross_compilation.md) — 5 targets, Rust 1.94.1, cargo-ndk 4.1.2, CI caching strategy
- [Attachment crypto pipeline (2026-05-14)](project_attachment_crypto.md) — AES-256-CBC+HMAC-SHA256, FFI bindings regenerated, build commands, known gaps (zeroize, Android, integration tests)
