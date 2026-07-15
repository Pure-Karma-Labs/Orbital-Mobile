# libsignal API Surface Specification

**Version:** 1.0
**libsignal version:** v0.97.3 (pinned)
**Author:** Signal Crypto Specialist
**Status:** Draft
**Blocks:** Issues #5 (Rust crate), #6 (uniffi-bindgen toolchain), #7-#11 (crypto pipeline)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Type Mapping Table](#2-type-mapping-table)
3. [Key Generation APIs](#3-key-generation-apis)
4. [Session Management APIs](#4-session-management-apis)
5. [Group Messaging APIs (Sender Keys)](#5-group-messaging-apis-sender-keys)
6. [Sealed Sender APIs](#6-sealed-sender-apis)
7. [Store Interfaces](#7-store-interfaces)
8. [Error Handling Strategy](#8-error-handling-strategy)
9. [Buffer and Byte Array Handling](#9-buffer-and-byte-array-handling)
10. [Async/Sync Decision Rationale](#10-asyncsync-decision-rationale)
11. [Security Constraints](#11-security-constraints)
12. [API Summary Matrix](#12-api-summary-matrix)

---

## 1. Overview

### Design Principles

Orbital-Mobile wraps exactly **18 libsignal functions** organized into 4 domains. The Rust wrapper crate (`orbital_signal`) is a thin bridge -- it re-exports libsignal types with UniFFI proc macros, performs no custom cryptography, and exposes the minimum surface area needed.

### Domains

| Domain | Function Count | Purpose |
|--------|---------------|---------|
| Key Generation | 4 | Identity keys, pre-keys, signed pre-keys, Kyber pre-keys |
| Session Management | 4 | X3DH establishment, Double Ratchet encrypt/decrypt |
| Group Messaging | 4 | Sender Key distribution, group encrypt/decrypt |
| Sealed Sender | 2 | Metadata-hiding encryption/decryption |
| **Utility** | **4** | **Address construction, fingerprint, serialization helpers** |
| **Total** | **18** | |

### Architecture

```
TypeScript (React Native)
    |
    | uniffi-bindgen-react-native generated bindings
    v
orbital_signal (thin Rust crate)
    |
    | re-exports with UniFFI proc macros
    v
libsignal-protocol v0.97.3 (Rust)
```

---

## 2. Type Mapping Table

All types that cross the FFI boundary. UniFFI handles the conversion automatically via uniffi-bindgen-react-native.

### Primitive Types

| Rust Type | UDL Type | TypeScript Type | Notes |
|-----------|----------|----------------|-------|
| `u8` | `u8` | `number` | |
| `u32` | `u32` | `number` | Pre-key IDs, device IDs |
| `u64` | `u64` | `number` | Timestamps (may lose precision >2^53) |
| `i32` | `i32` | `number` | |
| `bool` | `boolean` | `boolean` | |
| `String` | `string` | `string` | UUIDs, service IDs |
| `Vec<u8>` | `bytes` | `Uint8Array` | All key material, ciphertext |
| `Option<T>` | `T?` | `T \| null` | |

### libsignal Domain Types (Wrapped)

These libsignal types are opaque across the FFI boundary. The Rust wrapper serializes them to `Vec<u8>` (bytes) for transport, with TypeScript receiving `Uint8Array`.

| libsignal Rust Type | UDL Representation | TypeScript Type | Serialization |
|---------------------|-------------------|----------------|---------------|
| `IdentityKeyPair` | `record IdentityKeyPairData` | `IdentityKeyPairData` | 64 bytes (32 private + 32 public) |
| `IdentityKey` | `bytes` | `Uint8Array` | 33 bytes (compressed Curve25519 point) |
| `PreKeyRecord` | `bytes` | `Uint8Array` | Protobuf-serialized |
| `SignedPreKeyRecord` | `bytes` | `Uint8Array` | Protobuf-serialized |
| `KyberPreKeyRecord` | `bytes` | `Uint8Array` | Protobuf-serialized |
| `SessionRecord` | `bytes` | `Uint8Array` | Protobuf-serialized |
| `SenderKeyRecord` | `bytes` | `Uint8Array` | Protobuf-serialized |
| `PreKeyBundle` | `record PreKeyBundleData` | `PreKeyBundleData` | Decomposed into fields |
| `ProtocolAddress` | `record ProtocolAddressData` | `ProtocolAddressData` | name (string) + device_id (u32) |
| `CiphertextMessage` | `record CiphertextMessageData` | `CiphertextMessageData` | type (enum) + serialized bytes |
| `SenderKeyDistributionMessage` | `bytes` | `Uint8Array` | Serialized SKDM |
| `UnidentifiedSenderMessageContent` | `record UsmcData` | `UsmcData` | Decomposed fields |
| `SealedSenderDecryptionResult` | `record SealedSenderResult` | `SealedSenderResult` | Decomposed fields |

### Custom Records (UDL)

```udl
[Custom]
typedef string Uuid;

dictionary ProtocolAddressData {
    string name;       // serviceId UUID
    u32 device_id;     // typically 1 for single-device
};

dictionary IdentityKeyPairData {
    bytes public_key;   // 33 bytes, compressed Curve25519
    bytes private_key;  // 32 bytes, Curve25519 scalar
};

dictionary PreKeyBundleData {
    u32 registration_id;
    u32 device_id;
    u32? pre_key_id;
    bytes? pre_key_public;        // 33 bytes
    u32 signed_pre_key_id;
    bytes signed_pre_key_public;  // 33 bytes
    bytes signed_pre_key_signature; // 64 bytes
    bytes identity_key;           // 33 bytes
    u32? kyber_pre_key_id;
    bytes? kyber_pre_key_public;
    bytes? kyber_pre_key_signature;
};

enum CiphertextMessageType {
    "Whisper",       // normal Double Ratchet message
    "PreKey",        // initial pre-key message (X3DH)
    "SenderKey",     // group message
    "Plaintext",     // plaintext content (rare)
};

dictionary CiphertextMessageData {
    CiphertextMessageType message_type;
    bytes serialized;  // serialized ciphertext
};

dictionary UsmcData {
    CiphertextMessageType message_type;
    bytes sender_certificate;
    bytes content;
    u32 content_hint;
    bytes? group_id;
};

dictionary SealedSenderResult {
    string sender_service_id;   // UUID
    u32 sender_device_id;
    bytes message;              // decrypted plaintext
    u32 content_hint;
};

enum Direction {
    "Sending",
    "Receiving",
};

enum VerifiedStatus {
    "Default",
    "Verified",
    "Unverified",
};
```

---

## 3. Key Generation APIs

### 3.1 `generate_identity_key_pair`

Generates a new long-term Curve25519 identity key pair. Called once during registration.

**Domain:** Key Generation
**Async:** No (fast Curve25519 scalar multiplication)

**Rust wrapper signature:**
```rust
#[uniffi::export]
fn generate_identity_key_pair() -> IdentityKeyPairData;
```

**Underlying libsignal call:**
```rust
// libsignal-protocol/src/identity_key.rs
impl IdentityKeyPair {
    pub fn generate<R: CryptoRng + Rng>(csprng: &mut R) -> Self
}
```

**Inputs:** None (uses system CSPRNG internally)

**Output:**
| Field | Type | Description |
|-------|------|-------------|
| `public_key` | `bytes` (33 bytes) | Compressed Curve25519 public key |
| `private_key` | `bytes` (32 bytes) | Curve25519 private scalar |

**Errors:** None (infallible with valid CSPRNG)

**UDL:**
```udl
namespace orbital_signal {
    IdentityKeyPairData generate_identity_key_pair();
};
```

**TypeScript usage:**
```typescript
const keyPair: IdentityKeyPairData = OrbitalSignal.generateIdentityKeyPair();
// Store keyPair.publicKey + keyPair.privateKey as BLOB in signal_identity_keys (address='local')
```

**FFI boundary notes:**
- The wrapper calls `IdentityKeyPair::generate(&mut OsRng)` and decomposes into public/private bytes
- Private key bytes must never be logged or exposed beyond the crypto service layer

---

### 3.2 `generate_pre_key`

Generates a one-time Curve25519 pre-key for X3DH. Generates in batches of 100, uploaded to server.

**Domain:** Key Generation
**Async:** No (single Curve25519 operation)

**Rust wrapper signature:**
```rust
#[uniffi::export]
fn generate_pre_key(id: u32) -> Vec<u8>;
```

**Underlying libsignal call:**
```rust
// libsignal-protocol/src/state/pre_key.rs
impl PreKeyRecord {
    pub fn new(id: PreKeyId, key_pair: &KeyPair) -> Self
}
```

**Inputs:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | `u32` | Pre-key ID (monotonically increasing, wraps at 2^24) |

**Output:** `bytes` -- Protobuf-serialized `PreKeyRecord` containing the key pair

**Errors:** None (infallible)

**UDL:**
```udl
namespace orbital_signal {
    bytes generate_pre_key(u32 id);
};
```

**TypeScript usage:**
```typescript
const preKeyRecord: Uint8Array = OrbitalSignal.generatePreKey(nextPreKeyId);
// Store in signal_pre_keys table: { id: nextPreKeyId, key_data: preKeyRecord }
```

**FFI boundary notes:**
- Internally generates a fresh `KeyPair`, creates `PreKeyRecord`, and returns `record.serialize()`
- The public key must be extracted separately for upload to server (see `get_pre_key_public`)

---

### 3.3 `generate_signed_pre_key`

Generates a signed pre-key: a Curve25519 key pair with an Ed25519 signature from the identity key. Rotated every 30 days.

**Domain:** Key Generation
**Async:** No (Curve25519 + Ed25519 signature)

**Rust wrapper signature:**
```rust
#[uniffi::export]
fn generate_signed_pre_key(
    id: u32,
    identity_key_pair: IdentityKeyPairData,
    timestamp: u64,
) -> Vec<u8>;
```

**Underlying libsignal call:**
```rust
// libsignal-protocol/src/state/signed_pre_key.rs
impl SignedPreKeyRecord {
    pub fn new(
        id: SignedPreKeyId,
        timestamp: Timestamp,
        key_pair: &KeyPair,
        signature: &[u8],
    ) -> Self
}
```

**Inputs:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | `u32` | Signed pre-key ID (monotonically increasing) |
| `identity_key_pair` | `IdentityKeyPairData` | Identity key pair for signing |
| `timestamp` | `u64` | Creation time (Unix epoch seconds) |

**Output:** `bytes` -- Protobuf-serialized `SignedPreKeyRecord`

**Errors:**
| Error | Condition |
|-------|-----------|
| `SignalError::InvalidKey` | Identity key pair bytes are malformed |

**UDL:**
```udl
namespace orbital_signal {
    [Throws=SignalError]
    bytes generate_signed_pre_key(
        u32 id,
        IdentityKeyPairData identity_key_pair,
        u64 timestamp
    );
};
```

**FFI boundary notes:**
- Wrapper reconstructs `IdentityKeyPair` from bytes, generates a new `KeyPair`, signs the public key, and creates the record
- Signature is 64 bytes Ed25519 over the serialized public key

---

### 3.4 `generate_kyber_pre_key`

Generates a post-quantum (ML-KEM/Kyber1024) pre-key, signed by the identity key. Provides quantum resistance for forward secrecy.

**Domain:** Key Generation
**Async:** Yes (Kyber key generation is ~10x slower than Curve25519)

**Rust wrapper signature:**
```rust
#[uniffi::export]
async fn generate_kyber_pre_key(
    id: u32,
    identity_key_pair: IdentityKeyPairData,
    timestamp: u64,
    is_last_resort: bool,
) -> Result<Vec<u8>, SignalError>;
```

**Underlying libsignal call:**
```rust
// libsignal-protocol/src/state/kyber_pre_key.rs
impl KyberPreKeyRecord {
    pub fn new(
        id: KyberPreKeyId,
        timestamp: Timestamp,
        key_pair: &kem::KeyPair,
        signature: &[u8],
    ) -> Self
}
```

**Inputs:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | `u32` | Kyber pre-key ID |
| `identity_key_pair` | `IdentityKeyPairData` | Identity key for signing the Kyber public key |
| `timestamp` | `u64` | Creation time (Unix epoch seconds) |
| `is_last_resort` | `bool` | If true, this key is not deleted after use |

**Output:** `bytes` -- Serialized `KyberPreKeyRecord`

**Errors:**
| Error | Condition |
|-------|-----------|
| `SignalError::InvalidKey` | Identity key pair bytes are malformed |
| `SignalError::InternalError` | Kyber key generation failure |

**UDL:**
```udl
namespace orbital_signal {
    [Throws=SignalError]
    bytes generate_kyber_pre_key(
        u32 id,
        IdentityKeyPairData identity_key_pair,
        u64 timestamp,
        boolean is_last_resort
    );
};
```

**FFI boundary notes:**
- Must run on background thread (Kyber1024 key generation takes ~5ms vs ~0.1ms for Curve25519)
- `is_last_resort` flag is stored alongside the key; last-resort keys survive use and are only replaced during rotation
- The Kyber public key + signature are included in the pre-key bundle uploaded to the server

---

## 4. Session Management APIs

### 4.1 `process_pre_key_bundle`

Performs the X3DH key agreement to establish an outgoing session with a new recipient. Uses the recipient's pre-key bundle (fetched from server).

**Domain:** Session Management
**Async:** Yes (involves store I/O for session and identity persistence)

**Rust wrapper signature:**
```rust
#[uniffi::export]
async fn process_pre_key_bundle(
    bundle: PreKeyBundleData,
    remote_address: ProtocolAddressData,
    session_store: Arc<dyn OrbitalSessionStore>,
    identity_store: Arc<dyn OrbitalIdentityKeyStore>,
) -> Result<(), SignalError>;
```

**Underlying libsignal call:**
```rust
// libsignal-protocol/src/session.rs
pub async fn process_prekey_bundle<R: Rng + CryptoRng>(
    remote_address: &ProtocolAddress,
    session_store: &mut dyn SessionStore,
    identity_store: &mut dyn IdentityKeyStore,
    bundle: &PreKeyBundle,
    csprng: &mut R,
    now: Timestamp,
) -> Result<(), SignalProtocolError>
```

**Inputs:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `bundle` | `PreKeyBundleData` | Recipient's pre-key bundle from server |
| `remote_address` | `ProtocolAddressData` | Recipient's address (serviceId + deviceId) |
| `session_store` | callback interface | Session persistence (see Section 7) |
| `identity_store` | callback interface | Identity key persistence (see Section 7) |

**Output:** `()` -- Session state is stored via `session_store.store_session()`

**Errors:**
| Error | Condition |
|-------|-----------|
| `SignalError::InvalidKey` | Bundle contains invalid public keys |
| `SignalError::UntrustedIdentity` | Remote identity key is not trusted |
| `SignalError::InvalidSignature` | Signed pre-key signature verification fails |
| `SignalError::StoreError` | Session/identity store I/O failure |

**UDL:**
```udl
namespace orbital_signal {
    [Throws=SignalError]
    void process_pre_key_bundle(
        PreKeyBundleData bundle,
        ProtocolAddressData remote_address,
        OrbitalSessionStore session_store,
        OrbitalIdentityKeyStore identity_store
    );
};
```

**TypeScript usage:**
```typescript
await OrbitalSignal.processPreKeyBundle(
    recipientBundle,    // fetched from GET /api/users/:username/public-key
    { name: recipientServiceId, deviceId: 1 },
    sessionStore,       // implements OrbitalSessionStore
    identityStore       // implements OrbitalIdentityKeyStore
);
// Session is now established; can call signalEncrypt()
```

**FFI boundary notes:**
- This is the first message flow: caller fetches the recipient's pre-key bundle from the server, then calls this to establish the session
- The identity store's `save_identity()` is called to persist the remote identity key
- If `is_trusted_identity()` returns false, `UntrustedIdentity` error is raised
- After this call, the session store contains a new session record for the remote address

---

### 4.2 `signal_encrypt`

Encrypts a plaintext message for a 1:1 session using the Double Ratchet Algorithm.

**Domain:** Session Management
**Async:** Yes (requires loading session state from store)

**Rust wrapper signature:**
```rust
#[uniffi::export]
async fn signal_encrypt(
    plaintext: Vec<u8>,
    remote_address: ProtocolAddressData,
    session_store: Arc<dyn OrbitalSessionStore>,
    identity_store: Arc<dyn OrbitalIdentityKeyStore>,
) -> Result<CiphertextMessageData, SignalError>;
```

**Underlying libsignal call:**
```rust
// libsignal-protocol/src/session_cipher.rs
pub async fn message_encrypt(
    ptext: &[u8],
    remote_address: &ProtocolAddress,
    session_store: &mut dyn SessionStore,
    identity_store: &mut dyn IdentityKeyStore,
    now: Timestamp,
) -> Result<CiphertextMessage, SignalProtocolError>
```

**Inputs:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `plaintext` | `bytes` | Raw plaintext to encrypt (protobuf-serialized content) |
| `remote_address` | `ProtocolAddressData` | Recipient's protocol address |
| `session_store` | callback interface | Session store for loading/updating ratchet state |
| `identity_store` | callback interface | Identity store for sender's identity key |

**Output:**
| Field | Type | Description |
|-------|------|-------------|
| `message_type` | `CiphertextMessageType` | `Whisper` (normal) or `PreKey` (first message) |
| `serialized` | `bytes` | Serialized ciphertext envelope |

**Errors:**
| Error | Condition |
|-------|-----------|
| `SignalError::NoSession` | No session exists for the remote address |
| `SignalError::UntrustedIdentity` | Identity key mismatch |
| `SignalError::StoreError` | Store I/O failure |

**UDL:**
```udl
namespace orbital_signal {
    [Throws=SignalError]
    CiphertextMessageData signal_encrypt(
        bytes plaintext,
        ProtocolAddressData remote_address,
        OrbitalSessionStore session_store,
        OrbitalIdentityKeyStore identity_store
    );
};
```

**FFI boundary notes:**
- The returned `message_type` determines how the envelope is constructed for transmission
- Session state is updated in the store after encryption (ratchet advances)
- For pre-key messages (first message in session), the output includes additional key material that the recipient needs to establish their side of the session

---

### 4.3 `signal_decrypt`

Decrypts a normal (non-pre-key) message from an established session.

**Domain:** Session Management
**Async:** Yes (requires loading session state from store)

**Rust wrapper signature:**
```rust
#[uniffi::export]
async fn signal_decrypt(
    ciphertext: Vec<u8>,
    remote_address: ProtocolAddressData,
    session_store: Arc<dyn OrbitalSessionStore>,
    identity_store: Arc<dyn OrbitalIdentityKeyStore>,
) -> Result<Vec<u8>, SignalError>;
```

**Underlying libsignal call:**
```rust
// libsignal-protocol/src/session_cipher.rs
pub async fn message_decrypt(
    ciphertext: &SignalMessage,
    remote_address: &ProtocolAddress,
    session_store: &mut dyn SessionStore,
    identity_store: &mut dyn IdentityKeyStore,
    csprng: &mut R,
) -> Result<Vec<u8>, SignalProtocolError>
```

**Inputs:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `ciphertext` | `bytes` | Serialized `SignalMessage` (from `CiphertextMessageData.serialized`) |
| `remote_address` | `ProtocolAddressData` | Sender's protocol address |
| `session_store` | callback interface | Session store |
| `identity_store` | callback interface | Identity store |

**Output:** `bytes` -- Decrypted plaintext

**Errors:**
| Error | Condition |
|-------|-----------|
| `SignalError::InvalidMessage` | Ciphertext is malformed or MAC verification fails |
| `SignalError::DuplicateMessage` | Message counter already seen (replay detection) |
| `SignalError::NoSession` | No session exists for the sender |
| `SignalError::UntrustedIdentity` | Identity key mismatch |
| `SignalError::StoreError` | Store I/O failure |

**UDL:**
```udl
namespace orbital_signal {
    [Throws=SignalError]
    bytes signal_decrypt(
        bytes ciphertext,
        ProtocolAddressData remote_address,
        OrbitalSessionStore session_store,
        OrbitalIdentityKeyStore identity_store
    );
};
```

**FFI boundary notes:**
- Caller must determine message type first -- use `signal_decrypt` only for `CiphertextMessageType::Whisper` messages
- Session state is updated after decryption (receiver ratchet advances)
- `DuplicateMessage` is not necessarily an error in Orbital's context (network retries); the caller should handle gracefully

---

### 4.4 `signal_decrypt_pre_key`

Decrypts a pre-key message (the first message in a new session), establishing the receiver's side of the session.

**Domain:** Session Management
**Async:** Yes (requires multiple store operations: session, identity, pre-key, signed pre-key, kyber pre-key)

**Rust wrapper signature:**
```rust
#[uniffi::export]
async fn signal_decrypt_pre_key(
    ciphertext: Vec<u8>,
    remote_address: ProtocolAddressData,
    session_store: Arc<dyn OrbitalSessionStore>,
    identity_store: Arc<dyn OrbitalIdentityKeyStore>,
    pre_key_store: Arc<dyn OrbitalPreKeyStore>,
    signed_pre_key_store: Arc<dyn OrbitalSignedPreKeyStore>,
    kyber_pre_key_store: Arc<dyn OrbitalKyberPreKeyStore>,
) -> Result<Vec<u8>, SignalError>;
```

**Underlying libsignal call:**
```rust
// libsignal-protocol/src/session_cipher.rs
pub async fn message_decrypt_prekey(
    ciphertext: &PreKeySignalMessage,
    remote_address: &ProtocolAddress,
    session_store: &mut dyn SessionStore,
    identity_store: &mut dyn IdentityKeyStore,
    pre_key_store: &mut dyn PreKeyStore,
    signed_pre_key_store: &mut dyn SignedPreKeyStore,
    kyber_pre_key_store: &mut dyn KyberPreKeyStore,
    csprng: &mut R,
) -> Result<Vec<u8>, SignalProtocolError>
```

**Inputs:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `ciphertext` | `bytes` | Serialized `PreKeySignalMessage` |
| `remote_address` | `ProtocolAddressData` | Sender's protocol address |
| `session_store` | callback interface | Session store |
| `identity_store` | callback interface | Identity store |
| `pre_key_store` | callback interface | One-time pre-key store |
| `signed_pre_key_store` | callback interface | Signed pre-key store |
| `kyber_pre_key_store` | callback interface | Kyber pre-key store |

**Output:** `bytes` -- Decrypted plaintext

**Errors:**
| Error | Condition |
|-------|-----------|
| `SignalError::InvalidMessage` | Pre-key message malformed |
| `SignalError::InvalidKey` | Pre-key referenced in message not found or invalid |
| `SignalError::UntrustedIdentity` | Identity key not trusted |
| `SignalError::DuplicateMessage` | Replay detected |
| `SignalError::StoreError` | Store I/O failure |

**UDL:**
```udl
namespace orbital_signal {
    [Throws=SignalError]
    bytes signal_decrypt_pre_key(
        bytes ciphertext,
        ProtocolAddressData remote_address,
        OrbitalSessionStore session_store,
        OrbitalIdentityKeyStore identity_store,
        OrbitalPreKeyStore pre_key_store,
        OrbitalSignedPreKeyStore signed_pre_key_store,
        OrbitalKyberPreKeyStore kyber_pre_key_store
    );
};
```

**FFI boundary notes:**
- This is the heaviest API call: it touches 5 stores and performs X3DH + Double Ratchet initialization
- The one-time pre-key used is removed from `pre_key_store` after successful decryption (via `remove_pre_key`)
- After this call, a session is established and subsequent messages use `signal_decrypt`
- **Pre-key exhaustion:** After decryption, check remaining pre-key count; if below threshold (e.g., <20), generate and upload a new batch
- Kyber pre-keys flagged as `is_last_resort` are NOT removed after use; they are marked used via `mark_kyber_pre_key_used`

---

## 5. Group Messaging APIs (Sender Keys)

### 5.1 `create_sender_key_distribution_message`

Creates a Sender Key Distribution Message (SKDM) for a group. The SKDM contains the sender's group key material and must be distributed to all group members via 1:1 sessions before group messages can be decrypted.

**Domain:** Group Messaging
**Async:** Yes (requires store I/O)

**Rust wrapper signature:**
```rust
#[uniffi::export]
async fn create_sender_key_distribution_message(
    sender: ProtocolAddressData,
    distribution_id: String,
    sender_key_store: Arc<dyn OrbitalSenderKeyStore>,
) -> Result<Vec<u8>, SignalError>;
```

**Underlying libsignal call:**
```rust
// libsignal-protocol/src/sender_keys.rs
pub async fn create_sender_key_distribution_message(
    sender: &ProtocolAddress,
    distribution_id: Uuid,
    store: &mut dyn SenderKeyStore,
    csprng: &mut R,
) -> Result<SenderKeyDistributionMessage, SignalProtocolError>
```

**Inputs:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `sender` | `ProtocolAddressData` | Our own protocol address |
| `distribution_id` | `string` | UUID identifying the group/distribution (matches `signal_sender_keys.distribution_id`) |
| `sender_key_store` | callback interface | Sender key persistence |

**Output:** `bytes` -- Serialized `SenderKeyDistributionMessage` (to send to group members via 1:1 sessions)

**Errors:**
| Error | Condition |
|-------|-----------|
| `SignalError::StoreError` | Sender key store I/O failure |
| `SignalError::InvalidArgument` | Invalid distribution_id format |

**UDL:**
```udl
namespace orbital_signal {
    [Throws=SignalError]
    bytes create_sender_key_distribution_message(
        ProtocolAddressData sender,
        string distribution_id,
        OrbitalSenderKeyStore sender_key_store
    );
};
```

**FFI boundary notes:**
- The returned SKDM must be encrypted with `signal_encrypt` and sent to each group member individually
- This creates or updates the sender key state in the store
- The `distribution_id` is a UUID that uniquely identifies the group sender key context -- it maps to `signal_sender_keys.distribution_id`

---

### 5.2 `process_sender_key_distribution_message`

Processes a received SKDM from a group member, storing their sender key material for future group message decryption.

**Domain:** Group Messaging
**Async:** Yes (requires store I/O)

**Rust wrapper signature:**
```rust
#[uniffi::export]
async fn process_sender_key_distribution_message(
    sender: ProtocolAddressData,
    distribution_message: Vec<u8>,
    sender_key_store: Arc<dyn OrbitalSenderKeyStore>,
) -> Result<(), SignalError>;
```

**Underlying libsignal call:**
```rust
// libsignal-protocol/src/sender_keys.rs
pub async fn process_sender_key_distribution_message(
    sender: &ProtocolAddress,
    skdm: &SenderKeyDistributionMessage,
    store: &mut dyn SenderKeyStore,
) -> Result<(), SignalProtocolError>
```

**Inputs:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `sender` | `ProtocolAddressData` | Sender's protocol address (who sent the SKDM) |
| `distribution_message` | `bytes` | Serialized `SenderKeyDistributionMessage` |
| `sender_key_store` | callback interface | Sender key persistence |

**Output:** `()` -- Sender key state stored

**Errors:**
| Error | Condition |
|-------|-----------|
| `SignalError::InvalidMessage` | SKDM deserialization failure |
| `SignalError::StoreError` | Sender key store I/O failure |

**UDL:**
```udl
namespace orbital_signal {
    [Throws=SignalError]
    void process_sender_key_distribution_message(
        ProtocolAddressData sender,
        bytes distribution_message,
        OrbitalSenderKeyStore sender_key_store
    );
};
```

**FFI boundary notes:**
- Called when receiving a SKDM from another group member (arrives via 1:1 session, decrypted with `signal_decrypt` or `signal_decrypt_pre_key`)
- After processing, the caller can decrypt group messages from this sender

---

### 5.3 `group_encrypt`

Encrypts a message for a group using the Sender Key protocol. All group members who have processed our SKDM can decrypt.

**Domain:** Group Messaging
**Async:** Yes (requires store I/O)

**Rust wrapper signature:**
```rust
#[uniffi::export]
async fn group_encrypt(
    plaintext: Vec<u8>,
    sender: ProtocolAddressData,
    distribution_id: String,
    sender_key_store: Arc<dyn OrbitalSenderKeyStore>,
) -> Result<Vec<u8>, SignalError>;
```

**Underlying libsignal call:**
```rust
// libsignal-protocol/src/sender_keys.rs
pub async fn group_encrypt<R: Rng + CryptoRng>(
    sender: &ProtocolAddress,
    distribution_id: Uuid,
    plaintext: &[u8],
    store: &mut dyn SenderKeyStore,
    csprng: &mut R,
) -> Result<CiphertextMessage, SignalProtocolError>
```

**Inputs:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `plaintext` | `bytes` | Plaintext message content |
| `sender` | `ProtocolAddressData` | Our own protocol address |
| `distribution_id` | `string` | Group distribution UUID |
| `sender_key_store` | callback interface | Sender key persistence |

**Output:** `bytes` -- Serialized `SenderKeyMessage` (ciphertext)

**Errors:**
| Error | Condition |
|-------|-----------|
| `SignalError::NoSession` | No sender key state for this distribution_id (call `create_sender_key_distribution_message` first) |
| `SignalError::StoreError` | Store I/O failure |

**UDL:**
```udl
namespace orbital_signal {
    [Throws=SignalError]
    bytes group_encrypt(
        bytes plaintext,
        ProtocolAddressData sender,
        string distribution_id,
        OrbitalSenderKeyStore sender_key_store
    );
};
```

**FFI boundary notes:**
- The sender key ratchet advances after each encryption
- The ciphertext is sent to the server as-is; the server fans it out to group members
- If a group member has not received the SKDM, they will not be able to decrypt -- the sender must re-distribute the SKDM

---

### 5.4 `group_decrypt`

Decrypts a group message using the stored sender key for the message's sender.

**Domain:** Group Messaging
**Async:** Yes (requires store I/O)

**Rust wrapper signature:**
```rust
#[uniffi::export]
async fn group_decrypt(
    ciphertext: Vec<u8>,
    sender: ProtocolAddressData,
    sender_key_store: Arc<dyn OrbitalSenderKeyStore>,
) -> Result<Vec<u8>, SignalError>;
```

**Underlying libsignal call:**
```rust
// libsignal-protocol/src/sender_keys.rs
pub async fn group_decrypt(
    skm_bytes: &[u8],
    store: &mut dyn SenderKeyStore,
    sender: &ProtocolAddress,
) -> Result<Vec<u8>, SignalProtocolError>
```

**Inputs:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `ciphertext` | `bytes` | Serialized `SenderKeyMessage` |
| `sender` | `ProtocolAddressData` | Sender's protocol address |
| `sender_key_store` | callback interface | Sender key persistence |

**Output:** `bytes` -- Decrypted plaintext

**Errors:**
| Error | Condition |
|-------|-----------|
| `SignalError::InvalidMessage` | Ciphertext malformed or MAC verification fails |
| `SignalError::DuplicateMessage` | Message counter already seen |
| `SignalError::NoSession` | No sender key stored for this sender/distribution |
| `SignalError::StoreError` | Store I/O failure |

**UDL:**
```udl
namespace orbital_signal {
    [Throws=SignalError]
    bytes group_decrypt(
        bytes ciphertext,
        ProtocolAddressData sender,
        OrbitalSenderKeyStore sender_key_store
    );
};
```

**FFI boundary notes:**
- The distribution_id is embedded in the `SenderKeyMessage` ciphertext, so it does not need to be passed separately
- Handles message ordering: sender key protocol supports out-of-order delivery within a window

---

## 6. Sealed Sender APIs

Sealed Sender hides the sender's identity from the server. The server sees only the recipient; the sender is revealed only after decryption on the recipient's device.

### 6.1 `sealed_sender_encrypt`

Encrypts a message with Sealed Sender, hiding the sender's identity metadata.

**Domain:** Sealed Sender
**Async:** Yes (requires session store + identity store I/O)

**Rust wrapper signature:**
```rust
#[uniffi::export]
async fn sealed_sender_encrypt(
    plaintext: Vec<u8>,
    remote_address: ProtocolAddressData,
    sender_certificate: Vec<u8>,
    session_store: Arc<dyn OrbitalSessionStore>,
    identity_store: Arc<dyn OrbitalIdentityKeyStore>,
) -> Result<Vec<u8>, SignalError>;
```

**Underlying libsignal call:**
```rust
// libsignal-protocol/src/sealed_sender.rs
pub async fn sealed_sender_encrypt(
    destination: &ProtocolAddress,
    sender_cert: &SenderCertificate,
    ptext: &[u8],
    session_store: &mut dyn SessionStore,
    identity_store: &mut dyn IdentityKeyStore,
    now: Timestamp,
    csprng: &mut R,
) -> Result<Vec<u8>, SignalProtocolError>
```

**Inputs:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `plaintext` | `bytes` | Message content to encrypt |
| `remote_address` | `ProtocolAddressData` | Recipient's protocol address |
| `sender_certificate` | `bytes` | Serialized `SenderCertificate` (issued by server, proves sender identity) |
| `session_store` | callback interface | Session store |
| `identity_store` | callback interface | Identity store |

**Output:** `bytes` -- Sealed sender ciphertext (opaque blob, no sender metadata visible)

**Errors:**
| Error | Condition |
|-------|-----------|
| `SignalError::NoSession` | No session with recipient |
| `SignalError::UntrustedIdentity` | Identity key mismatch |
| `SignalError::InvalidCertificate` | Sender certificate invalid or expired |
| `SignalError::StoreError` | Store I/O failure |

**UDL:**
```udl
namespace orbital_signal {
    [Throws=SignalError]
    bytes sealed_sender_encrypt(
        bytes plaintext,
        ProtocolAddressData remote_address,
        bytes sender_certificate,
        OrbitalSessionStore session_store,
        OrbitalIdentityKeyStore identity_store
    );
};
```

**FFI boundary notes:**
- The sender certificate is obtained from the server during authentication and has an expiration
- Sealed sender ciphertext is ~57 bytes larger than normal encrypted messages due to the additional envelope
- The session ratchet advances just as with `signal_encrypt`

---

### 6.2 `sealed_sender_decrypt`

Decrypts a Sealed Sender message, revealing the sender's identity and the plaintext.

**Domain:** Sealed Sender
**Async:** Yes (requires multiple store operations)

**Rust wrapper signature:**
```rust
#[uniffi::export]
async fn sealed_sender_decrypt(
    ciphertext: Vec<u8>,
    trust_root: Vec<u8>,
    local_address: ProtocolAddressData,
    local_registration_id: u32,
    session_store: Arc<dyn OrbitalSessionStore>,
    identity_store: Arc<dyn OrbitalIdentityKeyStore>,
    pre_key_store: Arc<dyn OrbitalPreKeyStore>,
    signed_pre_key_store: Arc<dyn OrbitalSignedPreKeyStore>,
    kyber_pre_key_store: Arc<dyn OrbitalKyberPreKeyStore>,
) -> Result<SealedSenderResult, SignalError>;
```

**Underlying libsignal call:**
```rust
// libsignal-protocol/src/sealed_sender.rs
pub async fn sealed_sender_decrypt(
    ciphertext: &[u8],
    trust_root: &PublicKey,
    timestamp: Timestamp,
    local_e164: Option<String>,
    local_uuid: String,
    local_device_id: DeviceId,
    identity_store: &mut dyn IdentityKeyStore,
    session_store: &mut dyn SessionStore,
    pre_key_store: &mut dyn PreKeyStore,
    signed_pre_key_store: &mut dyn SignedPreKeyStore,
    kyber_pre_key_store: &mut dyn KyberPreKeyStore,
) -> Result<SealedSenderDecryptionResult, SignalProtocolError>
```

**Inputs:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `ciphertext` | `bytes` | Sealed sender ciphertext blob |
| `trust_root` | `bytes` | Server's trust root public key (33 bytes, for certificate validation) |
| `local_address` | `ProtocolAddressData` | Our own protocol address |
| `local_registration_id` | `u32` | Our registration ID |
| `session_store` | callback interface | Session store |
| `identity_store` | callback interface | Identity store |
| `pre_key_store` | callback interface | Pre-key store |
| `signed_pre_key_store` | callback interface | Signed pre-key store |
| `kyber_pre_key_store` | callback interface | Kyber pre-key store |

**Output:**
| Field | Type | Description |
|-------|------|-------------|
| `sender_service_id` | `string` | Sender's UUID (revealed after decryption) |
| `sender_device_id` | `u32` | Sender's device ID |
| `message` | `bytes` | Decrypted plaintext |
| `content_hint` | `u32` | Hint about content type (0=default, 1=resendable, 2=implicit) |

**Errors:**
| Error | Condition |
|-------|-----------|
| `SignalError::InvalidMessage` | Ciphertext malformed |
| `SignalError::InvalidCertificate` | Sender certificate fails trust root validation |
| `SignalError::InvalidKey` | Key material invalid |
| `SignalError::UntrustedIdentity` | Sender identity not trusted |
| `SignalError::StoreError` | Store I/O failure |

**UDL:**
```udl
namespace orbital_signal {
    [Throws=SignalError]
    SealedSenderResult sealed_sender_decrypt(
        bytes ciphertext,
        bytes trust_root,
        ProtocolAddressData local_address,
        u32 local_registration_id,
        OrbitalSessionStore session_store,
        OrbitalIdentityKeyStore identity_store,
        OrbitalPreKeyStore pre_key_store,
        OrbitalSignedPreKeyStore signed_pre_key_store,
        OrbitalKyberPreKeyStore kyber_pre_key_store
    );
};
```

**FFI boundary notes:**
- This is the most complex API call: it combines sealed sender decryption with either session decryption or pre-key decryption internally
- The `trust_root` is the server's signing key used to validate sender certificates -- it is a compile-time constant in the app, not fetched at runtime
- Pre-key consumption and session establishment happen internally (same as `signal_decrypt_pre_key`)

---

## 7. Store Interfaces

The Signal Protocol requires 6 persistent stores. These are implemented as UniFFI callback interfaces: TypeScript provides the implementation (backed by SQLCipher), and Rust calls back into TypeScript during protocol operations.

### Architecture

```
libsignal (Rust)
    |
    | calls trait methods
    v
orbital_signal wrapper (Rust)
    |
    | UniFFI callback interface
    v
TypeScript store implementation
    |
    | SQLCipher queries
    v
SQLite/SQLCipher database
```

### 7.1 `OrbitalIdentityKeyStore`

Stores our own identity key pair and remote contacts' identity keys. Used for identity verification and trust decisions.

**UDL:**
```udl
callback interface OrbitalIdentityKeyStore {
    [Throws=SignalError]
    IdentityKeyPairData get_identity_key_pair();

    [Throws=SignalError]
    u32 get_local_registration_id();

    [Throws=SignalError]
    boolean save_identity(
        ProtocolAddressData address,
        bytes identity_key
    );

    [Throws=SignalError]
    boolean is_trusted_identity(
        ProtocolAddressData address,
        bytes identity_key,
        Direction direction
    );

    [Throws=SignalError]
    bytes? get_identity(ProtocolAddressData address);
};
```

**Method details:**

| Method | Description | SQL Table | Returns |
|--------|-------------|-----------|---------|
| `get_identity_key_pair()` | Load our identity key pair | `signal_identity_keys WHERE address='local'` | `IdentityKeyPairData` |
| `get_local_registration_id()` | Load our registration ID | `items WHERE id='registrationId'` | `u32` |
| `save_identity(address, key)` | Store/update a remote identity key | `INSERT OR REPLACE INTO signal_identity_keys` | `bool` (true if key changed) |
| `is_trusted_identity(address, key, direction)` | Check if identity key is trusted | `SELECT FROM signal_identity_keys` | `bool` |
| `get_identity(address)` | Load a remote identity key | `SELECT identity_key FROM signal_identity_keys` | `bytes?` (null if unknown) |

**Trust decision logic for `is_trusted_identity`:**
- If no previous key stored: trust on first use (return `true`)
- If key matches stored key: return `true`
- If key differs and direction is `Sending`: return `false` (safety number change)
- If key differs and direction is `Receiving`: return `true` if `nonblocking_approval=1`, else `false`

---

### 7.2 `OrbitalSessionStore`

Stores Double Ratchet session state for each remote address.

**UDL:**
```udl
callback interface OrbitalSessionStore {
    [Throws=SignalError]
    bytes? load_session(ProtocolAddressData address);

    [Throws=SignalError]
    void store_session(
        ProtocolAddressData address,
        bytes record
    );
};
```

**Method details:**

| Method | Description | SQL Table |
|--------|-------------|-----------|
| `load_session(address)` | Load session record for remote address | `SELECT record FROM signal_sessions WHERE our_service_id=? AND service_id=? AND device_id=?` |
| `store_session(address, record)` | Store/update session record | `INSERT OR REPLACE INTO signal_sessions` |

**Notes:**
- Session records are protobuf-serialized blobs (same format as Signal Desktop v1220+)
- The `version` column should default to 2 for new sessions
- Returns `null` if no session exists (triggers pre-key message flow)

---

### 7.3 `OrbitalPreKeyStore`

Stores one-time pre-keys. Keys are consumed (deleted) after use in X3DH.

**UDL:**
```udl
callback interface OrbitalPreKeyStore {
    [Throws=SignalError]
    bytes? load_pre_key(u32 id);

    [Throws=SignalError]
    void store_pre_key(u32 id, bytes record);

    [Throws=SignalError]
    void remove_pre_key(u32 id);
};
```

**Method details:**

| Method | Description | SQL Table |
|--------|-------------|-----------|
| `load_pre_key(id)` | Load pre-key by ID | `SELECT key_data FROM signal_pre_keys WHERE id=?` |
| `store_pre_key(id, record)` | Store a generated pre-key | `INSERT INTO signal_pre_keys` |
| `remove_pre_key(id)` | Delete used pre-key | `DELETE FROM signal_pre_keys WHERE id=?` |

**Notes:**
- `remove_pre_key` is called by libsignal during `signal_decrypt_pre_key` after successful X3DH
- Pre-key exhaustion detection: after `remove_pre_key`, the caller should check `SELECT COUNT(*) FROM signal_pre_keys` and trigger batch generation if below threshold

---

### 7.4 `OrbitalSignedPreKeyStore`

Stores signed pre-keys. Rotated every 30 days but old keys are kept for a grace period.

**UDL:**
```udl
callback interface OrbitalSignedPreKeyStore {
    [Throws=SignalError]
    bytes? load_signed_pre_key(u32 id);

    [Throws=SignalError]
    void store_signed_pre_key(u32 id, bytes record);
};
```

**Method details:**

| Method | Description | SQL Table |
|--------|-------------|-----------|
| `load_signed_pre_key(id)` | Load signed pre-key by ID | `SELECT key_data FROM signal_signed_pre_keys WHERE id=?` |
| `store_signed_pre_key(id, record)` | Store a generated signed pre-key | `INSERT OR REPLACE INTO signal_signed_pre_keys` |

**Notes:**
- Signed pre-keys are not deleted immediately after use; they have a 30-day rotation with a grace period
- The `confirmed` column tracks whether the server has acknowledged the key upload

---

### 7.5 `OrbitalKyberPreKeyStore`

Stores post-quantum (Kyber/ML-KEM) pre-keys for quantum-resistant forward secrecy.

**UDL:**
```udl
callback interface OrbitalKyberPreKeyStore {
    [Throws=SignalError]
    bytes? load_kyber_pre_key(u32 id);

    [Throws=SignalError]
    void store_kyber_pre_key(u32 id, bytes record);

    [Throws=SignalError]
    void mark_kyber_pre_key_used(u32 id);
};
```

**Method details:**

| Method | Description | SQL Table |
|--------|-------------|-----------|
| `load_kyber_pre_key(id)` | Load Kyber pre-key by ID | `SELECT key_data FROM signal_kyber_pre_keys WHERE id=?` |
| `store_kyber_pre_key(id, record)` | Store a generated Kyber pre-key | `INSERT OR REPLACE INTO signal_kyber_pre_keys` |
| `mark_kyber_pre_key_used(id)` | Mark as used; delete if not last-resort | `DELETE FROM signal_kyber_pre_keys WHERE id=? AND is_last_resort=0` |

**Notes:**
- Last-resort Kyber pre-keys (`is_last_resort=1`) are NOT deleted when used -- they provide a fallback when one-time Kyber pre-keys are exhausted
- `mark_kyber_pre_key_used` is called by libsignal during `signal_decrypt_pre_key`

---

### 7.6 `OrbitalSenderKeyStore`

Stores Sender Key state for group messaging.

**UDL:**
```udl
callback interface OrbitalSenderKeyStore {
    [Throws=SignalError]
    void store_sender_key(
        ProtocolAddressData sender,
        string distribution_id,
        bytes record
    );

    [Throws=SignalError]
    bytes? load_sender_key(
        ProtocolAddressData sender,
        string distribution_id
    );
};
```

**Method details:**

| Method | Description | SQL Table |
|--------|-------------|-----------|
| `store_sender_key(sender, dist_id, record)` | Store sender key state | `INSERT OR REPLACE INTO signal_sender_keys` |
| `load_sender_key(sender, dist_id)` | Load sender key for a sender+distribution | `SELECT record FROM signal_sender_keys WHERE our_service_id=? AND sender_id=? AND distribution_id=?` |

**Notes:**
- The `our_service_id` for the query comes from the local identity context, not from the `sender` parameter
- For our own sender keys (when we encrypt), `sender.name == our_service_id`
- For remote sender keys (when we decrypt), `sender.name` is the remote sender's UUID

---

## 8. Error Handling Strategy

### Rust Error Type

The wrapper crate defines a single error enum that maps libsignal's `SignalProtocolError` variants to a flat set of typed errors:

```rust
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum SignalError {
    #[error("Invalid key material: {reason}")]
    InvalidKey { reason: String },

    #[error("Invalid message: {reason}")]
    InvalidMessage { reason: String },

    #[error("Invalid signature")]
    InvalidSignature,

    #[error("No session for address")]
    NoSession,

    #[error("Untrusted identity key for {address}")]
    UntrustedIdentity { address: String },

    #[error("Duplicate message")]
    DuplicateMessage,

    #[error("Invalid certificate: {reason}")]
    InvalidCertificate { reason: String },

    #[error("Invalid argument: {reason}")]
    InvalidArgument { reason: String },

    #[error("Store operation failed: {reason}")]
    StoreError { reason: String },

    #[error("Internal error: {reason}")]
    InternalError { reason: String },
}
```

### UDL Error Definition

```udl
[Error]
enum SignalError {
    "InvalidKey",
    "InvalidMessage",
    "InvalidSignature",
    "NoSession",
    "UntrustedIdentity",
    "DuplicateMessage",
    "InvalidCertificate",
    "InvalidArgument",
    "StoreError",
    "InternalError",
};
```

### TypeScript Error Mapping

UniFFI generates a TypeScript error class hierarchy. The crypto service layer catches these and maps to application-level errors:

```typescript
// Generated by uniffi-bindgen-react-native
class SignalError extends Error {
    // Discriminant fields vary by variant
}

class SignalErrorInvalidKey extends SignalError {
    reason: string;
}

class SignalErrorUntrustedIdentity extends SignalError {
    address: string;
}

// ... etc for each variant
```

### Error Handling Guidelines

| Error | Caller Action |
|-------|---------------|
| `InvalidKey` | Log + surface to user (corrupted key material) |
| `InvalidMessage` | Log + discard message silently |
| `InvalidSignature` | Log + reject the pre-key bundle |
| `NoSession` | Fetch pre-key bundle from server and call `process_pre_key_bundle` |
| `UntrustedIdentity` | Surface safety number change UI to user |
| `DuplicateMessage` | Ignore (network retry) |
| `InvalidCertificate` | Re-fetch sender certificate from server |
| `StoreError` | Retry once, then surface database error |
| `InternalError` | Log + report as crash analytics event |

---

## 9. Buffer and Byte Array Handling

### The FFI Boundary Problem

Key material and ciphertext are `Vec<u8>` in Rust, `Uint8Array` in TypeScript. UniFFI maps `bytes` (UDL) to `Uint8Array` via the JSI bridge provided by uniffi-bindgen-react-native. This is a zero-copy or single-copy operation depending on platform.

### Strategy

1. **All key material as `bytes`:** Identity keys, pre-keys, signed pre-keys, Kyber pre-keys, session records, sender key records -- all cross the boundary as `bytes` (`Vec<u8>` / `Uint8Array`)

2. **No base64/hex encoding at the FFI boundary:** Encoding/decoding happens only at API boundaries (e.g., when uploading pre-key public keys to the server as base64). The FFI layer deals exclusively in raw bytes.

3. **SQLCipher stores BLOB directly:** The TypeScript store implementations receive `Uint8Array` from libsignal and write directly to SQLCipher BLOB columns. No intermediate encoding.

### Key Material Sizes

| Data | Size | Format |
|------|------|--------|
| Curve25519 public key | 33 bytes | Compressed point (0x05 prefix + 32 bytes) |
| Curve25519 private key | 32 bytes | Scalar |
| Identity key pair | 64 bytes | 32 private + 32 public (uncompressed) |
| Ed25519 signature | 64 bytes | |
| Pre-key record | ~70-100 bytes | Protobuf |
| Signed pre-key record | ~120-160 bytes | Protobuf |
| Kyber pre-key record | ~3,200 bytes | ML-KEM-1024 key pair + signature |
| Session record | ~2,000-10,000 bytes | Protobuf (varies with ratchet history) |
| Sender key record | ~150-500 bytes | Protobuf |
| AES-GCM IV/nonce | 12 bytes | Random |
| AES-CBC IV | 16 bytes | Random |
| HMAC-SHA256 | 32 bytes | |
| Attachment key | 64 bytes | 32 AES + 32 HMAC |

### Data Flow Example

```
Encrypt thread title:
  1. TypeScript: plaintext string → TextEncoder → Uint8Array
  2. TypeScript: call group_encrypt(plaintext_bytes, ...)
  3. FFI: Uint8Array → Vec<u8> (uniffi conversion)
  4. Rust: libsignal group_encrypt → ciphertext Vec<u8>
  5. FFI: Vec<u8> → Uint8Array (uniffi conversion)
  6. TypeScript: store Uint8Array as BLOB in orbital_threads.title_encrypted
```

---

## 10. Async/Sync Decision Rationale

### Classification

| API | Classification | Rationale |
|-----|---------------|-----------|
| `generate_identity_key_pair` | **Sync** | Single Curve25519 operation (~0.1ms) |
| `generate_pre_key` | **Sync** | Single Curve25519 operation (~0.1ms) |
| `generate_signed_pre_key` | **Sync** | Curve25519 + Ed25519 signature (~0.2ms) |
| `generate_kyber_pre_key` | **Async** | ML-KEM-1024 key gen (~5-10ms); batch generation of 100 keys = ~500ms-1s |
| `process_pre_key_bundle` | **Async** | Store I/O (session_store, identity_store) |
| `signal_encrypt` | **Async** | Store I/O (session_store load + save) |
| `signal_decrypt` | **Async** | Store I/O (session_store load + save) |
| `signal_decrypt_pre_key` | **Async** | Store I/O across 5 stores |
| `create_sender_key_distribution_message` | **Async** | Store I/O (sender_key_store) |
| `process_sender_key_distribution_message` | **Async** | Store I/O (sender_key_store) |
| `group_encrypt` | **Async** | Store I/O (sender_key_store) |
| `group_decrypt` | **Async** | Store I/O (sender_key_store) |
| `sealed_sender_encrypt` | **Async** | Store I/O (session_store, identity_store) |
| `sealed_sender_decrypt` | **Async** | Store I/O across 5 stores |

### Design Principle

**Default async for any function that touches a store.** UniFFI async functions run on a Tokio runtime in the Rust side and return Promises to TypeScript. The sync functions are called directly via JSI without a thread hop, providing lower latency for key generation during registration.

### uniffi-bindgen-react-native Async Support

uniffi-bindgen-react-native generates async TypeScript functions that return `Promise<T>`. The Rust side spawns on a Tokio runtime. The TypeScript caller uses standard `await`:

```typescript
// Sync (returns immediately via JSI)
const keyPair = OrbitalSignal.generateIdentityKeyPair();

// Async (returns Promise, runs on Rust Tokio runtime)
const plaintext = await OrbitalSignal.signalDecrypt(
    ciphertext,
    senderAddress,
    sessionStore,
    identityStore
);
```

---

## 11. Security Constraints

### Mandatory

1. **No custom cryptography.** Every encryption/decryption operation uses libsignal's audited implementations. The wrapper crate performs zero cryptographic computations of its own.

2. **Key material as BLOB.** All key material stored in SQLCipher uses BLOB columns (`Uint8Array`). Never convert to hex or base64 TEXT for storage. Conversion to base64 happens only at the API boundary for server upload.

3. **Fresh IVs/nonces.** Every encryption operation generates a fresh random IV/nonce via the system CSPRNG. Nonce reuse with the same key is a catastrophic failure.

4. **MAC-then-decrypt.** AES-GCM (used for thread/reply content) is authenticated encryption. AES-CBC (used for media) uses Encrypt-then-MAC (HMAC-SHA256 verified before decryption).

5. **Plaintext never leaves the crypto service.** The React Native UI layer receives decrypted data via typed interfaces. Plaintext is never serialized to disk, logged, or transmitted.

6. **Pre-key exhaustion monitoring.** After any pre-key consumption, check remaining count. If below 20, generate and upload a batch of 100 new pre-keys.

7. **Secure deletion.** When key material is removed (used pre-keys, old sessions), the SQLCipher DELETE is followed by `PRAGMA incremental_vacuum` to ensure key bytes do not linger in free pages.

### Prohibited

- Logging any key material, plaintext content, or protobuf envelope contents at any log level
- Storing private keys in SharedPreferences/UserDefaults/AsyncStorage -- only SQLCipher
- Transmitting plaintext to the server under any circumstance
- Using `Math.random()` or any non-CSPRNG for nonce/IV generation
- Implementing key derivation, signature verification, or MAC computation outside of libsignal

---

## 12. API Summary Matrix

Quick reference for all 18 APIs with their classification.

| # | Function | Domain | Async | Store Dependencies | Error-Prone |
|---|----------|--------|-------|-------------------|-------------|
| 1 | `generate_identity_key_pair` | Keys | No | None | No |
| 2 | `generate_pre_key` | Keys | No | None | No |
| 3 | `generate_signed_pre_key` | Keys | No | None | Low |
| 4 | `generate_kyber_pre_key` | Keys | Yes | None | Low |
| 5 | `process_pre_key_bundle` | Session | Yes | Session, Identity | High |
| 6 | `signal_encrypt` | Session | Yes | Session, Identity | Medium |
| 7 | `signal_decrypt` | Session | Yes | Session, Identity | High |
| 8 | `signal_decrypt_pre_key` | Session | Yes | Session, Identity, PreKey, SignedPreKey, KyberPreKey | High |
| 9 | `create_sender_key_distribution_message` | Group | Yes | SenderKey | Low |
| 10 | `process_sender_key_distribution_message` | Group | Yes | SenderKey | Medium |
| 11 | `group_encrypt` | Group | Yes | SenderKey | Medium |
| 12 | `group_decrypt` | Group | Yes | SenderKey | High |
| 13 | `sealed_sender_encrypt` | Sealed Sender | Yes | Session, Identity | Medium |
| 14 | `sealed_sender_decrypt` | Sealed Sender | Yes | Session, Identity, PreKey, SignedPreKey, KyberPreKey | High |
| 15 | `get_pre_key_public` | Utility | No | None | No |
| 16 | `get_signed_pre_key_public` | Utility | No | None | No |
| 17 | `get_kyber_pre_key_public` | Utility | No | None | No |
| 18 | `create_protocol_address` | Utility | No | None | No |

### Utility APIs (Not Detailed Above)

These 4 helper functions extract public components for server upload and construct protocol addresses. They are straightforward serialization helpers:

```udl
namespace orbital_signal {
    // Extract public key + ID from a serialized pre-key record for server upload
    PreKeyPublicData get_pre_key_public(bytes pre_key_record);

    // Extract public key + signature + ID from a serialized signed pre-key record
    SignedPreKeyPublicData get_signed_pre_key_public(bytes signed_pre_key_record);

    // Extract public key + signature + ID from a serialized Kyber pre-key record
    KyberPreKeyPublicData get_kyber_pre_key_public(bytes kyber_pre_key_record);

    // Construct a ProtocolAddressData (convenience, could be done in TS)
    ProtocolAddressData create_protocol_address(string name, u32 device_id);
};

dictionary PreKeyPublicData {
    u32 id;
    bytes public_key;   // 33 bytes
};

dictionary SignedPreKeyPublicData {
    u32 id;
    bytes public_key;   // 33 bytes
    bytes signature;    // 64 bytes
    u64 timestamp;
};

dictionary KyberPreKeyPublicData {
    u32 id;
    bytes public_key;
    bytes signature;
};
```

**Purpose:** The public components are what gets uploaded to the server as part of the pre-key bundle. The full serialized records (containing private keys) stay in SQLCipher.

---

## Appendix A: Complete UDL File

The consolidated UDL that uniffi-bindgen-react-native will process:

```udl
namespace orbital_signal {
    // ── Key Generation ──
    IdentityKeyPairData generate_identity_key_pair();

    bytes generate_pre_key(u32 id);

    [Throws=SignalError]
    bytes generate_signed_pre_key(
        u32 id,
        IdentityKeyPairData identity_key_pair,
        u64 timestamp
    );

    [Throws=SignalError]
    bytes generate_kyber_pre_key(
        u32 id,
        IdentityKeyPairData identity_key_pair,
        u64 timestamp,
        boolean is_last_resort
    );

    // ── Session Management ──
    [Throws=SignalError]
    void process_pre_key_bundle(
        PreKeyBundleData bundle,
        ProtocolAddressData remote_address,
        OrbitalSessionStore session_store,
        OrbitalIdentityKeyStore identity_store
    );

    [Throws=SignalError]
    CiphertextMessageData signal_encrypt(
        bytes plaintext,
        ProtocolAddressData remote_address,
        OrbitalSessionStore session_store,
        OrbitalIdentityKeyStore identity_store
    );

    [Throws=SignalError]
    bytes signal_decrypt(
        bytes ciphertext,
        ProtocolAddressData remote_address,
        OrbitalSessionStore session_store,
        OrbitalIdentityKeyStore identity_store
    );

    [Throws=SignalError]
    bytes signal_decrypt_pre_key(
        bytes ciphertext,
        ProtocolAddressData remote_address,
        OrbitalSessionStore session_store,
        OrbitalIdentityKeyStore identity_store,
        OrbitalPreKeyStore pre_key_store,
        OrbitalSignedPreKeyStore signed_pre_key_store,
        OrbitalKyberPreKeyStore kyber_pre_key_store
    );

    // ── Group Messaging (Sender Keys) ──
    [Throws=SignalError]
    bytes create_sender_key_distribution_message(
        ProtocolAddressData sender,
        string distribution_id,
        OrbitalSenderKeyStore sender_key_store
    );

    [Throws=SignalError]
    void process_sender_key_distribution_message(
        ProtocolAddressData sender,
        bytes distribution_message,
        OrbitalSenderKeyStore sender_key_store
    );

    [Throws=SignalError]
    bytes group_encrypt(
        bytes plaintext,
        ProtocolAddressData sender,
        string distribution_id,
        OrbitalSenderKeyStore sender_key_store
    );

    [Throws=SignalError]
    bytes group_decrypt(
        bytes ciphertext,
        ProtocolAddressData sender,
        OrbitalSenderKeyStore sender_key_store
    );

    // ── Sealed Sender ──
    [Throws=SignalError]
    bytes sealed_sender_encrypt(
        bytes plaintext,
        ProtocolAddressData remote_address,
        bytes sender_certificate,
        OrbitalSessionStore session_store,
        OrbitalIdentityKeyStore identity_store
    );

    [Throws=SignalError]
    SealedSenderResult sealed_sender_decrypt(
        bytes ciphertext,
        bytes trust_root,
        ProtocolAddressData local_address,
        u32 local_registration_id,
        OrbitalSessionStore session_store,
        OrbitalIdentityKeyStore identity_store,
        OrbitalPreKeyStore pre_key_store,
        OrbitalSignedPreKeyStore signed_pre_key_store,
        OrbitalKyberPreKeyStore kyber_pre_key_store
    );

    // ── Utility ──
    PreKeyPublicData get_pre_key_public(bytes pre_key_record);
    SignedPreKeyPublicData get_signed_pre_key_public(bytes signed_pre_key_record);
    KyberPreKeyPublicData get_kyber_pre_key_public(bytes kyber_pre_key_record);
    ProtocolAddressData create_protocol_address(string name, u32 device_id);
};

// ── Types ──

dictionary ProtocolAddressData {
    string name;
    u32 device_id;
};

dictionary IdentityKeyPairData {
    bytes public_key;
    bytes private_key;
};

dictionary PreKeyBundleData {
    u32 registration_id;
    u32 device_id;
    u32? pre_key_id;
    bytes? pre_key_public;
    u32 signed_pre_key_id;
    bytes signed_pre_key_public;
    bytes signed_pre_key_signature;
    bytes identity_key;
    u32? kyber_pre_key_id;
    bytes? kyber_pre_key_public;
    bytes? kyber_pre_key_signature;
};

dictionary CiphertextMessageData {
    CiphertextMessageType message_type;
    bytes serialized;
};

dictionary SealedSenderResult {
    string sender_service_id;
    u32 sender_device_id;
    bytes message;
    u32 content_hint;
};

dictionary PreKeyPublicData {
    u32 id;
    bytes public_key;
};

dictionary SignedPreKeyPublicData {
    u32 id;
    bytes public_key;
    bytes signature;
    u64 timestamp;
};

dictionary KyberPreKeyPublicData {
    u32 id;
    bytes public_key;
    bytes signature;
};

enum CiphertextMessageType {
    "Whisper",
    "PreKey",
    "SenderKey",
    "Plaintext",
};

enum Direction {
    "Sending",
    "Receiving",
};

[Error]
enum SignalError {
    "InvalidKey",
    "InvalidMessage",
    "InvalidSignature",
    "NoSession",
    "UntrustedIdentity",
    "DuplicateMessage",
    "InvalidCertificate",
    "InvalidArgument",
    "StoreError",
    "InternalError",
};

// ── Store Callback Interfaces ──

callback interface OrbitalIdentityKeyStore {
    [Throws=SignalError]
    IdentityKeyPairData get_identity_key_pair();

    [Throws=SignalError]
    u32 get_local_registration_id();

    [Throws=SignalError]
    boolean save_identity(ProtocolAddressData address, bytes identity_key);

    [Throws=SignalError]
    boolean is_trusted_identity(
        ProtocolAddressData address,
        bytes identity_key,
        Direction direction
    );

    [Throws=SignalError]
    bytes? get_identity(ProtocolAddressData address);
};

callback interface OrbitalSessionStore {
    [Throws=SignalError]
    bytes? load_session(ProtocolAddressData address);

    [Throws=SignalError]
    void store_session(ProtocolAddressData address, bytes record);
};

callback interface OrbitalPreKeyStore {
    [Throws=SignalError]
    bytes? load_pre_key(u32 id);

    [Throws=SignalError]
    void store_pre_key(u32 id, bytes record);

    [Throws=SignalError]
    void remove_pre_key(u32 id);
};

callback interface OrbitalSignedPreKeyStore {
    [Throws=SignalError]
    bytes? load_signed_pre_key(u32 id);

    [Throws=SignalError]
    void store_signed_pre_key(u32 id, bytes record);
};

callback interface OrbitalKyberPreKeyStore {
    [Throws=SignalError]
    bytes? load_kyber_pre_key(u32 id);

    [Throws=SignalError]
    void store_kyber_pre_key(u32 id, bytes record);

    [Throws=SignalError]
    void mark_kyber_pre_key_used(u32 id);
};

callback interface OrbitalSenderKeyStore {
    [Throws=SignalError]
    void store_sender_key(
        ProtocolAddressData sender,
        string distribution_id,
        bytes record
    );

    [Throws=SignalError]
    bytes? load_sender_key(
        ProtocolAddressData sender,
        string distribution_id
    );
};
```

---

## Appendix B: Desktop Compatibility Reference

Mapping between this spec and Orbital-Desktop's libsignal usage:

| This Spec | Desktop File | Desktop Function |
|-----------|-------------|------------------|
| `process_pre_key_bundle` | `ts/textsecure/OutgoingMessage.ts` | `getKeysForIdentifier()` → `processPreKeyBundle()` |
| `signal_encrypt` | `ts/textsecure/OutgoingMessage.ts` | `encryptToAddress()` |
| `signal_decrypt` | `ts/textsecure/MessageReceiver.ts` | `decryptEnvelope()` |
| `signal_decrypt_pre_key` | `ts/textsecure/MessageReceiver.ts` | `decryptEnvelope()` (pre-key path) |
| `group_encrypt` | `ts/util/sendToGroup.preload.ts` | `sendToGroupViaSenderKey()` |
| `group_decrypt` | `ts/textsecure/MessageReceiver.ts` | `decryptSenderKeyEnvelope()` |
| `create_sender_key_distribution_message` | `ts/util/sendToGroup.preload.ts` | `createSenderKeyDistributionMessage()` |
| `process_sender_key_distribution_message` | `ts/textsecure/MessageReceiver.ts` | `handleSenderKeyDistributionMessage()` |
| `sealed_sender_encrypt` | `ts/textsecure/OutgoingMessage.ts` | `transmitMessage()` (sealed sender path) |
| `sealed_sender_decrypt` | `ts/textsecure/MessageReceiver.ts` | `decryptSealedSender()` |
| Store interfaces | `ts/SignalProtocolStore.preload.ts` | 2,855-line store implementation |
| Store wrappers | `ts/LibSignalStores.preload.ts` | 330-line store adapters |
