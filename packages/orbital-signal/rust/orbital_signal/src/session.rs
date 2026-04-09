use std::time::SystemTime;

use libsignal_protocol::{
    CiphertextMessage, IdentityKey, IdentityKeyPair, IdentityKeyStore, InMemSignalProtocolStore,
    PublicKey, SessionRecord, SessionStore,
};

use crate::error::SignalError;
use crate::store_adapters::to_protocol_address;
use crate::types::{
    CiphertextMessageData, CiphertextMessageType, EncryptInput, EncryptResult, PreKeyBundleData,
    ProtocolAddressData,
};

// Store-dependent functions: API surface defined, implementation pending store adapter layer.
// See client.rs for details on the FfiConverterArc / async_trait(?Send) blockers.

/// Perform X3DH key agreement to establish an outgoing session.
#[uniffi::export]
pub async fn process_pre_key_bundle(
    _bundle: PreKeyBundleData,
    _remote_address: ProtocolAddressData,
) -> Result<(), SignalError> {
    Err(SignalError::InternalError {
        reason: "process_pre_key_bundle: pending store adapter integration".to_string(),
    })
}

/// Encrypt a message using the Double Ratchet protocol (preloaded store pattern).
///
/// Instead of accepting callback interface store params (which uniffi 0.31 does not support
/// for exported functions), this function accepts all needed store data as a flat record.
/// The caller (TypeScript) reads the stores before calling, and writes back the
/// updated session record after the call returns.
///
/// ## Issue #58 spike result
/// uniffi 0.31.0 does NOT generate `FfiConverterArc` impls for callback interface traits,
/// so `Arc<dyn OrbitalIdentityKeyStore>` cannot be used as a parameter in `#[uniffi::export]`
/// functions (same error as Object constructors). The preloaded store pattern is the
/// confirmed workaround.
#[uniffi::export]
pub fn signal_encrypt(input: EncryptInput) -> Result<EncryptResult, SignalError> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| SignalError::InternalError {
            reason: format!("tokio runtime: {e}"),
        })?;

    rt.block_on(async {
        // Reconstruct identity key pair from raw bytes
        let public_key = PublicKey::deserialize(&input.identity_key_pair.public_key)
            .map_err(|e| SignalError::InvalidKey {
                reason: format!("identity public key: {e}"),
            })?;
        let private_key =
            libsignal_protocol::PrivateKey::deserialize(&input.identity_key_pair.private_key)
                .map_err(|e| SignalError::InvalidKey {
                    reason: format!("identity private key: {e}"),
                })?;
        let identity_key_pair =
            IdentityKeyPair::new(IdentityKey::new(public_key), private_key);

        // Create in-memory store pre-loaded with our identity
        let mut store = InMemSignalProtocolStore::new(identity_key_pair, input.registration_id)
            .map_err(|e| SignalError::InternalError {
                reason: format!("failed to create in-memory store: {e}"),
            })?;

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
            .ok_or_else(|| SignalError::NoSession)?;

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

/// Decrypt a normal Signal protocol message.
#[uniffi::export]
pub async fn signal_decrypt(
    _ciphertext: Vec<u8>,
    _sender_address: ProtocolAddressData,
) -> Result<Vec<u8>, SignalError> {
    Err(SignalError::InternalError {
        reason: "signal_decrypt: pending store adapter integration".to_string(),
    })
}

/// Decrypt a pre-key Signal message (establishes a new session).
#[uniffi::export]
pub async fn signal_decrypt_pre_key(
    _ciphertext: Vec<u8>,
    _sender_address: ProtocolAddressData,
) -> Result<Vec<u8>, SignalError> {
    Err(SignalError::InternalError {
        reason: "signal_decrypt_pre_key: pending store adapter integration".to_string(),
    })
}
