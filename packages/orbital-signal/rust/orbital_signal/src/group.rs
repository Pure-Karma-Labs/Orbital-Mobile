use crate::error::SignalError;
use crate::types::ProtocolAddressData;

// Store-dependent functions: API surface defined, implementation pending store adapter layer.

/// Create a Sender Key Distribution Message for group messaging.
#[uniffi::export]
pub async fn create_sender_key_distribution_message(
    _sender: ProtocolAddressData,
    _distribution_id: String,
) -> Result<Vec<u8>, SignalError> {
    Err(SignalError::InternalError {
        reason: "create_sender_key_distribution_message: pending store adapter integration"
            .to_string(),
    })
}

/// Process an incoming Sender Key Distribution Message.
#[uniffi::export]
pub async fn process_sender_key_distribution_message(
    _sender: ProtocolAddressData,
    _distribution_message: Vec<u8>,
) -> Result<(), SignalError> {
    Err(SignalError::InternalError {
        reason: "process_sender_key_distribution_message: pending store adapter integration"
            .to_string(),
    })
}

/// Encrypt a message for a group using Sender Keys.
#[uniffi::export]
pub async fn group_encrypt(
    _plaintext: Vec<u8>,
    _sender: ProtocolAddressData,
    _distribution_id: String,
) -> Result<Vec<u8>, SignalError> {
    Err(SignalError::InternalError {
        reason: "group_encrypt: pending store adapter integration".to_string(),
    })
}

/// Decrypt a group message using Sender Keys.
#[uniffi::export]
pub async fn group_decrypt(
    _ciphertext: Vec<u8>,
    _sender: ProtocolAddressData,
) -> Result<Vec<u8>, SignalError> {
    Err(SignalError::InternalError {
        reason: "group_decrypt: pending store adapter integration".to_string(),
    })
}
