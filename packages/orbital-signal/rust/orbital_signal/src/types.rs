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

/// Preloaded input for encryption — all store data passed as records (no callback interfaces).
/// This is the "preloaded store" pattern: JS reads stores, passes data in, Rust does crypto,
/// returns results + any updated state for JS to write back.
#[derive(Debug, Clone, uniffi::Record)]
pub struct EncryptInput {
    /// Our identity key pair (public + private DER bytes).
    pub identity_key_pair: IdentityKeyPairData,
    /// Our local registration ID.
    pub registration_id: u32,
    /// Serialized SessionRecord for the remote address (from session store), or empty if none.
    pub session_record: Option<Vec<u8>>,
    /// Remote party's identity key (serialized IdentityKey).
    pub remote_identity: Option<Vec<u8>>,
    /// Remote address to encrypt to.
    pub remote_address: ProtocolAddressData,
    /// Plaintext message bytes.
    pub plaintext: Vec<u8>,
}

/// Result of the preloaded encryption operation.
#[derive(Debug, Clone, uniffi::Record)]
pub struct EncryptResult {
    /// The ciphertext message (type + serialized bytes).
    pub ciphertext: CiphertextMessageData,
    /// Updated session record bytes — JS must write this back to the session store.
    pub updated_session_record: Vec<u8>,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct RoundtripResult {
    pub plaintext: Vec<u8>,
    pub ciphertext_len: u32,
    pub decrypted: Vec<u8>,
    pub success: bool,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct RoundtripBatchResult {
    pub success_count: u32,
    pub total_elapsed_ms: u64,
    pub avg_elapsed_ms: u64,
}
