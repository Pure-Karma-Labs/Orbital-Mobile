#[derive(Debug, Clone, uniffi::Record)]
pub struct ProtocolAddressData {
    pub name: String,
    pub device_id: u32,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct IdentityKeyPairData {
    pub public_key: Vec<u8>,
    pub private_key: Vec<u8>,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct PreKeyBundleData {
    pub registration_id: u32,
    pub device_id: u32,
    pub pre_key_id: Option<u32>,
    pub pre_key_public: Option<Vec<u8>>,
    pub signed_pre_key_id: u32,
    pub signed_pre_key_public: Vec<u8>,
    pub signed_pre_key_signature: Vec<u8>,
    pub identity_key: Vec<u8>,
    pub kyber_pre_key_id: Option<u32>,
    pub kyber_pre_key_public: Option<Vec<u8>>,
    pub kyber_pre_key_signature: Option<Vec<u8>>,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct CiphertextMessageData {
    pub message_type: CiphertextMessageType,
    pub serialized: Vec<u8>,
}

#[derive(Debug, Clone, uniffi::Enum)]
pub enum CiphertextMessageType {
    Whisper,
    PreKey,
    SenderKey,
    Plaintext,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct SealedSenderResult {
    pub sender_service_id: String,
    pub sender_device_id: u32,
    pub message: Vec<u8>,
    pub content_hint: u32,
}

#[derive(Debug, Clone, uniffi::Enum)]
pub enum Direction {
    Sending,
    Receiving,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct PreKeyPublicData {
    pub id: u32,
    pub public_key: Vec<u8>,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct SignedPreKeyPublicData {
    pub id: u32,
    pub public_key: Vec<u8>,
    pub signature: Vec<u8>,
    pub timestamp: u64,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct KyberPreKeyPublicData {
    pub id: u32,
    pub public_key: Vec<u8>,
    pub signature: Vec<u8>,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct KyberPreKeyResult {
    pub record: Vec<u8>,
    pub is_last_resort: bool,
}
