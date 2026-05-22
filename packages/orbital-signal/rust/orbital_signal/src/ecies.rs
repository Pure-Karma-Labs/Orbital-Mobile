//! Signed ECIES (Elliptic Curve Integrated Encryption Scheme) for zero-knowledge
//! group key wrapping.
//!
//! Provides `ecies_seal` and `ecies_open` — an authenticated, encrypted envelope
//! that binds a sender's identity (via XEdDSA signature) to the ciphertext without
//! requiring the recipient to know the sender beforehand (the sender's public key
//! is included in the envelope).
//!
//! Wire format (190 bytes total, assuming 32-byte plaintext):
//!
//! ```text
//! version(1) || ephemeral_pub(32) || nonce(12) || ciphertext+tag(48) || sender_pub(33) || signature(64)
//! \___________________________ unsigned portion (93 bytes) ___________/
//! ```
//!
//! - Version byte: `0x01`
//! - Ephemeral X25519 public key: 32 bytes (raw Montgomery form)
//! - Nonce: 12-byte random AES-256-GCM nonce
//! - Ciphertext: AES-256-GCM(plaintext) with 16-byte auth tag = 32 + 16 = 48 bytes
//! - Sender public key: 33 bytes (0x05 || raw Curve25519 key, Signal DJB format)
//! - Signature: 64-byte XEdDSA signature over the unsigned portion

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use sha2::Sha256;
use subtle::ConstantTimeEq;
use x25519_dalek::{EphemeralSecret, PublicKey as X25519PublicKey, StaticSecret};
use zeroize::Zeroizing;

use crate::error::SignalError;

/// Expected plaintext length: a single 32-byte group key.
const PLAINTEXT_LEN: usize = 32;

/// AES-256-GCM ciphertext length: plaintext + 16-byte auth tag.
const CIPHERTEXT_WITH_TAG_LEN: usize = PLAINTEXT_LEN + 16; // 48

/// Total sealed envelope length.
const SEALED_LEN: usize = 1 + 32 + 12 + CIPHERTEXT_WITH_TAG_LEN + 33 + 64; // 190

/// Length of the unsigned portion (version + ephemeral_pub + nonce + ciphertext).
const UNSIGNED_LEN: usize = 1 + 32 + 12 + CIPHERTEXT_WITH_TAG_LEN; // 93

/// HKDF info prefix — domain-separated to this specific use case.
const HKDF_INFO_PREFIX: &[u8] = b"orbital-group-key-wrap-v1";

/// Current envelope version byte.
const VERSION: u8 = 0x01;

/// Signal DJB key type prefix byte.
const DJB_TYPE: u8 = 0x05;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Seal (encrypt + sign) a 32-byte group key for a specific recipient.
///
/// The sealed envelope authenticates the sender via XEdDSA signature and encrypts
/// the plaintext so that only the holder of `recipient_public_key`'s corresponding
/// private key can decrypt it.
///
/// # Arguments
///
/// - `plaintext` — Must be exactly 32 bytes (a group key).
/// - `recipient_public_key` — 33-byte Signal public key (0x05 || 32 raw bytes).
/// - `sender_private_key` — 32-byte raw Curve25519 private key (for signing).
/// - `sender_public_key` — 33-byte Signal public key (0x05 || 32 raw bytes).
///
/// # Returns
///
/// 190-byte sealed envelope on success.
#[uniffi::export]
pub fn ecies_seal(
    plaintext: Vec<u8>,
    recipient_public_key: Vec<u8>,
    sender_private_key: Vec<u8>,
    sender_public_key: Vec<u8>,
) -> Result<Vec<u8>, SignalError> {
    // -- Input validation --

    if plaintext.len() != PLAINTEXT_LEN {
        return Err(SignalError::InvalidArgument {
            reason: format!(
                "ecies_seal: plaintext must be exactly {} bytes, got {}",
                PLAINTEXT_LEN,
                plaintext.len()
            ),
        });
    }

    if sender_public_key.len() != 33 || sender_public_key[0] != DJB_TYPE {
        return Err(SignalError::InvalidKey {
            reason: "ecies_seal: sender_public_key must be 33 bytes starting with 0x05".into(),
        });
    }

    let recipient_pub_raw = validate_recipient_public_key(&recipient_public_key)?;

    // -- Ephemeral keypair --

    let ephemeral_secret = EphemeralSecret::random_from_rng(&mut rand_core::OsRng);
    let ephemeral_public = X25519PublicKey::from(&ephemeral_secret);

    // -- ECDH --

    let recipient_x25519 = X25519PublicKey::from(recipient_pub_raw);
    let shared_secret = ephemeral_secret.diffie_hellman(&recipient_x25519);

    // Reject small-order points: DH with a small-order key produces the identity point.
    if !shared_secret.was_contributory() {
        return Err(SignalError::InvalidKey {
            reason: "ecies_seal: recipient public key is a small-order point (DH produced identity)"
                .into(),
        });
    }

    let shared_secret_bytes = Zeroizing::new(shared_secret.to_bytes());

    // -- KDF --

    let ephemeral_pub_bytes = ephemeral_public.to_bytes();
    let derived_key = derive_symmetric_key(
        &*shared_secret_bytes,
        &ephemeral_pub_bytes,
        &recipient_pub_raw,
    )?;

    // -- AES-256-GCM encrypt --

    let cipher = Aes256Gcm::new_from_slice(&*derived_key).map_err(|_| SignalError::InternalError {
        reason: "ecies_seal: failed to construct AES-256-GCM cipher".into(),
    })?;

    let mut nonce_bytes = [0u8; 12];
    rand::fill(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher.encrypt(nonce, plaintext.as_ref()).map_err(|_| {
        SignalError::InternalError {
            reason: "ecies_seal: AES-256-GCM encryption failed".into(),
        }
    })?;

    debug_assert_eq!(ciphertext.len(), CIPHERTEXT_WITH_TAG_LEN);

    // -- Build unsigned portion --

    let mut unsigned = Vec::with_capacity(UNSIGNED_LEN);
    unsigned.push(VERSION);
    unsigned.extend_from_slice(&ephemeral_pub_bytes);
    unsigned.extend_from_slice(&nonce_bytes);
    unsigned.extend_from_slice(&ciphertext);

    debug_assert_eq!(unsigned.len(), UNSIGNED_LEN);

    // -- XEdDSA signature --

    let sender_priv = Zeroizing::new(sender_private_key);
    let signal_private_key =
        libsignal_core::curve::PrivateKey::deserialize(&sender_priv).map_err(|e| {
            SignalError::InvalidKey {
                reason: format!("ecies_seal: invalid sender private key: {e}"),
            }
        })?;

    let signature = signal_private_key
        .calculate_signature(&unsigned, &mut rand::rng())
        .map_err(|e| SignalError::InternalError {
            reason: format!("ecies_seal: signature computation failed: {e}"),
        })?;

    debug_assert_eq!(signature.len(), 64);

    // -- Assemble final envelope --

    let mut sealed = Vec::with_capacity(SEALED_LEN);
    sealed.extend_from_slice(&unsigned);
    sealed.extend_from_slice(&sender_public_key);
    sealed.extend_from_slice(&signature);

    debug_assert_eq!(sealed.len(), SEALED_LEN);

    Ok(sealed)
}

/// Open (verify + decrypt) a 190-byte sealed envelope.
///
/// Verifies the sender's XEdDSA signature, checks that the sender matches the
/// expected public key, and decrypts the group key.
///
/// # Arguments
///
/// - `sealed` — Must be exactly 190 bytes.
/// - `recipient_secret_key` — 32-byte raw X25519 private key.
/// - `expected_sender_public_key` — 33-byte Signal public key (0x05 || 32 raw bytes).
///
/// # Returns
///
/// 32-byte plaintext (group key) on success.
#[uniffi::export]
pub fn ecies_open(
    sealed: Vec<u8>,
    recipient_secret_key: Vec<u8>,
    expected_sender_public_key: Vec<u8>,
) -> Result<Vec<u8>, SignalError> {
    // -- Length and version checks --

    if sealed.len() != SEALED_LEN {
        return Err(SignalError::InvalidMessage {
            reason: format!(
                "ecies_open: sealed envelope must be exactly {} bytes, got {}",
                SEALED_LEN,
                sealed.len()
            ),
        });
    }

    if sealed[0] != VERSION {
        return Err(SignalError::InvalidMessage {
            reason: format!(
                "ecies_open: unsupported version byte 0x{:02x}, expected 0x{:02x}",
                sealed[0], VERSION
            ),
        });
    }

    // -- Parse fields --

    let ephemeral_pub_bytes: [u8; 32] = sealed[1..33]
        .try_into()
        .expect("slice length verified above");
    let nonce_bytes: &[u8; 12] = sealed[33..45]
        .try_into()
        .expect("slice length verified above");
    let ciphertext = &sealed[45..93];
    let sender_pub = &sealed[93..126];
    let signature = &sealed[126..190];

    // -- Sender identity check (constant-time) --

    if expected_sender_public_key.len() != 33 {
        return Err(SignalError::InvalidKey {
            reason: format!(
                "ecies_open: expected_sender_public_key must be 33 bytes, got {}",
                expected_sender_public_key.len()
            ),
        });
    }

    if sender_pub.ct_eq(&expected_sender_public_key).unwrap_u8() == 0 {
        return Err(SignalError::InvalidKey {
            reason: "ecies_open: sender public key does not match expected sender".into(),
        });
    }

    // -- Signature verification --

    let signal_sender_pub =
        libsignal_core::curve::PublicKey::deserialize(sender_pub).map_err(|e| {
            SignalError::InvalidKey {
                reason: format!("ecies_open: invalid sender public key: {e}"),
            }
        })?;

    let unsigned = &sealed[0..UNSIGNED_LEN];
    if !signal_sender_pub.verify_signature(unsigned, signature) {
        return Err(SignalError::InvalidSignature);
    }

    // -- Recipient secret key validation --

    let recipient_secret = Zeroizing::new(recipient_secret_key);
    if recipient_secret.len() != 32 {
        return Err(SignalError::InvalidKey {
            reason: format!(
                "ecies_open: recipient_secret_key must be 32 bytes, got {}",
                recipient_secret.len()
            ),
        });
    }

    let secret_bytes: [u8; 32] = recipient_secret[..32]
        .try_into()
        .expect("length checked above");
    let static_secret = StaticSecret::from(secret_bytes);

    // -- ECDH --

    let ephemeral_x25519 = X25519PublicKey::from(ephemeral_pub_bytes);
    let shared_secret = static_secret.diffie_hellman(&ephemeral_x25519);

    if !shared_secret.was_contributory() {
        return Err(SignalError::InvalidMessage {
            reason: "ecies_open: DH produced identity point (small-order ephemeral key)".into(),
        });
    }

    let shared_secret_bytes = Zeroizing::new(shared_secret.to_bytes());

    // -- Derive recipient's own raw public key for HKDF info --

    let recipient_x25519_pub = X25519PublicKey::from(&static_secret);
    let recipient_pub_raw = recipient_x25519_pub.to_bytes();

    // -- KDF --

    let derived_key = derive_symmetric_key(
        &*shared_secret_bytes,
        &ephemeral_pub_bytes,
        &recipient_pub_raw,
    )?;

    // -- AES-256-GCM decrypt --

    let cipher = Aes256Gcm::new_from_slice(&*derived_key).map_err(|_| SignalError::InternalError {
        reason: "ecies_open: failed to construct AES-256-GCM cipher".into(),
    })?;

    let nonce = Nonce::from_slice(nonce_bytes);

    let plaintext = cipher.decrypt(nonce, ciphertext).map_err(|_| {
        SignalError::InvalidMessage {
            reason: "ecies_open: decryption failed".into(),
        }
    })?;

    Ok(plaintext)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Validate a 33-byte Signal recipient public key and return the raw 32-byte X25519 key.
///
/// Checks:
/// 1. Length is exactly 33 bytes
/// 2. First byte is 0x05 (DJB key type)
/// 3. Raw key is not the zero point (simplest small-order point)
fn validate_recipient_public_key(key: &[u8]) -> Result<[u8; 32], SignalError> {
    if key.len() != 33 {
        return Err(SignalError::InvalidKey {
            reason: format!(
                "ecies_seal: recipient_public_key must be 33 bytes, got {}",
                key.len()
            ),
        });
    }

    if key[0] != DJB_TYPE {
        return Err(SignalError::InvalidKey {
            reason: format!(
                "ecies_seal: recipient_public_key must start with 0x05, got 0x{:02x}",
                key[0]
            ),
        });
    }

    let raw: [u8; 32] = key[1..33].try_into().expect("length checked above");

    // Reject the zero point (all-zeros) — the simplest small-order point on Curve25519.
    // Additional small-order points are caught by the was_contributory() check after DH.
    if raw == [0u8; 32] {
        return Err(SignalError::InvalidKey {
            reason: "ecies_seal: recipient public key is the zero point (small-order)".into(),
        });
    }

    Ok(raw)
}

/// Derive a 32-byte symmetric key from a shared secret using HKDF-SHA256.
///
/// info = "orbital-group-key-wrap-v1" || ephemeral_pub(32) || recipient_pub_raw(32)
fn derive_symmetric_key(
    shared_secret: &[u8],
    ephemeral_pub: &[u8; 32],
    recipient_pub_raw: &[u8; 32],
) -> Result<Zeroizing<[u8; 32]>, SignalError> {
    let mut info = Vec::with_capacity(HKDF_INFO_PREFIX.len() + 32 + 32);
    info.extend_from_slice(HKDF_INFO_PREFIX);
    info.extend_from_slice(ephemeral_pub);
    info.extend_from_slice(recipient_pub_raw);

    let hk = Hkdf::<Sha256>::new(None, shared_secret);
    let mut okm = Zeroizing::new([0u8; 32]);
    hk.expand(&info, &mut *okm).map_err(|_| SignalError::InternalError {
        reason: "ecies: HKDF expand failed".into(),
    })?;

    Ok(okm)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use libsignal_core::curve::KeyPair;

    /// Helper: generate a libsignal Curve25519 key pair, returning
    /// (private_key_raw_32, public_key_djb_33).
    fn generate_signal_keypair() -> (Vec<u8>, Vec<u8>) {
        let mut rng = rand::rng();
        let key_pair = KeyPair::generate(&mut rng);
        let private_key = key_pair.private_key.serialize().to_vec();
        let public_key = key_pair.public_key.serialize().to_vec();
        (private_key, public_key)
    }

    #[test]
    fn test_roundtrip() {
        let plaintext = vec![0x42u8; 32]; // a 32-byte "group key"
        let (sender_priv, sender_pub) = generate_signal_keypair();
        let (recipient_priv, recipient_pub) = generate_signal_keypair();

        let sealed = ecies_seal(
            plaintext.clone(),
            recipient_pub.clone(),
            sender_priv,
            sender_pub.clone(),
        )
        .expect("seal should succeed");

        assert_eq!(sealed.len(), SEALED_LEN, "sealed envelope must be 190 bytes");

        let opened = ecies_open(sealed, recipient_priv, sender_pub).expect("open should succeed");

        assert_eq!(opened, plaintext, "roundtrip must recover original plaintext");
    }

    #[test]
    fn test_wrong_recipient_key() {
        let plaintext = vec![0xAB; 32];
        let (sender_priv, sender_pub) = generate_signal_keypair();
        let (_recipient_priv, recipient_pub) = generate_signal_keypair();
        let (wrong_priv, _wrong_pub) = generate_signal_keypair();

        let sealed = ecies_seal(plaintext, recipient_pub, sender_priv, sender_pub.clone())
            .expect("seal should succeed");

        let err =
            ecies_open(sealed, wrong_priv, sender_pub).expect_err("wrong recipient key must fail");

        assert!(
            matches!(err, SignalError::InvalidMessage { .. }),
            "expected InvalidMessage for wrong recipient key, got: {err:?}"
        );
    }

    #[test]
    fn test_wrong_sender_key_rejected() {
        let plaintext = vec![0xCD; 32];
        let (sender_priv, sender_pub) = generate_signal_keypair();
        let (recipient_priv, recipient_pub) = generate_signal_keypair();
        let (_other_priv, other_pub) = generate_signal_keypair();

        let sealed = ecies_seal(plaintext, recipient_pub, sender_priv, sender_pub)
            .expect("seal should succeed");

        // Recipient expects `other_pub` but the envelope was signed by `sender_pub`.
        let err = ecies_open(sealed, recipient_priv, other_pub)
            .expect_err("mismatched sender pub must fail");

        assert!(
            matches!(err, SignalError::InvalidKey { .. }),
            "expected InvalidKey for sender mismatch, got: {err:?}"
        );
    }

    #[test]
    fn test_tampered_ciphertext() {
        let plaintext = vec![0xEF; 32];
        let (sender_priv, sender_pub) = generate_signal_keypair();
        let (recipient_priv, recipient_pub) = generate_signal_keypair();

        let mut sealed = ecies_seal(
            plaintext,
            recipient_pub,
            sender_priv,
            sender_pub.clone(),
        )
        .expect("seal should succeed");

        // Tamper with a ciphertext byte (offset 45 is start of ciphertext).
        sealed[50] ^= 0xFF;

        let err = ecies_open(sealed, recipient_priv, sender_pub)
            .expect_err("tampered ciphertext must fail");

        // Tampering with the unsigned portion invalidates the signature first.
        assert!(
            matches!(err, SignalError::InvalidSignature | SignalError::InvalidMessage { .. }),
            "expected InvalidSignature or InvalidMessage, got: {err:?}"
        );
    }

    #[test]
    fn test_tampered_signature() {
        let plaintext = vec![0x11; 32];
        let (sender_priv, sender_pub) = generate_signal_keypair();
        let (recipient_priv, recipient_pub) = generate_signal_keypair();

        let mut sealed = ecies_seal(
            plaintext,
            recipient_pub,
            sender_priv,
            sender_pub.clone(),
        )
        .expect("seal should succeed");

        // Tamper with a signature byte (offset 126 is start of signature).
        sealed[130] ^= 0xFF;

        let err = ecies_open(sealed, recipient_priv, sender_pub)
            .expect_err("tampered signature must fail");

        assert!(
            matches!(err, SignalError::InvalidSignature),
            "expected InvalidSignature, got: {err:?}"
        );
    }

    #[test]
    fn test_small_order_point_rejection() {
        let plaintext = vec![0x22; 32];
        let (sender_priv, sender_pub) = generate_signal_keypair();

        // Construct a 33-byte "public key" with 0x05 prefix and all-zeros raw key.
        let mut small_order_key = vec![DJB_TYPE];
        small_order_key.extend_from_slice(&[0u8; 32]);

        let err = ecies_seal(plaintext, small_order_key, sender_priv, sender_pub)
            .expect_err("small-order point must be rejected");

        assert!(
            matches!(err, SignalError::InvalidKey { .. }),
            "expected InvalidKey for small-order point, got: {err:?}"
        );
    }

    #[test]
    fn test_version_byte_rejected() {
        let plaintext = vec![0x33; 32];
        let (sender_priv, sender_pub) = generate_signal_keypair();
        let (recipient_priv, recipient_pub) = generate_signal_keypair();

        let mut sealed = ecies_seal(
            plaintext,
            recipient_pub,
            sender_priv,
            sender_pub.clone(),
        )
        .expect("seal should succeed");

        // Replace version byte with 0x02.
        sealed[0] = 0x02;

        let err = ecies_open(sealed, recipient_priv, sender_pub)
            .expect_err("unsupported version must fail");

        assert!(
            matches!(err, SignalError::InvalidMessage { .. }),
            "expected InvalidMessage for bad version, got: {err:?}"
        );
    }

    #[test]
    fn test_server_substitution_attack() {
        // Attacker knows the recipient's public key and seals with their own sender key.
        // The recipient should reject because the sender_pub in the envelope doesn't match
        // the expected sender.
        let plaintext = vec![0x44; 32];
        let (_legit_sender_priv, legit_sender_pub) = generate_signal_keypair();
        let (attacker_priv, attacker_pub) = generate_signal_keypair();
        let (recipient_priv, recipient_pub) = generate_signal_keypair();

        // Attacker seals with their own key pair.
        let sealed = ecies_seal(
            plaintext,
            recipient_pub,
            attacker_priv,
            attacker_pub,
        )
        .expect("attacker seal should succeed");

        // Recipient expects the legitimate sender.
        let err = ecies_open(sealed, recipient_priv, legit_sender_pub)
            .expect_err("server substitution must fail");

        assert!(
            matches!(err, SignalError::InvalidKey { .. }),
            "expected InvalidKey for sender substitution, got: {err:?}"
        );
    }

    #[test]
    fn test_wrong_plaintext_length_rejected() {
        let (sender_priv, sender_pub) = generate_signal_keypair();
        let (_recipient_priv, recipient_pub) = generate_signal_keypair();

        // 16 bytes — too short
        let err = ecies_seal(vec![0u8; 16], recipient_pub.clone(), sender_priv.clone(), sender_pub.clone())
            .expect_err("16-byte plaintext must be rejected");
        assert!(matches!(err, SignalError::InvalidArgument { .. }));

        // 64 bytes — too long
        let err = ecies_seal(vec![0u8; 64], recipient_pub, sender_priv, sender_pub)
            .expect_err("64-byte plaintext must be rejected");
        assert!(matches!(err, SignalError::InvalidArgument { .. }));
    }

    #[test]
    fn test_wrong_sealed_length_rejected() {
        let (recipient_priv, _recipient_pub) = generate_signal_keypair();
        let (_sender_priv, sender_pub) = generate_signal_keypair();

        let err = ecies_open(vec![0u8; 100], recipient_priv, sender_pub)
            .expect_err("wrong sealed length must fail");
        assert!(matches!(err, SignalError::InvalidMessage { .. }));
    }

    #[test]
    fn test_unique_envelopes() {
        // Same inputs should produce different sealed output due to ephemeral key + nonce.
        let plaintext = vec![0x55; 32];
        let (sender_priv, sender_pub) = generate_signal_keypair();
        let (_recipient_priv, recipient_pub) = generate_signal_keypair();

        let sealed1 = ecies_seal(
            plaintext.clone(),
            recipient_pub.clone(),
            sender_priv.clone(),
            sender_pub.clone(),
        )
        .expect("seal 1 should succeed");

        let sealed2 = ecies_seal(plaintext, recipient_pub, sender_priv, sender_pub)
            .expect("seal 2 should succeed");

        assert_ne!(sealed1, sealed2, "envelopes must differ due to ephemeral key and nonce");
    }
}
