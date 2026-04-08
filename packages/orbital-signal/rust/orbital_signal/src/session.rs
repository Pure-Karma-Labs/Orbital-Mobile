use crate::error::SignalError;
use crate::types::{CiphertextMessageData, PreKeyBundleData, ProtocolAddressData};

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

/// Encrypt a message using the Double Ratchet protocol.
#[uniffi::export]
pub async fn signal_encrypt(
    _plaintext: Vec<u8>,
    _remote_address: ProtocolAddressData,
) -> Result<CiphertextMessageData, SignalError> {
    Err(SignalError::InternalError {
        reason: "signal_encrypt: pending store adapter integration".to_string(),
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
