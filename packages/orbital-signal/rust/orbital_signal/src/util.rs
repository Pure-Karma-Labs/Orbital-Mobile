use crate::error::SignalError;
use crate::types::{
    KyberPreKeyPublicData, PreKeyPublicData, ProtocolAddressData, SignedPreKeyPublicData,
};

use libsignal_protocol::{GenericSignedPreKey, KyberPreKeyRecord, PreKeyRecord, SignedPreKeyRecord};

/// Extract the public key and ID from a serialized PreKeyRecord for server upload.
#[uniffi::export]
pub fn get_pre_key_public(pre_key_record: Vec<u8>) -> Result<PreKeyPublicData, SignalError> {
    let record = PreKeyRecord::deserialize(&pre_key_record).map_err(SignalError::from)?;
    Ok(PreKeyPublicData {
        id: record.id().map_err(SignalError::from)?.into(),
        public_key: record
            .public_key()
            .map_err(SignalError::from)?
            .serialize()
            .to_vec(),
    })
}

/// Extract the public key, signature, ID, and timestamp from a serialized SignedPreKeyRecord.
#[uniffi::export]
pub fn get_signed_pre_key_public(
    signed_pre_key_record: Vec<u8>,
) -> Result<SignedPreKeyPublicData, SignalError> {
    let record =
        SignedPreKeyRecord::deserialize(&signed_pre_key_record).map_err(SignalError::from)?;
    Ok(SignedPreKeyPublicData {
        id: record.id().map_err(SignalError::from)?.into(),
        public_key: record
            .public_key()
            .map_err(SignalError::from)?
            .serialize()
            .to_vec(),
        signature: record.signature().map_err(SignalError::from)?,
        timestamp: record.timestamp().map_err(SignalError::from)?.epoch_millis(),
    })
}

/// Extract the public key, signature, and ID from a serialized KyberPreKeyRecord.
#[uniffi::export]
pub fn get_kyber_pre_key_public(
    kyber_pre_key_record: Vec<u8>,
) -> Result<KyberPreKeyPublicData, SignalError> {
    let record =
        KyberPreKeyRecord::deserialize(&kyber_pre_key_record).map_err(SignalError::from)?;
    Ok(KyberPreKeyPublicData {
        id: record.id().map_err(SignalError::from)?.into(),
        public_key: record
            .public_key()
            .map_err(SignalError::from)?
            .serialize()
            .to_vec(),
        signature: record.signature().map_err(SignalError::from)?,
    })
}

/// Construct a ProtocolAddressData (convenience helper).
#[uniffi::export]
pub fn create_protocol_address(name: String, device_id: u32) -> ProtocolAddressData {
    ProtocolAddressData { name, device_id }
}
