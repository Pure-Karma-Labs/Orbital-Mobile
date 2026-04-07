# uniffi-bindgen-react-native Feasibility Assessment

**Date:** 2026-04-07
**Author:** Rust / Native Module Engineer
**Status:** Decision-enabling analysis
**Context:** Orbital-Mobile needs to call ~15-20 libsignal-client (v0.83.0) functions from React Native on iOS and Android. The mobile app spec prescribes uniffi-bindgen-react-native as the primary approach.

---

## Prior Art: Nicegram

uniffi-bindgen-react-native was created by the Nicegram team (Nicegram is a Telegram client) specifically to wrap libsignal for their React Native app. This is direct, production-validated precedent for our exact use case. The tool lives at `jhugman/uniffi-bindgen-react-native` and builds on Mozilla's `uniffi-rs`, which powers Firefox mobile (hundreds of millions of installs).

---

## 1. Supported UDL Type Mappings

UniFFI supports the following type mappings. All of these are relevant to our libsignal wrapper.

| Rust Type | UDL Type | TypeScript (generated) | Notes |
|-----------|----------|----------------------|-------|
| `bool` | `boolean` | `boolean` | Direct mapping |
| `u8, u16, u32` | `u8, u16, u32` | `number` | Safe — JS numbers hold all 32-bit integers |
| `u64, i64` | `u64, i64` | `bigint` | UniFFI uses BigInt to avoid JS precision loss |
| `f32, f64` | `float, double` | `number` | Direct mapping |
| `String` | `string` | `string` | UTF-8 encoded across the boundary |
| `Vec<u8>` | `bytes` | `ArrayBuffer` | **Critical for key material** — see Section 3 |
| `Option<T>` | `T?` | `T \| null` | Nullable wrapper |
| `Vec<T>` | `sequence<T>` | `Array<T>` | Used for pre-key lists, message batches |
| `HashMap<K,V>` | `record<K, V>` | `Record<K, V>` | Rarely needed for our surface |
| `struct` (UniFFI record) | `dictionary` | `interface` (TS) | Used for key pairs, addresses |
| `enum` (flat) | `enum` | `enum` (string union) | CiphertextMessage types, etc. |
| `enum` (with fields) | `[Enum] interface` | Discriminated union | Error variants |
| `Result<T, E>` | `[Throws=E]` | Throws exception | Error types cross as typed exceptions |

**Assessment:** The type system covers everything libsignal needs. The `bytes` mapping for `Vec<u8>` is particularly important since key material, ciphertexts, and serialized protocol buffers are all byte arrays.

---

## 2. Callback Interface Feasibility (Protocol Stores)

This is the most architecturally critical question. libsignal requires the caller to provide 6 store implementations:

```
IdentityKeyStore    — getIdentityKeyPair(), saveIdentity(), isTrustedIdentity()
SessionStore        — loadSession(), storeSession()
PreKeyStore         — loadPreKey(), removePreKey()
SignedPreKeyStore   — loadSignedPreKey()
KyberPreKeyStore    — loadKyberPreKey(), markKyberPreKeyUsed()
SenderKeyStore      — saveSenderKey(), getSenderKey()
```

### How it works with UniFFI

UniFFI supports **callback interfaces** — you define a trait in Rust, and the foreign side (JS/TypeScript) provides the implementation. In UDL:

```webidl
callback interface SessionStore {
    bytes? load_session(string address, u32 device_id);
    void store_session(string address, u32 device_id, bytes record);
};
```

The generated TypeScript asks the consumer to provide an object implementing these methods. When Rust calls `store.load_session(...)`, the call crosses the bridge into JS, hits SQLCipher, and returns the result to Rust.

### The async problem

In libsignal's Rust API, all store operations are `async`. UniFFI's callback interfaces are **synchronous by default**. This creates a design constraint:

**Option A — Synchronous store calls (recommended for our case):**
Our SQLCipher operations are fast local reads/writes (sub-millisecond). We can implement the stores synchronously on the native side (Swift/Kotlin) rather than routing through JS. The Rust wrapper calls into the store, which calls synchronous SQLCipher, and returns. No async needed.

**Option B — Route through JS with blocking:**
The Rust side blocks on a callback into JS. This works but risks deadlocks if called from the JS thread. uniffi-bindgen-react-native handles this by dispatching callbacks on a separate thread, but it adds complexity.

**Option C — Pre-load pattern:**
Load all needed store data into Rust memory before calling encrypt/decrypt. Avoids callbacks entirely but requires knowing what data you need ahead of time (feasible for our ~15 functions).

### Recommendation

Use **Option A** for the initial implementation. The stores are SQLCipher-backed and the native side (Swift/Kotlin) can read/write SQLCipher directly without crossing back into JS. The Rust wrapper exposes `encrypt(message, store)` where `store` is a callback interface implemented in Swift/Kotlin, not TypeScript. TypeScript calls `encrypt(message)` and the native layer handles store access internally.

This is the pattern Nicegram uses.

---

## 3. Byte Array / Buffer Handling

`Vec<u8>` is the most common type in libsignal — identity keys, pre-keys, ciphertexts, serialized protobufs, and encrypted content are all byte arrays.

### How uniffi-bindgen-react-native handles it

| Direction | Rust | Bridge | TypeScript |
|-----------|------|--------|------------|
| Rust to TS | `Vec<u8>` | Copied to native buffer | `ArrayBuffer` |
| TS to Rust | `ArrayBuffer` | Copied to Rust-owned `Vec<u8>` | Passed as `ArrayBuffer` |

**Key characteristics:**
- Data is **copied** across the boundary (no shared memory). This is correct for crypto — we want Rust to own its copy of key material, and JS to own its copy.
- `ArrayBuffer` on the JS side is the standard binary data type. It works with `Uint8Array` views, which is what most JS crypto code expects.
- No base64 encoding/decoding overhead — raw bytes cross the bridge.

**Performance:** A typical Signal Protocol message is <1KB ciphertext. Even a pre-key bundle is ~500 bytes. Copy overhead for these sizes is negligible (microseconds). The only potentially large payload is media encryption, but that should be streamed through native code anyway, not passed as a single buffer.

**Memory safety:** The copy semantics mean Rust cannot accidentally read freed JS memory or vice versa. This is the right tradeoff for key material handling.

---

## 4. Async Support

### uniffi-rs async support

uniffi-rs added `async` function support in v0.25+. You can annotate async Rust functions:

```rust
#[uniffi::export]
async fn signal_encrypt(message: Vec<u8>, address: String) -> Result<Vec<u8>, CryptoError> {
    // ...
}
```

This generates a function that returns a Promise on the TypeScript side.

### uniffi-bindgen-react-native async support

uniffi-bindgen-react-native supports async functions and maps them to Promise-returning TypeScript functions. The async work runs on a Rust tokio runtime, and the result is delivered back to JS via a callback.

### What this means for us

- **Encrypt/decrypt operations** should be async (they may take 1-5ms and should not block the JS thread).
- **Key generation** should be async (especially Kyber key gen, which is CPU-intensive).
- **Store callbacks** within async functions add complexity — see Section 2 above.

### Practical approach

Mark all 15-20 wrapped functions as async in the Rust wrapper. This keeps the JS thread free and matches the natural API shape:

```typescript
// Generated TypeScript
const ciphertext: ArrayBuffer = await signalEncrypt(plaintext, recipientAddress);
const plaintext: ArrayBuffer = await signalDecrypt(ciphertext, senderAddress);
```

---

## 5. Known Limitations and Risks

### 5.1 Hermes Engine Compatibility

uniffi-bindgen-react-native targets JSI (JavaScript Interface), which is Hermes-compatible. No known issues with Hermes. The generated Turbo Modules use the New Architecture's JSI layer, which is exactly what RN 0.82+ expects.

### 5.2 Toolchain Maturity

uniffi-bindgen-react-native is not a Mozilla-maintained project. It is community-maintained (jhugman). The bus factor is a risk. However:
- The generated code is standard Swift/Kotlin/C++ — if the generator breaks, the generated code still works.
- The underlying uniffi-rs is Mozilla-maintained and stable.
- Nicegram uses it in production, providing ongoing validation.

### 5.3 libsignal Version Coupling

libsignal v0.83.0 uses internal UniFFI annotations for its own Swift/Kotlin bindings. Our wrapper crate sits on top and re-exports through our own UniFFI interface. If libsignal changes internal types between versions, our wrapper must adapt. Mitigation: pin to v0.83.0, upgrade deliberately.

### 5.4 Build Complexity

Cross-compilation for 5 targets (3 iOS, 2 Android) with Rust + UniFFI + React Native is a non-trivial build pipeline. Expect 1-2 weeks of build system work to get CI green on all targets.

### 5.5 Debugging Across the Bridge

Stack traces that cross Rust/Swift/JS or Rust/Kotlin/JS boundaries are fragmented. Debugging protocol errors will require logging at each layer. This is inherent to any FFI approach, not specific to uniffi.

### 5.6 Thread Safety

UniFFI-generated code handles thread safety for the bridge layer. However, libsignal's `InMemSignalProtocolStore` is not thread-safe. Our SQLCipher-backed stores must handle concurrent access correctly (SQLCipher's WAL mode helps here).

---

## 6. Fallback Path Assessment

If uniffi-bindgen-react-native proves unworkable, the fallback is manual Turbo Modules.

### What this looks like

**iOS:**
- Download `libsignal-ffi.a` from Signal's releases (the same binary Signal-iOS uses)
- Write a Swift Turbo Module that calls the C FFI functions via the `SignalFfi.h` header
- Manually marshal types between Swift and the C API
- Expose to JS via RN's Turbo Module codegen

**Android:**
- Download `libsignal_jni.so` from Signal's releases (the same binary Signal-Android uses)
- Write a Kotlin Turbo Module that calls the JNI functions
- Use Signal's existing Java/Kotlin bindings as reference
- Expose to JS via RN's Turbo Module codegen

**TypeScript:**
- Manually write the TypeScript interface (codegen spec) for each of the ~15-20 functions
- Handle type conversion (base64 strings for byte arrays, since manual Turbo Modules lack `ArrayBuffer` support without extra work)

### Effort comparison

| Aspect | uniffi approach | Manual Turbo Modules |
|--------|----------------|---------------------|
| Initial setup | 2-3 weeks (toolchain + first binding) | 1 week (simpler toolchain) |
| Per-function cost | ~30 min (add Rust fn + regenerate) | ~2-4 hours (Swift + Kotlin + TS, each manual) |
| 15-20 functions total | ~3-4 weeks | ~5-7 weeks |
| Store callbacks | Supported via callback interfaces | Must implement per-platform manually |
| Type safety | Generated, guaranteed consistent | Manual, risk of platform divergence |
| Maintenance on libsignal upgrade | Regenerate bindings | Update 3 codebases manually |
| Platform consistency | Guaranteed (single source) | Must manually verify Swift/Kotlin/TS stay in sync |

### When to fall back

Trigger the fallback if any of these occur within the first 2 weeks of implementation:
1. uniffi-bindgen-react-native cannot compile with RN 0.82+ New Architecture
2. Callback interfaces fundamentally don't work for our store pattern
3. The toolchain produces broken or unusable TypeScript bindings
4. Build times exceed 30 minutes per target with no clear path to optimization

---

## 7. Recommendation

**Proceed with uniffi-bindgen-react-native as the primary approach.**

Rationale:

1. **Proven precedent.** Nicegram built exactly this — uniffi-bindgen-react-native wrapping libsignal in a React Native app. They shipped it to production. We are not the first to attempt this.

2. **Type safety across 3 languages.** A single Rust source generates consistent Swift, Kotlin, and TypeScript bindings. Manual Turbo Modules require maintaining 3 separate implementations that must stay in sync — a maintenance liability that compounds with every libsignal upgrade.

3. **Callback interfaces solve the store problem.** The 6 SignalProtocolStore interfaces can be implemented as callback interfaces, with the native side (Swift/Kotlin) owning the SQLCipher access. This avoids the complexity of routing store calls through JS.

4. **The surface area is small.** We are wrapping 15-20 functions, not the entire libsignal API. If uniffi has edge-case bugs, we have room to work around them in the thin wrapper layer.

5. **The fallback is available but expensive.** Manual Turbo Modules are straightforward but roughly 2x the implementation effort and significantly more maintenance burden. Keep this as insurance, not the default plan.

### Concrete next steps

1. Add `uniffi-bindgen-react-native` to `package.json` devDependencies
2. Initialize the Rust crate at `rust/orbital_signal/` with `Cargo.toml` depending on `libsignal-protocol` v0.83.0
3. Implement one function end-to-end as PoC: `IdentityKeyPair.generate()` (no store callbacks needed, pure function, returns bytes)
4. Validate the generated TypeScript binding works on both iOS simulator and Android emulator
5. If PoC succeeds, proceed with the full 15-20 function surface
6. If PoC fails within 2 weeks, trigger the fallback path

### Decision gate

The Phase 1 exit gate is a working encrypt/decrypt round-trip through the native bridge on both platforms. Target: end of Week 3.
