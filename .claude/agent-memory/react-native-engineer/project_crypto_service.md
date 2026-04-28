---
name: cryptoService — Signal Protocol encryption/decryption
description: Production crypto operations module at src/services/crypto/cryptoService.ts. Uses preloaded store pattern (TS reads SQLCipher → passes typed Input to Rust → Rust returns mutations → TS persists in BEGIN IMMEDIATE transaction). Per-address promise-queue lock prevents concurrent session state corruption.
type: project
---

`src/services/crypto/cryptoService.ts` is the production Signal Protocol encryption layer.

## Architecture: Preloaded Store Pattern

**Why this pattern:** uniffi 0.31 cannot pass JS callback interfaces to Rust functions. The 6 `*StoreImpl` classes that implement the OrbitalXxxStore traits cannot be passed to Rust as store arguments. Instead:

1. TypeScript reads all required store data from SQLCipher repositories before calling Rust
2. Data is packaged into a typed `*Input` record and passed to the Rust function
3. Rust runs libsignal, returns a `*Result` record containing crypto output + store mutations (updated session record, consumed pre-key IDs, etc.)
4. TypeScript applies mutations atomically in a `BEGIN IMMEDIATE ... COMMIT` transaction

This is the **permanent architecture** — do not attempt to switch back to callback interfaces.

## Public API (exported from `src/services/crypto/index.ts`)

```
encrypt(remoteAddress, plaintext) → Promise<CiphertextMessageData>
decrypt(senderAddress, ciphertextBytes, envelopeType) → Promise<Uint8Array>
encryptGroup(distributionId, senderAddress, plaintext) → Promise<Uint8Array>
decryptGroup(senderAddress, distributionId, ciphertextBytes) → Promise<Uint8Array>
createSenderKeyDistribution(distributionId, senderAddress) → Promise<Uint8Array>
processSenderKeyDistribution(senderAddress, distributionId, distributionMessage) → Promise<void>
EnvelopeType  (const: CIPHERTEXT=1, PRE_KEY_BUNDLE=3)
EnvelopeTypeValue  (type)
```

`decrypt` is a dispatcher: envelope type 1 → `decryptSignalMessage` (private), type 3 → `decryptPreKeyMessage` (private).

`establishSession` is private — called internally by `encrypt` when no session exists (auto X3DH via `getPreKeyBundle` API call + `processPreKeyBundle` Rust function).

## Per-Address Lock

Module-scoped `Map<string, Promise<unknown>>` keyed by `"{name}:{deviceId}"`. `withAddressLock(key, fn)` chains operations on the same address into a promise queue, preventing interleaved reads/writes to the same session record.

**How to apply:** All new operations that read-modify-write a session or sender key must run inside `withAddressLock`. Do not add parallel operations on the same address.

## Transaction Pattern

All store mutations (after Rust returns) use `withTransaction(() => { ... })` which calls `db.executeSync('BEGIN IMMEDIATE')`. `BEGIN IMMEDIATE` (not `BEGIN`) acquires a write lock immediately, preventing SQLite's deferred-lock TOCTOU issues.

**How to apply:** Always use `BEGIN IMMEDIATE` for transactions that will write. Plain `BEGIN` is only safe for read-only transactions.

## Utils (`src/services/crypto/utils.ts`)

Five helpers, all exported:
- `toArrayBuffer(u8: Uint8Array): ArrayBuffer`
- `bytesEqual(a, b): boolean`
- `hexToUint8Array(hex): Uint8Array` — validates hex characters, throws on NaN (security fix)
- `uint8ArrayToHex(bytes): string`
- `arrayBufferToBase64(buffer): string`
- `base64ToArrayBuffer(base64): string` — added this session; needed by `bundleResponseToData` to convert pre-key bundle fields from the REST API

## Identity Key Cache

`loadIdentityKeyPair()` in `cryptoService.ts` does NOT read from SQLCipher's items table. It reads from `getCachedIdentityPrivateKeyHex()` — a module-scoped cache inside `keyGenerationService.ts`.

- `initIdentityKeyCache()` (exported from `keyGenerationService.ts`) must be called during bootstrap to populate the cache before any crypto operation
- `clearIdentityKeyCache()` is called from `logout()` in `authService.ts` to wipe the cached private key on sign-out

**How to apply:** If bootstrap order ever changes, ensure `initIdentityKeyCache()` runs before any `cryptoService` function is called. On logout, `clearIdentityKeyCache()` is called automatically via `authService.logout()` — do not call it separately.

## Security Notes

- Private key material (`identityKeyPrivate`) is passed to Rust only inside `EncryptInput`/`DecryptInput` records — never logged, never returned, never persisted by this module
- Identity private key lives in a module-scoped memory cache (not SQLCipher) — cleared on logout via `clearIdentityKeyCache()`
- `hexToUint8Array` throws on invalid hex characters (NaN guard added per security audit)
- `keyGenerationService.ts` uses `BEGIN IMMEDIATE` for its transactions (updated per security audit finding)
