use crate::error::SignalError;
use crate::types::{IdentityKeyPairData, KyberPreKeyResult};

use libsignal_protocol::{GenericSignedPreKey, IdentityKeyPair, KeyPair};

/// Generate a new identity key pair (Curve25519).
#[uniffi::export]
pub fn generate_identity_key_pair() -> IdentityKeyPairData {
    let mut csprng = rand::rng();
    let key_pair = IdentityKeyPair::generate(&mut csprng);
    IdentityKeyPairData {
        public_key: key_pair.identity_key().serialize().to_vec(),
        private_key: key_pair.private_key().serialize().to_vec(),
    }
}

/// Generate a one-time pre-key. Returns serialized PreKeyRecord bytes.
#[uniffi::export]
pub fn generate_pre_key(id: u32) -> Result<Vec<u8>, SignalError> {
    let mut csprng = rand::rng();
    let key_pair = KeyPair::generate(&mut csprng);
    let record = libsignal_protocol::PreKeyRecord::new(id.into(), &key_pair);
    record.serialize().map_err(SignalError::from)
}

/// Generate a signed pre-key. Returns serialized SignedPreKeyRecord bytes.
#[uniffi::export]
pub fn generate_signed_pre_key(
    id: u32,
    identity_key_pair: IdentityKeyPairData,
    timestamp: u64,
) -> Result<Vec<u8>, SignalError> {
    let mut csprng = rand::rng();
    let ikp = deserialize_identity_key_pair(&identity_key_pair)?;
    let key_pair = KeyPair::generate(&mut csprng);
    let signature = ikp
        .private_key()
        .calculate_signature(&key_pair.public_key.serialize(), &mut csprng)
        .map_err(SignalError::from)?;
    let record = libsignal_protocol::SignedPreKeyRecord::new(
        id.into(),
        libsignal_protocol::Timestamp::from_epoch_millis(timestamp),
        &key_pair,
        &signature,
    );
    record.serialize().map_err(SignalError::from)
}

/// Generate a Kyber (post-quantum) pre-key. Returns both the serialized KyberPreKeyRecord
/// bytes and the `is_last_resort` flag, since the record itself does not store this flag
/// (it is a storage-layer concern that the TypeScript caller must persist separately).
#[uniffi::export]
pub async fn generate_kyber_pre_key(
    id: u32,
    identity_key_pair: IdentityKeyPairData,
    timestamp: u64,
    is_last_resort: bool,
) -> Result<KyberPreKeyResult, SignalError> {
    let mut csprng = rand::rng();
    let ikp = deserialize_identity_key_pair(&identity_key_pair)?;
    let kyber_key_pair = libsignal_protocol::kem::KeyPair::generate(
        libsignal_protocol::kem::KeyType::Kyber1024,
        &mut csprng,
    );
    let signature = ikp
        .private_key()
        .calculate_signature(&kyber_key_pair.public_key.serialize(), &mut csprng)
        .map_err(SignalError::from)?;
    let record = libsignal_protocol::KyberPreKeyRecord::new(
        id.into(),
        libsignal_protocol::Timestamp::from_epoch_millis(timestamp),
        &kyber_key_pair,
        &signature,
    );
    let serialized = record.serialize().map_err(SignalError::from)?;
    Ok(KyberPreKeyResult {
        record: serialized,
        is_last_resort,
    })
}

/// Helper to deserialize an IdentityKeyPairData back into libsignal's IdentityKeyPair.
pub(crate) fn deserialize_identity_key_pair(
    data: &IdentityKeyPairData,
) -> Result<IdentityKeyPair, SignalError> {
    let public_key = libsignal_protocol::PublicKey::deserialize(&data.public_key).map_err(|e| {
        SignalError::InvalidKey {
            reason: format!("invalid public key: {e}"),
        }
    })?;
    let private_key =
        libsignal_protocol::PrivateKey::deserialize(&data.private_key).map_err(|e| {
            SignalError::InvalidKey {
                reason: format!("invalid private key: {e}"),
            }
        })?;
    let identity_key = libsignal_protocol::IdentityKey::new(public_key);
    Ok(IdentityKeyPair::new(identity_key, private_key))
}
