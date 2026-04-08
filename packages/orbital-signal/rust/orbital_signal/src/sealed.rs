use crate::error::SignalError;
use crate::types::{ProtocolAddressData, SealedSenderResult};

// Sealed sender functions require both store adapters AND backend certificate infrastructure.

/// Encrypt a message using Sealed Sender (metadata-hiding).
#[uniffi::export]
pub async fn sealed_sender_encrypt(
    _plaintext: Vec<u8>,
    _remote_address: ProtocolAddressData,
    _sender_certificate: Vec<u8>,
) -> Result<Vec<u8>, SignalError> {
    Err(SignalError::InternalError {
        reason: "sealed_sender_encrypt: pending store adapter + certificate integration"
            .to_string(),
    })
}

/// Decrypt a Sealed Sender message, revealing the sender's identity.
#[uniffi::export]
pub async fn sealed_sender_decrypt(
    _ciphertext: Vec<u8>,
    _local_address: ProtocolAddressData,
) -> Result<SealedSenderResult, SignalError> {
    Err(SignalError::InternalError {
        reason: "sealed_sender_decrypt: pending store adapter + certificate integration"
            .to_string(),
    })
}
