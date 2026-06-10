use std::time::SystemTime;

use libsignal_protocol::{
    CiphertextMessage, GenericSignedPreKey, IdentityKey, IdentityKeyPair, IdentityKeyStore,
    InMemSignalProtocolStore, KyberPreKeyRecord, KyberPreKeyStore, PreKeyBundle, PreKeyRecord,
    PreKeyStore, PublicKey, SessionRecord, SessionStore, SignedPreKeyRecord, SignedPreKeyStore,
};

use crate::error::SignalError;
use crate::store_adapters::to_protocol_address;
use crate::types::{
    CiphertextMessageData, CiphertextMessageType, DecryptInput, DecryptPreKeyInput,
    DecryptPreKeyResult, DecryptResult, EncryptInput, EncryptResult, ProcessPreKeyBundleInput,
    ProcessPreKeyBundleResult,
};

// ---------------------------------------------------------------------------
// Helper: reconstruct IdentityKeyPair from raw bytes (reuses keys.rs logic)
// ---------------------------------------------------------------------------

pub(crate) fn reconstruct_identity_key_pair(
    data: &crate::types::IdentityKeyPairData,
) -> Result<IdentityKeyPair, SignalError> {
    crate::keys::deserialize_identity_key_pair(data)
}

/// Build a single-threaded tokio runtime for block_on() calls.
pub(crate) fn build_runtime() -> Result<tokio::runtime::Runtime, SignalError> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| SignalError::InternalError {
            reason: format!("tokio runtime: {e}"),
        })
}

/// Create an InMemSignalProtocolStore pre-loaded with our identity.
pub(crate) fn create_store(
    identity_key_pair: IdentityKeyPair,
    registration_id: u32,
) -> Result<InMemSignalProtocolStore, SignalError> {
    InMemSignalProtocolStore::new(identity_key_pair, registration_id).map_err(|e| {
        SignalError::InternalError {
            reason: format!("failed to create in-memory store: {e}"),
        }
    })
}

// ---------------------------------------------------------------------------
// process_pre_key_bundle
// ---------------------------------------------------------------------------

/// Perform X3DH key agreement to establish an outgoing session (preloaded store pattern).
///
/// Accepts all needed store data as a flat record. The caller (TypeScript) reads the
/// stores before calling, and writes back the updated session record + identity after.
#[uniffi::export]
pub fn process_pre_key_bundle(
    input: ProcessPreKeyBundleInput,
) -> Result<ProcessPreKeyBundleResult, SignalError> {
    let rt = build_runtime()?;

    rt.block_on(async {
        let identity_key_pair = reconstruct_identity_key_pair(&input.identity_key_pair)?;
        let mut store = create_store(identity_key_pair, input.registration_id)?;
        let protocol_address = to_protocol_address(&input.remote_address)?;

        // Pre-load existing session if provided
        if let Some(session_bytes) = &input.existing_session_record {
            let session_record = SessionRecord::deserialize(session_bytes).map_err(|e| {
                SignalError::InvalidMessage {
                    reason: format!("session record deserialization: {e}"),
                }
            })?;
            store
                .session_store
                .store_session(&protocol_address, &session_record)
                .await
                .map_err(SignalError::from)?;
        }

        // Pre-load existing remote identity if provided
        if let Some(remote_id_bytes) = &input.remote_identity {
            let remote_identity =
                IdentityKey::decode(remote_id_bytes).map_err(|e| SignalError::InvalidKey {
                    reason: format!("remote identity key: {e}"),
                })?;
            store
                .identity_store
                .save_identity(&protocol_address, &remote_identity)
                .await
                .map_err(SignalError::from)?;
        }

        // Reconstruct PreKeyBundle from PreKeyBundleData
        let bundle_data = &input.bundle;
        let device_id =
            libsignal_core::DeviceId::try_from(bundle_data.device_id).map_err(|_| {
                SignalError::InvalidArgument {
                    reason: format!(
                        "device_id {} is out of valid range (1-127)",
                        bundle_data.device_id
                    ),
                }
            })?;

        // Decode optional one-time pre-key
        let pre_key = match (&bundle_data.pre_key_id, &bundle_data.pre_key_public) {
            (Some(id), Some(pub_bytes)) => {
                let pk =
                    PublicKey::deserialize(pub_bytes).map_err(|e| SignalError::InvalidKey {
                        reason: format!("pre-key public: {e}"),
                    })?;
                Some((libsignal_protocol::PreKeyId::from(*id), pk))
            }
            _ => None,
        };

        // Decode signed pre-key
        let signed_pre_key_id =
            libsignal_protocol::SignedPreKeyId::from(bundle_data.signed_pre_key_id);
        let signed_pre_key_public = PublicKey::deserialize(&bundle_data.signed_pre_key_public)
            .map_err(|e| SignalError::InvalidKey {
                reason: format!("signed pre-key public: {e}"),
            })?;

        // Decode identity key
        let bundle_identity_key = IdentityKey::decode(&bundle_data.identity_key).map_err(|e| {
            SignalError::InvalidKey {
                reason: format!("bundle identity key: {e}"),
            }
        })?;

        // Decode optional Kyber pre-key
        let kyber_pre_key_id = bundle_data
            .kyber_pre_key_id
            .map(libsignal_protocol::KyberPreKeyId::from);
        let kyber_pre_key_public = match &bundle_data.kyber_pre_key_public {
            Some(bytes) => Some(
                libsignal_protocol::kem::PublicKey::deserialize(bytes).map_err(|e| {
                    SignalError::InvalidKey {
                        reason: format!("kyber pre-key public: {e}"),
                    }
                })?,
            ),
            None => None,
        };
        let kyber_pre_key_signature = bundle_data.kyber_pre_key_signature.clone();

        // Build PreKeyBundle using the 10-arg constructor.
        // All three Kyber fields must be present or all absent.
        let has_kyber = kyber_pre_key_id.is_some()
            || kyber_pre_key_public.is_some()
            || kyber_pre_key_signature.is_some();

        if has_kyber
            && (kyber_pre_key_id.is_none()
                || kyber_pre_key_public.is_none()
                || kyber_pre_key_signature.is_none())
        {
            return Err(SignalError::InvalidArgument {
                reason:
                    "Kyber pre-key fields must all be present or all absent in the bundle"
                        .to_string(),
            });
        }

        let bundle = if let (Some(kyber_id), Some(kyber_pub), Some(kyber_sig)) = (
            kyber_pre_key_id,
            kyber_pre_key_public,
            kyber_pre_key_signature,
        ) {
            PreKeyBundle::new(
                bundle_data.registration_id,
                device_id,
                pre_key,
                signed_pre_key_id,
                signed_pre_key_public,
                bundle_data.signed_pre_key_signature.clone(),
                kyber_id,
                kyber_pub,
                kyber_sig,
                bundle_identity_key,
            )
            .map_err(SignalError::from)?
        } else {
            // Non-PQ bundles are not supported in our implementation.
            // Orbital always uses post-quantum key agreement (PQXDH).
            return Err(SignalError::InvalidArgument {
                reason: "PreKeyBundle requires Kyber pre-key data (kyber_pre_key_id, kyber_pre_key_public, kyber_pre_key_signature must all be provided)".to_string(),
            });
        };

        // Process the pre-key bundle (X3DH key agreement)
        libsignal_protocol::process_prekey_bundle(
            &protocol_address,
            &mut store.session_store,
            &mut store.identity_store,
            &bundle,
            SystemTime::now(),
            &mut rand::rng(),
        )
        .await
        .map_err(SignalError::from)?;

        // Extract updated session record
        let updated_session = store
            .session_store
            .load_session(&protocol_address)
            .await
            .map_err(SignalError::from)?
            .ok_or(SignalError::NoSession)?;
        let updated_session_bytes = updated_session.serialize().map_err(SignalError::from)?;

        // Determine if identity changed by comparing existing remote identity with bundle identity
        let identity_changed = if let Some(remote_id_bytes) = &input.remote_identity {
            let existing_identity =
                IdentityKey::decode(remote_id_bytes).map_err(|e| SignalError::InvalidKey {
                    reason: format!("remote identity key: {e}"),
                })?;
            existing_identity != bundle_identity_key
        } else {
            false
        };

        Ok(ProcessPreKeyBundleResult {
            updated_session_record: updated_session_bytes,
            identity_key: bundle_identity_key.serialize().to_vec(),
            identity_changed,
        })
    })
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// signal_encrypt
// ---------------------------------------------------------------------------

/// Encrypt a message using the Double Ratchet protocol (preloaded store pattern).
#[uniffi::export]
pub fn signal_encrypt(input: EncryptInput) -> Result<EncryptResult, SignalError> {
    let rt = build_runtime()?;

    rt.block_on(async {
        let identity_key_pair = reconstruct_identity_key_pair(&input.identity_key_pair)?;
        let mut store = create_store(identity_key_pair, input.registration_id)?;

        let protocol_address = to_protocol_address(&input.remote_address)?;

        // Pre-load session record if provided
        if let Some(session_bytes) = &input.session_record {
            let session_record = SessionRecord::deserialize(session_bytes)
                .map_err(|e| SignalError::InvalidMessage {
                    reason: format!("session record deserialization: {e}"),
                })?;
            store
                .session_store
                .store_session(&protocol_address, &session_record)
                .await
                .map_err(SignalError::from)?;
        }

        // Pre-load remote identity if provided
        if let Some(remote_id_bytes) = &input.remote_identity {
            let remote_identity = IdentityKey::decode(remote_id_bytes)
                .map_err(|e| SignalError::InvalidKey {
                    reason: format!("remote identity key: {e}"),
                })?;
            store
                .identity_store
                .save_identity(&protocol_address, &remote_identity)
                .await
                .map_err(SignalError::from)?;
        }

        // Encrypt
        let ciphertext = libsignal_protocol::message_encrypt(
            &input.plaintext,
            &protocol_address,
            &mut store.session_store,
            &mut store.identity_store,
            SystemTime::now(),
            &mut rand::rng(),
        )
        .await
        .map_err(SignalError::from)?;

        let message_type = match ciphertext {
            CiphertextMessage::SignalMessage(_) => CiphertextMessageType::Whisper,
            CiphertextMessage::PreKeySignalMessage(_) => CiphertextMessageType::PreKey,
            CiphertextMessage::SenderKeyMessage(_) => CiphertextMessageType::SenderKey,
            CiphertextMessage::PlaintextContent(_) => CiphertextMessageType::Plaintext,
        };

        // Extract updated session record to return to caller
        let updated_session = store
            .session_store
            .load_session(&protocol_address)
            .await
            .map_err(SignalError::from)?
            .ok_or(SignalError::NoSession)?;

        let updated_session_bytes =
            updated_session.serialize().map_err(SignalError::from)?;

        Ok(EncryptResult {
            ciphertext: CiphertextMessageData {
                message_type,
                serialized: ciphertext.serialize().to_vec(),
            },
            updated_session_record: updated_session_bytes,
        })
    })
}

// ---------------------------------------------------------------------------
// signal_decrypt
// ---------------------------------------------------------------------------

/// Decrypt a normal Signal protocol message (preloaded store pattern).
///
/// Requires a session to already exist. The caller passes the serialized session record
/// and gets back the plaintext + updated session record.
#[uniffi::export]
pub fn signal_decrypt(input: DecryptInput) -> Result<DecryptResult, SignalError> {
    let rt = build_runtime()?;

    rt.block_on(async {
        let identity_key_pair = reconstruct_identity_key_pair(&input.identity_key_pair)?;
        let mut store = create_store(identity_key_pair, input.registration_id)?;
        let protocol_address = to_protocol_address(&input.sender_address)?;

        // Pre-load session record (required for standard messages)
        let session_record = SessionRecord::deserialize(&input.session_record).map_err(|e| {
            SignalError::InvalidMessage {
                reason: format!("session record deserialization: {e}"),
            }
        })?;
        store
            .session_store
            .store_session(&protocol_address, &session_record)
            .await
            .map_err(SignalError::from)?;

        // Pre-load remote identity if provided
        if let Some(remote_id_bytes) = &input.remote_identity {
            let remote_identity =
                IdentityKey::decode(remote_id_bytes).map_err(|e| SignalError::InvalidKey {
                    reason: format!("remote identity key: {e}"),
                })?;
            store
                .identity_store
                .save_identity(&protocol_address, &remote_identity)
                .await
                .map_err(SignalError::from)?;
        }

        // Parse ciphertext as SignalMessage
        let signal_message =
            libsignal_protocol::SignalMessage::try_from(input.ciphertext.as_slice())
                .map_err(SignalError::from)?;

        // Decrypt using message_decrypt_signal
        let plaintext = libsignal_protocol::message_decrypt_signal(
            &signal_message,
            &protocol_address,
            &mut store.session_store,
            &mut store.identity_store,
            &mut rand::rng(),
        )
        .await
        .map_err(SignalError::from)?;

        // Extract updated session record
        let updated_session = store
            .session_store
            .load_session(&protocol_address)
            .await
            .map_err(SignalError::from)?
            .ok_or(SignalError::NoSession)?;
        let updated_session_bytes = updated_session.serialize().map_err(SignalError::from)?;

        Ok(DecryptResult {
            plaintext,
            updated_session_record: updated_session_bytes,
        })
    })
}

// ---------------------------------------------------------------------------
// signal_decrypt_pre_key
// ---------------------------------------------------------------------------

/// Decrypt a pre-key Signal message (preloaded store pattern).
///
/// This handles the first message in a new session. The caller must pre-load the
/// required pre-keys by first calling `parse_prekey_message_ids` to determine which
/// keys are needed, then passing the serialized key records in the input.
#[uniffi::export]
pub fn signal_decrypt_pre_key(
    input: DecryptPreKeyInput,
) -> Result<DecryptPreKeyResult, SignalError> {
    let rt = build_runtime()?;

    rt.block_on(async {
        let identity_key_pair = reconstruct_identity_key_pair(&input.identity_key_pair)?;
        let mut store = create_store(identity_key_pair, input.registration_id)?;
        let protocol_address = to_protocol_address(&input.sender_address)?;

        // Pre-load existing session if provided
        if let Some(session_bytes) = &input.existing_session_record {
            let session_record = SessionRecord::deserialize(session_bytes).map_err(|e| {
                SignalError::InvalidMessage {
                    reason: format!("session record deserialization: {e}"),
                }
            })?;
            store
                .session_store
                .store_session(&protocol_address, &session_record)
                .await
                .map_err(SignalError::from)?;
        }

        // Pre-load remote identity if provided
        if let Some(remote_id_bytes) = &input.remote_identity {
            let remote_identity =
                IdentityKey::decode(remote_id_bytes).map_err(|e| SignalError::InvalidKey {
                    reason: format!("remote identity key: {e}"),
                })?;
            store
                .identity_store
                .save_identity(&protocol_address, &remote_identity)
                .await
                .map_err(SignalError::from)?;
        }

        // Pre-load one-time pre-key if provided
        if let Some(pre_key_bytes) = &input.pre_key_record {
            let record =
                PreKeyRecord::deserialize(pre_key_bytes).map_err(|e| SignalError::InvalidKey {
                    reason: format!("pre-key record: {e}"),
                })?;
            let id = record.id().map_err(SignalError::from)?;
            store
                .pre_key_store
                .save_pre_key(id, &record)
                .await
                .map_err(SignalError::from)?;
        }

        // Pre-load signed pre-key (required)
        {
            let record = SignedPreKeyRecord::deserialize(&input.signed_pre_key_record).map_err(
                |e| SignalError::InvalidKey {
                    reason: format!("signed pre-key record: {e}"),
                },
            )?;
            let id = record.id().map_err(SignalError::from)?;
            store
                .signed_pre_key_store
                .save_signed_pre_key(id, &record)
                .await
                .map_err(SignalError::from)?;
        }

        // Pre-load Kyber pre-key if provided
        if let Some(kyber_bytes) = &input.kyber_pre_key_record {
            let record =
                KyberPreKeyRecord::deserialize(kyber_bytes).map_err(|e| SignalError::InvalidKey {
                    reason: format!("kyber pre-key record: {e}"),
                })?;
            let id = record.id().map_err(SignalError::from)?;
            store
                .kyber_pre_key_store
                .save_kyber_pre_key(id, &record)
                .await
                .map_err(SignalError::from)?;
        }

        // Parse ciphertext as PreKeySignalMessage
        let prekey_signal_message =
            libsignal_protocol::PreKeySignalMessage::try_from(input.ciphertext.as_slice())
                .map_err(SignalError::from)?;

        // Extract sender identity key from the message BEFORE decryption
        let sender_identity_key = *prekey_signal_message.identity_key();

        // Extract consumed key IDs from the message
        let consumed_pre_key_id = prekey_signal_message.pre_key_id().map(u32::from);
        let consumed_kyber_pre_key_id = prekey_signal_message.kyber_pre_key_id().map(u32::from);

        // Decrypt using message_decrypt_prekey
        let plaintext = libsignal_protocol::message_decrypt_prekey(
            &prekey_signal_message,
            &protocol_address,
            &mut store.session_store,
            &mut store.identity_store,
            &mut store.pre_key_store,
            &store.signed_pre_key_store,
            &mut store.kyber_pre_key_store,
            &mut rand::rng(),
        )
        .await
        .map_err(SignalError::from)?;

        // Extract updated session record
        let updated_session = store
            .session_store
            .load_session(&protocol_address)
            .await
            .map_err(SignalError::from)?
            .ok_or(SignalError::NoSession)?;
        let updated_session_bytes = updated_session.serialize().map_err(SignalError::from)?;

        // Determine if identity changed
        let identity_changed = if let Some(remote_id_bytes) = &input.remote_identity {
            let existing_identity =
                IdentityKey::decode(remote_id_bytes).map_err(|e| SignalError::InvalidKey {
                    reason: format!("remote identity key: {e}"),
                })?;
            existing_identity != sender_identity_key
        } else {
            false
        };

        Ok(DecryptPreKeyResult {
            plaintext,
            updated_session_record: updated_session_bytes,
            sender_identity_key: sender_identity_key.serialize().to_vec(),
            identity_changed,
            consumed_pre_key_id,
            consumed_kyber_pre_key_id,
        })
    })
}
