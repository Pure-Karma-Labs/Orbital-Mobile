---
name: SignalProtocolStore implementations (deleted)
description: 6 SQLCipher-backed store classes in src/services/crypto/ have been deleted. uniffi 0.31 cannot pass callback interfaces to Rust. Use cryptoService.ts (preloaded store pattern) instead.
type: project
---

**Status: all 6 `*StoreImpl` classes have been deleted from the codebase** (not merely deprecated — the files are gone).

The reason: uniffi 0.31 cannot pass callback interfaces (JS objects implementing Rust traits) to Rust functions. The production architecture is the preloaded store pattern in `cryptoService.ts`.

Deleted files (do not recreate):
- `IdentityKeyStoreImpl.ts`
- `PreKeyStoreImpl.ts`
- `SignedPreKeyStoreImpl.ts`
- `KyberPreKeyStoreImpl.ts`
- `SessionStoreImpl.ts`
- `SenderKeyStoreImpl.ts`

**Why:** uniffi-bindgen-react-native 0.31 does not support passing callback interfaces to Rust functions. Discovered during implementation of the actual crypto operations.

**How to apply:** Do not recreate these classes. Use `cryptoService.ts` exported functions for all Signal Protocol operations. See `project_crypto_service.md` for the production architecture.
