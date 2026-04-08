use libsignal_core::curve::CurveError;
use libsignal_protocol::SignalProtocolError;

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

impl From<SignalProtocolError> for SignalError {
    fn from(err: SignalProtocolError) -> Self {
        match &err {
            SignalProtocolError::InvalidArgument(_) => SignalError::InvalidArgument {
                reason: err.to_string(),
            },
            SignalProtocolError::InvalidState(_, _) => SignalError::InternalError {
                reason: err.to_string(),
            },
            SignalProtocolError::InvalidProtobufEncoding => SignalError::InvalidMessage {
                reason: "invalid protobuf encoding".to_string(),
            },
            SignalProtocolError::InvalidPreKeyId
            | SignalProtocolError::InvalidSignedPreKeyId
            | SignalProtocolError::InvalidKyberPreKeyId => SignalError::InvalidKey {
                reason: err.to_string(),
            },
            SignalProtocolError::NoKeyTypeIdentifier
            | SignalProtocolError::BadKeyType(_)
            | SignalProtocolError::BadKeyLength(_, _)
            | SignalProtocolError::BadKEMKeyType(_)
            | SignalProtocolError::WrongKEMKeyType(_, _)
            | SignalProtocolError::BadKEMKeyLength(_, _)
            | SignalProtocolError::BadKEMCiphertextLength(_, _) => SignalError::InvalidKey {
                reason: err.to_string(),
            },
            SignalProtocolError::SignatureValidationFailed => SignalError::InvalidSignature,
            SignalProtocolError::UntrustedIdentity(_) => SignalError::UntrustedIdentity {
                address: err.to_string(),
            },
            SignalProtocolError::InvalidSessionStructure(_) => SignalError::NoSession,
            SignalProtocolError::SessionNotFound(_) => SignalError::NoSession,
            SignalProtocolError::NoSenderKeyState { .. }
            | SignalProtocolError::InvalidSenderKeySession { .. } => SignalError::NoSession,
            SignalProtocolError::DuplicatedMessage(..) => SignalError::DuplicateMessage,
            SignalProtocolError::InvalidMessage(..) => SignalError::InvalidMessage {
                reason: err.to_string(),
            },
            SignalProtocolError::CiphertextMessageTooShort(_)
            | SignalProtocolError::LegacyCiphertextVersion(_)
            | SignalProtocolError::UnrecognizedCiphertextVersion(_)
            | SignalProtocolError::UnrecognizedMessageVersion(_) => SignalError::InvalidMessage {
                reason: err.to_string(),
            },
            SignalProtocolError::InvalidSealedSenderMessage(_)
            | SignalProtocolError::UnknownSealedSenderVersion(_)
            | SignalProtocolError::UnknownSealedSenderServerCertificateId(_) => {
                SignalError::InvalidCertificate {
                    reason: err.to_string(),
                }
            }
            SignalProtocolError::SealedSenderSelfSend => SignalError::InvalidMessage {
                reason: "sealed sender self-send".to_string(),
            },
            SignalProtocolError::FfiBindingError(_) => SignalError::InternalError {
                reason: err.to_string(),
            },
            SignalProtocolError::ApplicationCallbackError(_, _) => SignalError::StoreError {
                reason: err.to_string(),
            },
            SignalProtocolError::InvalidMacKeyLength(_) => SignalError::InvalidKey {
                reason: err.to_string(),
            },
            SignalProtocolError::InvalidRegistrationId(_, _) => SignalError::InvalidArgument {
                reason: err.to_string(),
            },
            SignalProtocolError::InvalidProtocolAddress { .. } => SignalError::InvalidArgument {
                reason: err.to_string(),
            },
            #[allow(unreachable_patterns)]
            _ => SignalError::InternalError {
                reason: err.to_string(),
            },
        }
    }
}

impl From<CurveError> for SignalError {
    fn from(err: CurveError) -> Self {
        // CurveError converts to SignalProtocolError, which we already handle
        SignalError::from(SignalProtocolError::from(err))
    }
}
