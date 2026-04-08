//! Adapters bridging our uniffi callback interfaces to libsignal's async store traits.
//!
//! Our callback interfaces (defined in stores.rs) use synchronous methods with FFI-safe types.
//! libsignal expects async store traits with its own types. These adapters bridge the gap.

use std::sync::Arc;

use async_trait::async_trait;
use uuid::Uuid;

use libsignal_core::DeviceId;
use libsignal_protocol::{
    self as signal, GenericSignedPreKey, IdentityChange, IdentityKey, IdentityKeyPair,
    KyberPreKeyId, KyberPreKeyRecord, PreKeyId, PreKeyRecord, ProtocolAddress, PublicKey,
    SenderKeyRecord, SessionRecord, SignedPreKeyId, SignedPreKeyRecord,
};

type SignalResult<T> = Result<T, signal::SignalProtocolError>;

use crate::stores::{
    OrbitalIdentityKeyStore, OrbitalKyberPreKeyStore, OrbitalPreKeyStore, OrbitalSenderKeyStore,
    OrbitalSessionStore, OrbitalSignedPreKeyStore,
};
use crate::types::{Direction, ProtocolAddressData};

fn to_address_data(addr: &ProtocolAddress) -> ProtocolAddressData {
    ProtocolAddressData {
        name: addr.name().to_string(),
        device_id: u32::from(addr.device_id()),
    }
}

fn to_protocol_address(data: &ProtocolAddressData) -> ProtocolAddress {
    // DeviceId is NonZeroU8; clamp to valid range (1-127), default to 1
    let device_id = DeviceId::new(data.device_id.min(127).max(1) as u8)
        .unwrap_or(DeviceId::new(1).unwrap());
    ProtocolAddress::new(data.name.clone(), device_id)
}

// --- Identity Key Store Adapter ---

pub struct IdentityKeyStoreAdapter {
    pub inner: Arc<dyn OrbitalIdentityKeyStore>,
}

#[async_trait(?Send)]
impl signal::IdentityKeyStore for IdentityKeyStoreAdapter {
    async fn get_identity_key_pair(&self) -> SignalResult<IdentityKeyPair> {
        let data = self
            .inner
            .get_identity_key_pair()
            .map_err(|e| signal::SignalProtocolError::ApplicationCallbackError("identity", Box::new(e)))?;
        let public = PublicKey::deserialize(&data.public_key)?;
        let private = signal::PrivateKey::deserialize(&data.private_key)?;
        Ok(IdentityKeyPair::new(IdentityKey::new(public), private))
    }

    async fn get_local_registration_id(&self) -> SignalResult<u32> {
        self.inner
            .get_local_registration_id()
            .map_err(|e| signal::SignalProtocolError::ApplicationCallbackError("identity", Box::new(e)))
    }

    async fn save_identity(
        &mut self,
        address: &ProtocolAddress,
        identity: &IdentityKey,
    ) -> SignalResult<IdentityChange> {
        let changed = self
            .inner
            .save_identity(to_address_data(address), identity.serialize().to_vec())
            .map_err(|e| signal::SignalProtocolError::ApplicationCallbackError("identity", Box::new(e)))?;
        Ok(IdentityChange::from_changed(changed))
    }

    async fn is_trusted_identity(
        &self,
        address: &ProtocolAddress,
        identity: &IdentityKey,
        direction: signal::Direction,
    ) -> SignalResult<bool> {
        let dir = match direction {
            signal::Direction::Sending => Direction::Sending,
            signal::Direction::Receiving => Direction::Receiving,
        };
        self.inner
            .is_trusted_identity(
                to_address_data(address),
                identity.serialize().to_vec(),
                dir,
            )
            .map_err(|e| signal::SignalProtocolError::ApplicationCallbackError("identity", Box::new(e)))
    }

    async fn get_identity(
        &self,
        address: &ProtocolAddress,
    ) -> SignalResult<Option<IdentityKey>> {
        let data = self
            .inner
            .get_identity(to_address_data(address))
            .map_err(|e| signal::SignalProtocolError::ApplicationCallbackError("identity", Box::new(e)))?;
        match data {
            Some(bytes) => Ok(Some(IdentityKey::decode(&bytes)?)),
            None => Ok(None),
        }
    }
}

// --- Session Store Adapter ---

pub struct SessionStoreAdapter {
    pub inner: Arc<dyn OrbitalSessionStore>,
}

#[async_trait(?Send)]
impl signal::SessionStore for SessionStoreAdapter {
    async fn load_session(
        &self,
        address: &ProtocolAddress,
    ) -> SignalResult<Option<SessionRecord>> {
        let data = self
            .inner
            .load_session(to_address_data(address))
            .map_err(|e| signal::SignalProtocolError::ApplicationCallbackError("session", Box::new(e)))?;
        match data {
            Some(bytes) => Ok(Some(SessionRecord::deserialize(&bytes)?)),
            None => Ok(None),
        }
    }

    async fn store_session(
        &mut self,
        address: &ProtocolAddress,
        record: &SessionRecord,
    ) -> SignalResult<()> {
        let bytes = record.serialize()?;
        self.inner
            .store_session(to_address_data(address), bytes)
            .map_err(|e| signal::SignalProtocolError::ApplicationCallbackError("session", Box::new(e)))
    }
}

// --- PreKey Store Adapter ---

pub struct PreKeyStoreAdapter {
    pub inner: Arc<dyn OrbitalPreKeyStore>,
}

#[async_trait(?Send)]
impl signal::PreKeyStore for PreKeyStoreAdapter {
    async fn get_pre_key(&self, prekey_id: PreKeyId) -> SignalResult<PreKeyRecord> {
        let data = self
            .inner
            .load_pre_key(prekey_id.into())
            .map_err(|e| signal::SignalProtocolError::ApplicationCallbackError("prekey", Box::new(e)))?;
        match data {
            Some(bytes) => Ok(PreKeyRecord::deserialize(&bytes)?),
            None => Err(signal::SignalProtocolError::InvalidPreKeyId),
        }
    }

    async fn save_pre_key(
        &mut self,
        prekey_id: PreKeyId,
        record: &PreKeyRecord,
    ) -> SignalResult<()> {
        let bytes = record.serialize()?;
        self.inner
            .store_pre_key(prekey_id.into(), bytes)
            .map_err(|e| signal::SignalProtocolError::ApplicationCallbackError("prekey", Box::new(e)))
    }

    async fn remove_pre_key(&mut self, prekey_id: PreKeyId) -> SignalResult<()> {
        self.inner
            .remove_pre_key(prekey_id.into())
            .map_err(|e| signal::SignalProtocolError::ApplicationCallbackError("prekey", Box::new(e)))
    }
}

// --- Signed PreKey Store Adapter ---

pub struct SignedPreKeyStoreAdapter {
    pub inner: Arc<dyn OrbitalSignedPreKeyStore>,
}

#[async_trait(?Send)]
impl signal::SignedPreKeyStore for SignedPreKeyStoreAdapter {
    async fn get_signed_pre_key(
        &self,
        id: SignedPreKeyId,
    ) -> SignalResult<SignedPreKeyRecord> {
        let data = self
            .inner
            .load_signed_pre_key(id.into())
            .map_err(|e| signal::SignalProtocolError::ApplicationCallbackError("signed_prekey", Box::new(e)))?;
        match data {
            Some(bytes) => Ok(SignedPreKeyRecord::deserialize(&bytes)?),
            None => Err(signal::SignalProtocolError::InvalidSignedPreKeyId),
        }
    }

    async fn save_signed_pre_key(
        &mut self,
        id: SignedPreKeyId,
        record: &SignedPreKeyRecord,
    ) -> SignalResult<()> {
        let bytes = record.serialize()?;
        self.inner
            .store_signed_pre_key(id.into(), bytes)
            .map_err(|e| signal::SignalProtocolError::ApplicationCallbackError("signed_prekey", Box::new(e)))
    }
}

// --- Kyber PreKey Store Adapter ---

pub struct KyberPreKeyStoreAdapter {
    pub inner: Arc<dyn OrbitalKyberPreKeyStore>,
}

#[async_trait(?Send)]
impl signal::KyberPreKeyStore for KyberPreKeyStoreAdapter {
    async fn get_kyber_pre_key(
        &self,
        id: KyberPreKeyId,
    ) -> SignalResult<KyberPreKeyRecord> {
        let data = self
            .inner
            .load_kyber_pre_key(id.into())
            .map_err(|e| signal::SignalProtocolError::ApplicationCallbackError("kyber_prekey", Box::new(e)))?;
        match data {
            Some(bytes) => Ok(KyberPreKeyRecord::deserialize(&bytes)?),
            None => Err(signal::SignalProtocolError::InvalidKyberPreKeyId),
        }
    }

    async fn save_kyber_pre_key(
        &mut self,
        id: KyberPreKeyId,
        record: &KyberPreKeyRecord,
    ) -> SignalResult<()> {
        let bytes = record.serialize()?;
        self.inner
            .store_kyber_pre_key(id.into(), bytes)
            .map_err(|e| signal::SignalProtocolError::ApplicationCallbackError("kyber_prekey", Box::new(e)))
    }

    async fn mark_kyber_pre_key_used(
        &mut self,
        id: KyberPreKeyId,
        _ec_prekey_id: SignedPreKeyId,
        _base_key: &PublicKey,
    ) -> SignalResult<()> {
        self.inner
            .mark_kyber_pre_key_used(id.into())
            .map_err(|e| signal::SignalProtocolError::ApplicationCallbackError("kyber_prekey", Box::new(e)))
    }
}

// --- Sender Key Store Adapter ---

pub struct SenderKeyStoreAdapter {
    pub inner: Arc<dyn OrbitalSenderKeyStore>,
}

#[async_trait(?Send)]
impl signal::SenderKeyStore for SenderKeyStoreAdapter {
    async fn store_sender_key(
        &mut self,
        sender: &ProtocolAddress,
        distribution_id: Uuid,
        record: &SenderKeyRecord,
    ) -> SignalResult<()> {
        let bytes = record.serialize()?;
        self.inner
            .store_sender_key(
                to_address_data(sender),
                distribution_id.to_string(),
                bytes,
            )
            .map_err(|e| signal::SignalProtocolError::ApplicationCallbackError("sender_key", Box::new(e)))
    }

    async fn load_sender_key(
        &mut self,
        sender: &ProtocolAddress,
        distribution_id: Uuid,
    ) -> SignalResult<Option<SenderKeyRecord>> {
        let data = self
            .inner
            .load_sender_key(to_address_data(sender), distribution_id.to_string())
            .map_err(|e| signal::SignalProtocolError::ApplicationCallbackError("sender_key", Box::new(e)))?;
        match data {
            Some(bytes) => Ok(Some(SenderKeyRecord::deserialize(&bytes)?)),
            None => Ok(None),
        }
    }
}

// --- Public helpers for creating adapters ---

pub(crate) fn addr_to_data(addr: &ProtocolAddress) -> ProtocolAddressData {
    to_address_data(addr)
}

pub(crate) fn data_to_addr(data: &ProtocolAddressData) -> ProtocolAddress {
    to_protocol_address(data)
}
