---
name: zeroize-pattern
description: Zeroizing<Vec<u8>> key wrapping pattern applied across attachment_crypto.rs and content_crypto.rs
created: 2026-05-19
---

## Zeroize Pattern (PR #129, #130)

Both `attachment_crypto.rs` and `content_crypto.rs` now wrap key parameters in `Zeroizing::new(key)` immediately on entry (before validation), ensuring keys are zeroed on all exit paths.

### Cargo.toml feature flags
- `aes = { features = ["zeroize"] }` — zeroes AES round keys on drop
- `cbc = { features = ["zeroize"] }` — zeroes CBC cipher state on drop
- `aes-gcm = { features = ["zeroize"] }` — zeroes GCM cipher state on drop
- `hmac = { features = ["reset"] }` — does NOT enable zeroize-on-drop (no such feature in hmac 0.12)
- `sha2 = "0.10"` — no zeroize feature (hash state doesn't hold key material)

### Key gotchas
- `lto = "thin"` does NOT elide zeroization — `write_volatile` + `compiler_fence` survives all LTO
- uniffi checksums unchanged when internal Zeroizing wrapping added (signatures stay `Vec<u8>`)
- `attachment_encrypt_inner` must NEVER be `pub` or `#[uniffi::export]` — deterministic IV = broken CBC
- `Zeroizing::new(keys.to_vec())` inside inner function creates unnecessary copy — pass `&[u8]` and let outer handle ownership
