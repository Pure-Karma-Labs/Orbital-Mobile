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

// ---------------------------------------------------------------------------
// Preloaded store Input/Result types for session operations (Issue #17)
// ---------------------------------------------------------------------------

/// Input for processing a pre-key bundle (X3DH key agreement to establish outgoing session).
#[derive(Debug, Clone, uniffi::Record)]
pub struct ProcessPreKeyBundleInput {
    pub identity_key_pair: IdentityKeyPairData,
    pub registration_id: u32,
    pub remote_address: ProtocolAddressData,
    pub bundle: PreKeyBundleData,
    pub existing_session_record: Option<Vec<u8>>,
    pub remote_identity: Option<Vec<u8>>,
}

/// Result of processing a pre-key bundle.
#[derive(Debug, Clone, uniffi::Record)]
pub struct ProcessPreKeyBundleResult {
    pub updated_session_record: Vec<u8>,
    pub identity_key: Vec<u8>,
    pub identity_changed: bool,
}

/// Input for decrypting a standard Signal message (not pre-key).
#[derive(Debug, Clone, uniffi::Record)]
pub struct DecryptInput {
    pub identity_key_pair: IdentityKeyPairData,
    pub registration_id: u32,
    pub sender_address: ProtocolAddressData,
    pub session_record: Vec<u8>,
    pub remote_identity: Option<Vec<u8>>,
    pub ciphertext: Vec<u8>,
}

/// Result of decrypting a standard Signal message.
#[derive(Debug, Clone, uniffi::Record)]
pub struct DecryptResult {
    pub plaintext: Vec<u8>,
    pub updated_session_record: Vec<u8>,
}

/// Input for decrypting a pre-key Signal message (establishes new session).
#[derive(Debug, Clone, uniffi::Record)]
pub struct DecryptPreKeyInput {
    pub identity_key_pair: IdentityKeyPairData,
    pub registration_id: u32,
    pub sender_address: ProtocolAddressData,
    pub existing_session_record: Option<Vec<u8>>,
    pub remote_identity: Option<Vec<u8>>,
    pub pre_key_record: Option<Vec<u8>>,
    pub signed_pre_key_record: Vec<u8>,
    pub kyber_pre_key_record: Option<Vec<u8>>,
    pub ciphertext: Vec<u8>,
}

/// Result of decrypting a pre-key Signal message.
#[derive(Debug, Clone, uniffi::Record)]
pub struct DecryptPreKeyResult {
    pub plaintext: Vec<u8>,
    pub updated_session_record: Vec<u8>,
    pub sender_identity_key: Vec<u8>,
    pub identity_changed: bool,
    pub consumed_pre_key_id: Option<u32>,
    pub consumed_kyber_pre_key_id: Option<u32>,
}

/// Parsed pre-key IDs from a PreKeySignalMessage (pure parsing, no crypto).
#[derive(Debug, Clone, uniffi::Record)]
pub struct PreKeyMessageIds {
    pub pre_key_id: Option<u32>,
    pub signed_pre_key_id: u32,
    pub kyber_pre_key_id: Option<u32>,
}

// ---------------------------------------------------------------------------
// Preloaded store Input/Result types for group operations (Issue #17)
// ---------------------------------------------------------------------------

/// Input for group encryption using sender keys.
#[derive(Debug, Clone, uniffi::Record)]
pub struct GroupEncryptInput {
    pub sender_address: ProtocolAddressData,
    pub distribution_id: String,
    pub sender_key_record: Option<Vec<u8>>,
    pub plaintext: Vec<u8>,
}

/// Result of group encryption.
#[derive(Debug, Clone, uniffi::Record)]
pub struct GroupEncryptResult {
    pub ciphertext: Vec<u8>,
    pub updated_sender_key_record: Vec<u8>,
}

/// Input for group decryption using sender keys.
#[derive(Debug, Clone, uniffi::Record)]
pub struct GroupDecryptInput {
    pub sender_address: ProtocolAddressData,
    pub sender_key_record: Option<Vec<u8>>,
    pub ciphertext: Vec<u8>,
}

/// Result of group decryption.
#[derive(Debug, Clone, uniffi::Record)]
pub struct GroupDecryptResult {
    pub plaintext: Vec<u8>,
    pub updated_sender_key_record: Vec<u8>,
}

/// Input for creating a sender key distribution message.
#[derive(Debug, Clone, uniffi::Record)]
pub struct CreateSenderKeyDistributionInput {
    pub sender_address: ProtocolAddressData,
    pub distribution_id: String,
    pub sender_key_record: Option<Vec<u8>>,
}

/// Result of creating a sender key distribution message.
#[derive(Debug, Clone, uniffi::Record)]
pub struct CreateSenderKeyDistributionResult {
    pub distribution_message: Vec<u8>,
    pub updated_sender_key_record: Vec<u8>,
}

/// Input for processing an incoming sender key distribution message.
#[derive(Debug, Clone, uniffi::Record)]
pub struct ProcessSenderKeyDistributionInput {
    pub sender_address: ProtocolAddressData,
    pub distribution_message: Vec<u8>,
    pub sender_key_record: Option<Vec<u8>>,
}

/// Result of processing a sender key distribution message.
#[derive(Debug, Clone, uniffi::Record)]
pub struct ProcessSenderKeyDistributionResult {
    pub updated_sender_key_record: Vec<u8>,
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
