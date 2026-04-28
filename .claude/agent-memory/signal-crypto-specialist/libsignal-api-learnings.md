---
name: libsignal v0.83.0 API Learnings
description: Non-obvious libsignal API behaviors discovered during implementation — key sizes, DeviceId, async patterns, group messaging, pre-key bundle construction
type: project
---

Key findings from implementing the Rust wrapper crate (issues #7-9, #17, #58) and the PoC roundtrip (issue #11, PR #39):

## Key Generation & Types

**PreKeyBundle::new takes 10 args (Kyber required):** The constructor requires Kyber pre-key fields (id, public_key, signature) as positional params. Orbital enforces PQXDH — bundles without Kyber fields are rejected with InvalidArgument.

**DeviceId is NonZeroU8:** libsignal_core::DeviceId wraps a NonZeroU8, not u32. Max 127 devices per user. `DeviceId::try_from(data.device_id)` returns `InvalidArgument` for out-of-range values.

**Key sizes confirmed by tests:**
- Identity public key: 33 bytes (0x05 Curve25519 prefix + 32 bytes)
- Identity private key: 32 bytes
- Signed pre-key signature: 64 bytes (Ed25519)
- Kyber1024 record: ~3200 bytes serialized
- Kyber1024 public key: ~1568 bytes

**generate_kyber_pre_key returns KyberPreKeyResult:** Returns a struct with `record: Vec<u8>` and `is_last_resort: bool`. The flag is a storage-layer concern not encoded in KyberPreKeyRecord itself.

**Timestamp is not u64 directly:** libsignal uses `Timestamp::from_epoch_millis(u64)` and `.epoch_millis()` for conversion.

## Async & Runtime

**Store traits use async_trait(?Send):** libsignal's store traits are `#[async_trait(?Send)]`, producing non-Send futures. This means:
1. uniffi async exports (which require Send) cannot directly call protocol functions
2. All protocol functions use `tokio::runtime::Builder::new_current_thread().enable_all().build().block_on()` to drive these futures from sync-exported functions
3. The `build_runtime()` helper is shared across session.rs and group.rs (signal_encrypt still has inline version from Issue #58 spike)

## Session Operations (Discovered During Implementation)

**message_decrypt_signal vs message_decrypt_prekey:** Standard decryption uses `message_decrypt_signal` which takes `&SignalMessage`. Pre-key decryption uses `message_decrypt_prekey` which takes `&PreKeySignalMessage`. The message must be parsed with the correct `try_from` before calling.

**PreKeySignalMessage fields accessible before decryption:** `pre_key_id()`, `signed_pre_key_id()`, `kyber_pre_key_id()`, and `identity_key()` can all be read from the parsed message without performing decryption. This enables the `parse_prekey_message_ids` utility.

**IdentityKey from PreKeySignalMessage:** `prekey_signal_message.identity_key().clone()` returns the sender's identity key. Must be extracted BEFORE calling `message_decrypt_prekey` since the message is consumed.

**message_decrypt_prekey signature:** Takes `&mut store.pre_key_store` but `&store.signed_pre_key_store` (immutable borrow for signed pre-key store). This is because signed pre-keys are not consumed.

## Group Operations (Discovered During Implementation)

**SenderKeyMessage embeds distribution_id:** For group_decrypt, the distribution_id is not a separate parameter. It must be parsed from the ciphertext: `SenderKeyMessage::try_from(ciphertext).distribution_id()`. The Rust implementation pre-parses the message to extract distribution_id before preloading the sender key.

**SenderKeyDistributionMessage embeds distribution_id:** For process_sender_key_distribution_message, the distribution_id is extracted from the SKDM via `skdm.distribution_id()` rather than being a separate input.

**InMemSenderKeyStore is separate from InMemSignalProtocolStore:** Group operations use `InMemSenderKeyStore::new()` directly, not the full protocol store. This is simpler and avoids needing identity key pair for group operations.

**group_encrypt returns SenderKeyMessage:** The result is accessed via `skm.serialized().to_vec()`.

**create_sender_key_distribution_message returns SKDM:** Accessed via `skdm.serialized().to_vec()`.

## Error Handling

**Error mapping is exhaustive:** The From<SignalProtocolError> impl covers all known variants including CurveError bridge, ApplicationCallbackError for store failures, InvalidRegistrationId, InvalidProtocolAddress, plus a catch-all.

**GenericSignedPreKey trait:** Required for calling serialize/deserialize/id/signature/public_key on both SignedPreKeyRecord and KyberPreKeyRecord. Must be imported explicitly.

**Why:** These learnings prevent rediscovering the same API quirks when adding sealed sender or future protocol functions.

**How to apply:** Reference when implementing sealed_sender_encrypt/decrypt (which will need a superset of the session + pre-key patterns), or when debugging protocol issues.
