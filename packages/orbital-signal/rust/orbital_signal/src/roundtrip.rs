use std::time::{Instant, SystemTime};

use libsignal_protocol::{
    DeviceId, GenericSignedPreKey, IdentityKeyPair, InMemSignalProtocolStore, KeyPair,
    KyberPreKeyId, KyberPreKeyRecord, KyberPreKeyStore, PreKeyBundle, PreKeyId, PreKeyRecord,
    PreKeySignalMessage, PreKeyStore, ProtocolAddress, SignedPreKeyId, SignedPreKeyRecord,
    SignedPreKeyStore, Timestamp,
};

use crate::error::SignalError;
use crate::types::{RoundtripBatchResult, RoundtripResult};

/// Inner async implementation. Not exported via uniffi because the futures
/// from libsignal's `#[async_trait(?Send)]` store traits are not Send-compatible.
async fn roundtrip_inner(plaintext: &[u8]) -> Result<RoundtripResult, SignalError> {
    let start = Instant::now();
    let mut rng = rand::rng();

    // --- 1. Create Alice and Bob identities ---
    let alice_identity = IdentityKeyPair::generate(&mut rng);
    let bob_identity = IdentityKeyPair::generate(&mut rng);

    let mut alice_store =
        InMemSignalProtocolStore::new(alice_identity, 1).map_err(|e| SignalError::InternalError {
            reason: format!("failed to create Alice store: {e}"),
        })?;

    let mut bob_store =
        InMemSignalProtocolStore::new(bob_identity, 2).map_err(|e| SignalError::InternalError {
            reason: format!("failed to create Bob store: {e}"),
        })?;

    // --- 2. Generate Bob's pre-key material ---
    let pre_key_id = PreKeyId::from(1u32);
    let signed_pre_key_id = SignedPreKeyId::from(1u32);
    let kyber_pre_key_id = KyberPreKeyId::from(1u32);
    let now_millis = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let timestamp = Timestamp::from_epoch_millis(now_millis);

    // One-time pre-key
    let pre_key_pair = KeyPair::generate(&mut rng);
    let pre_key_record = PreKeyRecord::new(pre_key_id, &pre_key_pair);
    bob_store
        .pre_key_store
        .save_pre_key(pre_key_id, &pre_key_record)
        .await
        .map_err(SignalError::from)?;

    // Signed pre-key
    let signed_pre_key_pair = KeyPair::generate(&mut rng);
    let signed_pre_key_signature = bob_identity
        .private_key()
        .calculate_signature(&signed_pre_key_pair.public_key.serialize(), &mut rng)
        .map_err(SignalError::from)?
        .into_vec();
    let signed_pre_key_record = SignedPreKeyRecord::new(
        signed_pre_key_id,
        timestamp,
        &signed_pre_key_pair,
        &signed_pre_key_signature,
    );
    bob_store
        .signed_pre_key_store
        .save_signed_pre_key(signed_pre_key_id, &signed_pre_key_record)
        .await
        .map_err(SignalError::from)?;

    // Kyber (post-quantum) pre-key
    let kyber_key_pair = libsignal_protocol::kem::KeyPair::generate(
        libsignal_protocol::kem::KeyType::Kyber1024,
        &mut rng,
    );
    let kyber_signature = bob_identity
        .private_key()
        .calculate_signature(&kyber_key_pair.public_key.serialize(), &mut rng)
        .map_err(SignalError::from)?
        .into_vec();
    let kyber_pre_key_record =
        KyberPreKeyRecord::new(kyber_pre_key_id, timestamp, &kyber_key_pair, &kyber_signature);
    bob_store
        .kyber_pre_key_store
        .save_kyber_pre_key(kyber_pre_key_id, &kyber_pre_key_record)
        .await
        .map_err(SignalError::from)?;

    // --- 3. Build PreKeyBundle ---
    let device_id = DeviceId::new(1).map_err(|_| SignalError::InvalidArgument {
        reason: "invalid device ID".to_string(),
    })?;

    let bundle = PreKeyBundle::new(
        2, // Bob's registration ID
        device_id,
        Some((pre_key_id, pre_key_pair.public_key)),
        signed_pre_key_id,
        signed_pre_key_pair.public_key,
        signed_pre_key_signature,
        kyber_pre_key_id,
        kyber_key_pair.public_key.clone(),
        kyber_signature,
        *bob_identity.identity_key(),
    )
    .map_err(SignalError::from)?;

    // --- 4. Alice processes the bundle (establishes outgoing session) ---
    let bob_address = ProtocolAddress::new("+14155551234".to_string(), device_id);
    let alice_address = ProtocolAddress::new("+14155559876".to_string(), device_id);

    libsignal_protocol::process_prekey_bundle(
        &bob_address,
        &mut alice_store.session_store,
        &mut alice_store.identity_store,
        &bundle,
        SystemTime::now(),
        &mut rng,
    )
    .await
    .map_err(SignalError::from)?;

    // --- 5. Alice encrypts ---
    let ciphertext_message = libsignal_protocol::message_encrypt(
        plaintext,
        &bob_address,
        &mut alice_store.session_store,
        &mut alice_store.identity_store,
        SystemTime::now(),
        &mut rng,
    )
    .await
    .map_err(SignalError::from)?;

    let ciphertext_bytes = ciphertext_message.serialize().to_vec();
    let ciphertext_len = ciphertext_bytes.len() as u32;

    // --- 6. Bob decrypts (first message is always PreKeySignalMessage) ---
    let prekey_signal_message =
        PreKeySignalMessage::try_from(ciphertext_bytes.as_slice()).map_err(SignalError::from)?;

    let decrypted = libsignal_protocol::message_decrypt_prekey(
        &prekey_signal_message,
        &alice_address,
        &mut bob_store.session_store,
        &mut bob_store.identity_store,
        &mut bob_store.pre_key_store,
        &bob_store.signed_pre_key_store,
        &mut bob_store.kyber_pre_key_store,
        &mut rng,
    )
    .await
    .map_err(SignalError::from)?;

    // --- 7. Build result ---
    let elapsed_ms = start.elapsed().as_millis() as u64;
    let success = plaintext == decrypted.as_slice();

    Ok(RoundtripResult {
        plaintext: plaintext.to_vec(),
        ciphertext_len,
        decrypted,
        success,
        elapsed_ms,
    })
}

/// Self-contained encrypt/decrypt round-trip using in-memory stores.
///
/// Proves the full Signal Protocol (PQXDH key agreement + Double Ratchet encryption)
/// works through the native bridge without needing external store-passing FFI.
///
/// Exported as sync because libsignal's store traits use `#[async_trait(?Send)]`,
/// producing non-Send futures that are incompatible with uniffi's async exports.
/// We use a single-threaded tokio runtime internally to drive the async operations.
#[uniffi::export]
pub fn test_encrypt_decrypt_roundtrip(
    plaintext: Vec<u8>,
) -> Result<RoundtripResult, SignalError> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| SignalError::InternalError {
            reason: format!("failed to create runtime: {e}"),
        })?;
    rt.block_on(roundtrip_inner(&plaintext))
}

/// Run the encrypt/decrypt round-trip N times and report aggregate results.
/// Capped at 1000 iterations to prevent blocking the JS thread for extended periods.
#[uniffi::export]
pub fn test_encrypt_decrypt_roundtrip_n(
    plaintext: Vec<u8>,
    iterations: u32,
) -> Result<RoundtripBatchResult, SignalError> {
    const MAX_ITERATIONS: u32 = 1_000;
    if iterations > MAX_ITERATIONS {
        return Err(SignalError::InvalidArgument {
            reason: format!("iterations must be <= {MAX_ITERATIONS}, got {iterations}"),
        });
    }

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| SignalError::InternalError {
            reason: format!("failed to create runtime: {e}"),
        })?;

    let total_start = Instant::now();
    let mut success_count: u32 = 0;

    for _ in 0..iterations {
        let result = rt.block_on(roundtrip_inner(&plaintext))?;
        if result.success {
            success_count += 1;
        }
    }

    let total_elapsed_ms = total_start.elapsed().as_millis() as u64;
    let avg_elapsed_ms = if iterations > 0 {
        total_elapsed_ms / iterations as u64
    } else {
        0
    };

    Ok(RoundtripBatchResult {
        success_count,
        total_elapsed_ms,
        avg_elapsed_ms,
    })
}
