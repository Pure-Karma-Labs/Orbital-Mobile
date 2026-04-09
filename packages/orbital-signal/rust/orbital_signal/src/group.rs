use uuid::Uuid;

use libsignal_protocol::{
    InMemSenderKeyStore, SenderKeyRecord, SenderKeyStore,
};

use crate::error::SignalError;
use crate::session::build_runtime;
use crate::store_adapters::to_protocol_address;
use crate::types::{
    CreateSenderKeyDistributionInput, CreateSenderKeyDistributionResult, GroupDecryptInput,
    GroupDecryptResult, GroupEncryptInput, GroupEncryptResult,
    ProcessSenderKeyDistributionInput, ProcessSenderKeyDistributionResult,
};

/// Parse a distribution ID string as UUID.
fn parse_distribution_id(s: &str) -> Result<Uuid, SignalError> {
    Uuid::parse_str(s).map_err(|e| SignalError::InvalidArgument {
        reason: format!("invalid distribution_id UUID: {e}"),
    })
}

/// Pre-load a sender key record into the in-memory store if provided.
async fn preload_sender_key(
    store: &mut InMemSenderKeyStore,
    address: &libsignal_protocol::ProtocolAddress,
    distribution_id: Uuid,
    sender_key_bytes: Option<&Vec<u8>>,
) -> Result<(), SignalError> {
    if let Some(bytes) = sender_key_bytes {
        let record = SenderKeyRecord::deserialize(bytes).map_err(|e| {
            SignalError::InvalidMessage {
                reason: format!("sender key record deserialization: {e}"),
            }
        })?;
        store
            .store_sender_key(address, distribution_id, &record)
            .await
            .map_err(SignalError::from)?;
    }
    Ok(())
}

/// Extract the sender key record from the in-memory store after an operation.
async fn extract_sender_key(
    store: &mut InMemSenderKeyStore,
    address: &libsignal_protocol::ProtocolAddress,
    distribution_id: Uuid,
) -> Result<Vec<u8>, SignalError> {
    let record = store
        .load_sender_key(address, distribution_id)
        .await
        .map_err(SignalError::from)?
        .ok_or_else(|| SignalError::InternalError {
            reason: "sender key record missing after operation".to_string(),
        })?;
    record.serialize().map_err(SignalError::from)
}

// ---------------------------------------------------------------------------
// create_sender_key_distribution_message
// ---------------------------------------------------------------------------

/// Create a Sender Key Distribution Message for group messaging (preloaded store pattern).
///
/// The caller provides an optional existing sender key record. The function creates
/// a new distribution message and returns both the message and the updated sender key.
#[uniffi::export]
pub fn create_sender_key_distribution_message(
    input: CreateSenderKeyDistributionInput,
) -> Result<CreateSenderKeyDistributionResult, SignalError> {
    let rt = build_runtime()?;

    rt.block_on(async {
        let protocol_address = to_protocol_address(&input.sender_address)?;
        let distribution_id = parse_distribution_id(&input.distribution_id)?;
        let mut store = InMemSenderKeyStore::new();

        // Pre-load sender key if provided
        preload_sender_key(
            &mut store,
            &protocol_address,
            distribution_id,
            input.sender_key_record.as_ref(),
        )
        .await?;

        // Create the distribution message
        let skdm = libsignal_protocol::create_sender_key_distribution_message(
            &protocol_address,
            distribution_id,
            &mut store,
            &mut rand::rng(),
        )
        .await
        .map_err(SignalError::from)?;

        // Extract updated sender key
        let updated_sender_key =
            extract_sender_key(&mut store, &protocol_address, distribution_id).await?;

        Ok(CreateSenderKeyDistributionResult {
            distribution_message: skdm.serialized().to_vec(),
            updated_sender_key_record: updated_sender_key,
        })
    })
}

// ---------------------------------------------------------------------------
// process_sender_key_distribution_message
// ---------------------------------------------------------------------------

/// Process an incoming Sender Key Distribution Message (preloaded store pattern).
///
/// The caller provides an optional existing sender key record. The function processes
/// the distribution message and returns the updated sender key record.
#[uniffi::export]
pub fn process_sender_key_distribution_message(
    input: ProcessSenderKeyDistributionInput,
) -> Result<ProcessSenderKeyDistributionResult, SignalError> {
    let rt = build_runtime()?;

    rt.block_on(async {
        let protocol_address = to_protocol_address(&input.sender_address)?;
        let mut store = InMemSenderKeyStore::new();

        // Parse the distribution message
        let skdm = libsignal_protocol::SenderKeyDistributionMessage::try_from(
            input.distribution_message.as_slice(),
        )
        .map_err(SignalError::from)?;

        let distribution_id = skdm.distribution_id().map_err(SignalError::from)?;

        // Pre-load sender key if provided
        preload_sender_key(
            &mut store,
            &protocol_address,
            distribution_id,
            input.sender_key_record.as_ref(),
        )
        .await?;

        // Process the distribution message
        libsignal_protocol::process_sender_key_distribution_message(
            &protocol_address,
            &skdm,
            &mut store,
        )
        .await
        .map_err(SignalError::from)?;

        // Extract updated sender key
        let updated_sender_key =
            extract_sender_key(&mut store, &protocol_address, distribution_id).await?;

        Ok(ProcessSenderKeyDistributionResult {
            updated_sender_key_record: updated_sender_key,
        })
    })
}

// ---------------------------------------------------------------------------
// group_encrypt
// ---------------------------------------------------------------------------

/// Encrypt a message for a group using Sender Keys (preloaded store pattern).
///
/// The caller provides the existing sender key record (required — must have been
/// established via `create_sender_key_distribution_message` first).
#[uniffi::export]
pub fn group_encrypt(input: GroupEncryptInput) -> Result<GroupEncryptResult, SignalError> {
    let rt = build_runtime()?;

    rt.block_on(async {
        let protocol_address = to_protocol_address(&input.sender_address)?;
        let distribution_id = parse_distribution_id(&input.distribution_id)?;
        let mut store = InMemSenderKeyStore::new();

        // Pre-load sender key (should be present for encryption)
        preload_sender_key(
            &mut store,
            &protocol_address,
            distribution_id,
            input.sender_key_record.as_ref(),
        )
        .await?;

        // Encrypt
        let skm = libsignal_protocol::group_encrypt(
            &mut store,
            &protocol_address,
            distribution_id,
            &input.plaintext,
            &mut rand::rng(),
        )
        .await
        .map_err(SignalError::from)?;

        // Extract updated sender key
        let updated_sender_key =
            extract_sender_key(&mut store, &protocol_address, distribution_id).await?;

        Ok(GroupEncryptResult {
            ciphertext: skm.serialized().to_vec(),
            updated_sender_key_record: updated_sender_key,
        })
    })
}

// ---------------------------------------------------------------------------
// group_decrypt
// ---------------------------------------------------------------------------

/// Decrypt a group message using Sender Keys (preloaded store pattern).
///
/// The caller provides the existing sender key record for the sender (required —
/// must have been established via `process_sender_key_distribution_message` first).
#[uniffi::export]
pub fn group_decrypt(input: GroupDecryptInput) -> Result<GroupDecryptResult, SignalError> {
    let rt = build_runtime()?;

    rt.block_on(async {
        let protocol_address = to_protocol_address(&input.sender_address)?;
        let mut store = InMemSenderKeyStore::new();

        // For group_decrypt, we need to pre-load the sender key but we don't know the
        // distribution_id yet (it's embedded in the ciphertext). The libsignal group_decrypt
        // function will parse the ciphertext to get the distribution_id and then load
        // the sender key from the store. So we need to parse the SenderKeyMessage first
        // to extract the distribution_id, then pre-load the sender key.
        let skm = libsignal_protocol::SenderKeyMessage::try_from(input.ciphertext.as_slice())
            .map_err(SignalError::from)?;
        let distribution_id = skm.distribution_id();

        // Pre-load sender key
        preload_sender_key(
            &mut store,
            &protocol_address,
            distribution_id,
            input.sender_key_record.as_ref(),
        )
        .await?;

        // Decrypt
        let plaintext = libsignal_protocol::group_decrypt(
            &input.ciphertext,
            &mut store,
            &protocol_address,
        )
        .await
        .map_err(SignalError::from)?;

        // Extract updated sender key
        let updated_sender_key =
            extract_sender_key(&mut store, &protocol_address, distribution_id).await?;

        Ok(GroupDecryptResult {
            plaintext,
            updated_sender_key_record: updated_sender_key,
        })
    })
}
