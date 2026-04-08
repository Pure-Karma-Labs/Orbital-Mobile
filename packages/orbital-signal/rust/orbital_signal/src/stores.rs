use crate::error::SignalError;
use crate::types::{Direction, IdentityKeyPairData, ProtocolAddressData};

/// Identity key storage — manages our key pair and trust decisions for remote keys.
#[uniffi::export(callback_interface)]
pub trait OrbitalIdentityKeyStore: Send + Sync {
    fn get_identity_key_pair(&self) -> Result<IdentityKeyPairData, SignalError>;
    fn get_local_registration_id(&self) -> Result<u32, SignalError>;
    fn save_identity(
        &self,
        address: ProtocolAddressData,
        identity_key: Vec<u8>,
    ) -> Result<bool, SignalError>;
    fn is_trusted_identity(
        &self,
        address: ProtocolAddressData,
        identity_key: Vec<u8>,
        direction: Direction,
    ) -> Result<bool, SignalError>;
    fn get_identity(&self, address: ProtocolAddressData) -> Result<Option<Vec<u8>>, SignalError>;
}

/// Session storage — Double Ratchet session state.
#[uniffi::export(callback_interface)]
pub trait OrbitalSessionStore: Send + Sync {
    fn load_session(&self, address: ProtocolAddressData) -> Result<Option<Vec<u8>>, SignalError>;
    fn store_session(
        &self,
        address: ProtocolAddressData,
        record: Vec<u8>,
    ) -> Result<(), SignalError>;
}

/// One-time pre-key storage.
#[uniffi::export(callback_interface)]
pub trait OrbitalPreKeyStore: Send + Sync {
    fn load_pre_key(&self, id: u32) -> Result<Option<Vec<u8>>, SignalError>;
    fn store_pre_key(&self, id: u32, record: Vec<u8>) -> Result<(), SignalError>;
    fn remove_pre_key(&self, id: u32) -> Result<(), SignalError>;
}

/// Signed pre-key storage (rotated every 30 days).
#[uniffi::export(callback_interface)]
pub trait OrbitalSignedPreKeyStore: Send + Sync {
    fn load_signed_pre_key(&self, id: u32) -> Result<Option<Vec<u8>>, SignalError>;
    fn store_signed_pre_key(&self, id: u32, record: Vec<u8>) -> Result<(), SignalError>;
}

/// Kyber (post-quantum) pre-key storage.
#[uniffi::export(callback_interface)]
pub trait OrbitalKyberPreKeyStore: Send + Sync {
    fn load_kyber_pre_key(&self, id: u32) -> Result<Option<Vec<u8>>, SignalError>;
    fn store_kyber_pre_key(&self, id: u32, record: Vec<u8>) -> Result<(), SignalError>;
    fn mark_kyber_pre_key_used(&self, id: u32) -> Result<(), SignalError>;
}

/// Sender Key storage for group messaging.
#[uniffi::export(callback_interface)]
pub trait OrbitalSenderKeyStore: Send + Sync {
    fn store_sender_key(
        &self,
        sender: ProtocolAddressData,
        distribution_id: String,
        record: Vec<u8>,
    ) -> Result<(), SignalError>;
    fn load_sender_key(
        &self,
        sender: ProtocolAddressData,
        distribution_id: String,
    ) -> Result<Option<Vec<u8>>, SignalError>;
}
