---
name: Preloaded Store Architecture — Implemented and Validated
description: Confirmed and fully implemented architecture for all 10 protocol functions — preloaded Input/Result records with InMemSignalProtocolStore/InMemSenderKeyStore, security audit passed, identity key in Keychain
type: project
---

## Status: IMPLEMENTED, VALIDATED, AND AUDITED (2026-04-09)

All 10 protocol functions are implemented using the preloaded store pattern. Security audit validated the architecture as correct for Signal Protocol guarantees. All Critical/High security findings have been resolved.

**Why:** uniffi 0.31 cannot pass `Arc<dyn CallbackInterface>` as function parameters (FfiConverterArc limitation is universal). The preloaded pattern also sidesteps async_trait(?Send) issues entirely.

**How to apply:** This is the established pattern for all current and future protocol functions. The sealed sender stubs should follow the same pattern when implemented.

---

## Pattern Summary

1. TypeScript reads required store data from SQLCipher via repository functions
2. Packs data into a `FooInput` uniffi Record
3. Calls the Rust function (sync export, tokio block_on internally)
4. Rust hydrates InMemSignalProtocolStore (1:1) or InMemSenderKeyStore (group) from Input
5. Runs libsignal protocol operation
6. Extracts changed state and returns `FooResult` record
7. TypeScript persists changed state back to SQLCipher in a BEGIN IMMEDIATE transaction

---

## Security Requirements (Audit-Validated)

- **BEGIN IMMEDIATE transactions:** All store mutations use BEGIN IMMEDIATE (not BEGIN DEFERRED) to prevent SQLITE_BUSY races
- **Per-address locking:** Promise-queue lock keyed by `${name}:${deviceId}` prevents concurrent operations on the same session
- **Pre-key consumption atomicity:** `decryptPreKeyMessage` deletes consumed one-time pre-keys and marks Kyber keys used within the same transaction as session save and identity save
- **No plaintext leakage:** Plaintext never leaves the crypto service layer; the UI receives typed results
- **Identity key in Keychain/Keystore:** Private identity key stored via react-native-keychain with module-scoped cache in keyGenerationService.ts. One-way migration from SQLCipher is automatic (Issue #54 resolved).

---

## Store Interaction Summary (Validated by Implementation)

| Function | Stores Read | Stores Written | Notes |
|---|---|---|---|
| process_pre_key_bundle | identity, session | session, identity | X3DH; requires Kyber fields (PQXDH enforced) |
| signal_encrypt | session, identity | session | Ratchet advances |
| signal_decrypt | session, identity | session | Ratchet advances |
| signal_decrypt_pre_key | session, identity, pre_key, signed_pre_key, kyber_pre_key | session, identity, pre_key (delete), kyber_pre_key (mark used) | Most complex; uses parse_prekey_message_ids first |
| create_sender_key_distribution_message | sender_key | sender_key | Uses InMemSenderKeyStore |
| process_sender_key_distribution_message | sender_key | sender_key | Extracts distribution_id from SKDM |
| group_encrypt | sender_key | sender_key | Ratchet advances |
| group_decrypt | sender_key | sender_key | Parses SenderKeyMessage for distribution_id first |

---

## Implementation Details Discovered

- **group_decrypt does not take distribution_id as input:** The distribution_id is embedded in the SenderKeyMessage ciphertext. Rust parses `SenderKeyMessage::try_from(ciphertext)` to extract it before preloading the sender key. TypeScript still passes distribution_id for the store lookup key.
- **process_sender_key_distribution_message extracts distribution_id from SKDM:** Uses `skdm.distribution_id()` rather than requiring it as a separate input parameter.
- **signal_encrypt session_record is Optional:** Allows for initial encrypt after process_pre_key_bundle without a separate load (the session exists in the just-saved state).
- **signal_decrypt session_record is required (not Optional):** A session must exist for standard message decryption.
- **Helper refactoring in session.rs:** `build_runtime()`, `create_store()`, and `reconstruct_identity_key_pair()` are shared helpers. signal_encrypt still has inline versions (from the Issue #58 spike, marked "DO NOT MODIFY").

---

## Dead Code Status

The following modules are dead code from the abandoned callback interface approach:
- `store_adapters.rs` -- Still exists because `to_protocol_address()` helper is imported by session.rs and group.rs. Should be extracted to a shared module.
- `client.rs` -- Fully dead, can be deleted.
- `stores.rs` -- Fully dead, can be deleted.
