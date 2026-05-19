use aes::Aes256;
use cbc::cipher::block_padding::Pkcs7;
use cbc::cipher::{BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use cbc::{Decryptor, Encryptor};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

use crate::error::SignalError;

type Aes256CbcEnc = Encryptor<Aes256>;
type Aes256CbcDec = Decryptor<Aes256>;
type HmacSha256 = Hmac<Sha256>;

/// Result of Signal Protocol attachment encryption (AES-256-CBC + HMAC-SHA256).
#[derive(Debug, Clone, uniffi::Record)]
pub struct AttachmentCryptoResult {
    /// IV (16 bytes) || encrypted_data || HMAC-SHA256 (32 bytes).
    pub ciphertext: Vec<u8>,
    /// SHA-256 digest of the entire ciphertext blob (IV + encrypted_data + HMAC).
    pub digest: Vec<u8>,
    /// SHA-256 hash of the original plaintext (local integrity only — never sent to server).
    pub plaintext_hash: Vec<u8>,
}

/// Encrypt an attachment using Signal Protocol format (AES-256-CBC + HMAC-SHA256).
///
/// - `keys` must be exactly 64 bytes: first 32 = AES-256 key, last 32 = HMAC-SHA256 key.
/// - Generates a fresh 16-byte IV via CSPRNG.
/// - Returns `AttachmentCryptoResult` with ciphertext (IV || encrypted_data || HMAC),
///   SHA-256 digest of the ciphertext, and SHA-256 hash of the original plaintext.
///
/// # Errors
///
/// - `InvalidKey` if `keys` is not exactly 64 bytes.
#[uniffi::export]
pub fn attachment_encrypt(
    plaintext: Vec<u8>,
    keys: Vec<u8>,
) -> Result<AttachmentCryptoResult, SignalError> {
    // Zeroize the FFI-boundary key material on drop
    let keys = Zeroizing::new(keys);
    let mut iv = [0u8; 16];
    rand::fill(&mut iv);
    attachment_encrypt_inner(&plaintext, &keys, &iv)
}

/// Inner encryption implementation that accepts an explicit IV.
///
/// **MUST NOT be `pub` or `#[uniffi::export]`** — a deterministic-IV function
/// exposed via FFI would allow IV reuse, breaking CBC confidentiality.
fn attachment_encrypt_inner(
    plaintext: &[u8],
    keys: &[u8],
    iv: &[u8; 16],
) -> Result<AttachmentCryptoResult, SignalError> {
    if keys.len() != 64 {
        return Err(SignalError::InvalidKey {
            reason: format!(
                "attachment encryption requires a 64-byte key (32 AES + 32 HMAC), got {}",
                keys.len()
            ),
        });
    }

    let aes_key: &[u8; 32] = keys[..32].try_into().map_err(|_| SignalError::InternalError {
        reason: "key slice conversion failed".to_string(),
    })?;
    let hmac_key = &keys[32..64];

    // Compute SHA-256 hash of the original plaintext
    let plaintext_hash = Sha256::digest(plaintext).to_vec();

    // Encrypt plaintext with AES-256-CBC, PKCS7 padding
    let encrypted_data = Aes256CbcEnc::new(aes_key.into(), &(*iv).into())
        .encrypt_padded_vec_mut::<Pkcs7>(plaintext);

    // Build output: IV (16) || encrypted_data
    let mut output = Vec::with_capacity(16 + encrypted_data.len() + 32);
    output.extend_from_slice(iv);
    output.extend_from_slice(&encrypted_data);

    // Compute HMAC-SHA256 over IV || encrypted_data
    let mut mac = <HmacSha256 as Mac>::new_from_slice(hmac_key).map_err(|_| {
        SignalError::InvalidKey {
            reason: "failed to construct HMAC-SHA256".to_string(),
        }
    })?;
    mac.update(&output); // output currently contains IV || encrypted_data
    let hmac_tag = mac.finalize().into_bytes();

    // Append HMAC to output: IV || encrypted_data || HMAC (32)
    output.extend_from_slice(&hmac_tag);

    // Compute SHA-256 digest of the entire output blob
    let digest = Sha256::digest(&output).to_vec();

    Ok(AttachmentCryptoResult {
        ciphertext: output,
        digest,
        plaintext_hash,
    })
}

/// Decrypt a Signal Protocol attachment (AES-256-CBC + HMAC-SHA256).
///
/// - `keys` must be exactly 64 bytes: first 32 = AES-256 key, last 32 = HMAC-SHA256 key.
/// - `ciphertext` format: IV (16 bytes) || encrypted_data || HMAC-SHA256 (32 bytes).
/// - `expected_digest` is the SHA-256 digest of the entire ciphertext blob.
///
/// **CRITICAL:** HMAC is verified BEFORE decryption to prevent padding oracle attacks.
/// All failure modes (MAC mismatch, digest mismatch, decrypt failure) return the same
/// opaque error to prevent information leakage.
///
/// # Errors
///
/// - `InvalidKey` if `keys` is not exactly 64 bytes.
/// - `InvalidArgument` if `ciphertext` is too short (< 48 bytes).
/// - `InvalidMessage` (opaque) if HMAC verification, digest verification, or decryption fails.
#[uniffi::export]
pub fn attachment_decrypt(
    ciphertext: Vec<u8>,
    keys: Vec<u8>,
    expected_digest: Vec<u8>,
) -> Result<Vec<u8>, SignalError> {
    // Wrap keys in Zeroizing immediately so key material is zeroed on all exit paths
    let keys = Zeroizing::new(keys);

    // 1. Validate key length
    if keys.len() != 64 {
        return Err(SignalError::InvalidKey {
            reason: format!(
                "attachment decryption requires a 64-byte key (32 AES + 32 HMAC), got {}",
                keys.len()
            ),
        });
    }

    // 2. Validate minimum ciphertext length: 16 (IV) + 0 (data) + 32 (HMAC) = 48
    if ciphertext.len() < 48 {
        return Err(SignalError::InvalidArgument {
            reason: format!(
                "ciphertext too short — minimum 48 bytes (16 IV + 32 HMAC), got {}",
                ciphertext.len()
            ),
        });
    }

    let aes_key: &[u8; 32] =
        keys[..32]
            .try_into()
            .map_err(|_| SignalError::InternalError {
                reason: "key slice conversion failed".to_string(),
            })?;
    let hmac_key = &keys[32..64];

    let mac_offset = ciphertext.len() - 32;
    let iv_and_encrypted = &ciphertext[..mac_offset];
    let received_mac = &ciphertext[mac_offset..];

    // 3. CRITICAL: Verify HMAC BEFORE decrypting (prevents padding oracle)
    let mut mac = <HmacSha256 as Mac>::new_from_slice(hmac_key).map_err(|_| {
        SignalError::InvalidKey {
            reason: "failed to construct HMAC-SHA256".to_string(),
        }
    })?;
    mac.update(iv_and_encrypted);
    mac.verify_slice(received_mac).map_err(|_| {
        // Intentionally opaque — do not differentiate MAC failure from other errors
        SignalError::InvalidMessage {
            reason: "decryption failed".to_string(),
        }
    })?;

    // 4. Verify SHA-256 digest of entire ciphertext matches expected (constant-time)
    let actual_digest = Sha256::digest(&ciphertext);
    if expected_digest.len() != actual_digest.len()
        || !bool::from(actual_digest.as_slice().ct_eq(expected_digest.as_slice()))
    {
        return Err(SignalError::InvalidMessage {
            reason: "decryption failed".to_string(),
        });
    }

    // 5. Extract IV and encrypted data
    let iv: &[u8; 16] =
        ciphertext[..16]
            .try_into()
            .map_err(|_| SignalError::InternalError {
                reason: "IV slice conversion failed".to_string(),
            })?;
    let encrypted_data = &ciphertext[16..mac_offset];

    // 6. Decrypt with AES-256-CBC, remove PKCS7 padding
    let plaintext = Aes256CbcDec::new(aes_key.into(), iv.into())
        .decrypt_padded_vec_mut::<Pkcs7>(encrypted_data)
        .map_err(|_| {
            // Intentionally opaque — same error as MAC/digest failure
            SignalError::InvalidMessage {
                reason: "decryption failed".to_string(),
            }
        })?;

    Ok(plaintext)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn test_keys() -> Vec<u8> {
        let mut keys = vec![0xAB; 32]; // AES key
        keys.extend_from_slice(&[0xCD; 32]); // HMAC key
        keys
    }

    #[test]
    fn test_roundtrip_encrypt_decrypt() {
        let plaintext = b"Hello, Orbital attachments!".to_vec();
        let keys = test_keys();

        let result =
            attachment_encrypt(plaintext.clone(), keys.clone()).expect("encryption should succeed");

        let decrypted = attachment_decrypt(result.ciphertext, keys, result.digest)
            .expect("decryption should succeed");

        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_roundtrip_empty_plaintext() {
        let plaintext = vec![];
        let keys = test_keys();

        let result =
            attachment_encrypt(plaintext.clone(), keys.clone()).expect("encryption should succeed");

        // Empty plaintext still produces ciphertext due to PKCS7 padding (one full block)
        assert!(result.ciphertext.len() >= 48 + 16, "empty plaintext should produce at least one padded block");

        let decrypted = attachment_decrypt(result.ciphertext, keys, result.digest)
            .expect("decryption should succeed");

        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_roundtrip_large_plaintext() {
        // 1 MB plaintext
        let plaintext = vec![0x42; 1_000_000];
        let keys = test_keys();

        let result =
            attachment_encrypt(plaintext.clone(), keys.clone()).expect("encryption should succeed");

        let decrypted = attachment_decrypt(result.ciphertext, keys, result.digest)
            .expect("decryption should succeed");

        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_wrong_key_fails() {
        let plaintext = b"secret attachment".to_vec();
        let keys = test_keys();
        // Both AES and HMAC keys differ — fails at HMAC verification (opaque error)
        let wrong_keys = vec![0x11; 64];

        let result = attachment_encrypt(plaintext, keys).expect("encryption should succeed");

        let err = attachment_decrypt(result.ciphertext, wrong_keys, result.digest)
            .expect_err("wrong key should fail");
        assert!(
            matches!(err, SignalError::InvalidMessage { .. }),
            "should be opaque InvalidMessage, got: {err:?}"
        );
    }

    #[test]
    fn test_wrong_aes_key_same_hmac_key_fails() {
        // Same HMAC key (MAC passes) but different AES key — fails at CBC decrypt/unpad (opaque error)
        let plaintext = b"aes key mismatch test".to_vec();
        let keys = test_keys();

        let result =
            attachment_encrypt(plaintext, keys.clone()).expect("encryption should succeed");

        // Keep HMAC key identical, change only AES key
        let mut wrong_keys = vec![0x11; 32]; // different AES key
        wrong_keys.extend_from_slice(&keys[32..]); // same HMAC key

        let err = attachment_decrypt(result.ciphertext, wrong_keys, result.digest)
            .expect_err("wrong AES key should fail");
        assert!(
            matches!(err, SignalError::InvalidMessage { .. }),
            "should be opaque InvalidMessage (same variant as MAC failure), got: {err:?}"
        );
    }

    #[test]
    fn test_tampered_ciphertext_data_fails() {
        let plaintext = b"tamper test data".to_vec();
        let keys = test_keys();

        let result =
            attachment_encrypt(plaintext, keys.clone()).expect("encryption should succeed");

        // Flip a byte in the encrypted data portion (after IV, before HMAC)
        let mut tampered = result.ciphertext.clone();
        tampered[20] ^= 0xFF; // byte 20 is in the encrypted data

        let err = attachment_decrypt(tampered, keys, result.digest)
            .expect_err("tampered data should fail");
        assert!(
            matches!(err, SignalError::InvalidMessage { .. }),
            "should be opaque InvalidMessage, got: {err:?}"
        );
    }

    #[test]
    fn test_tampered_hmac_fails() {
        let plaintext = b"tamper test mac".to_vec();
        let keys = test_keys();

        let result =
            attachment_encrypt(plaintext, keys.clone()).expect("encryption should succeed");

        // Flip a byte in the HMAC (last 32 bytes)
        let mut tampered = result.ciphertext.clone();
        let mac_start = tampered.len() - 32;
        tampered[mac_start] ^= 0xFF;

        let err = attachment_decrypt(tampered, keys, result.digest)
            .expect_err("tampered HMAC should fail");
        assert!(
            matches!(err, SignalError::InvalidMessage { .. }),
            "should be opaque InvalidMessage, got: {err:?}"
        );
    }

    #[test]
    fn test_wrong_digest_fails() {
        let plaintext = b"digest test".to_vec();
        let keys = test_keys();

        let result =
            attachment_encrypt(plaintext, keys.clone()).expect("encryption should succeed");

        let wrong_digest = vec![0x00; 32]; // wrong SHA-256 digest

        let err = attachment_decrypt(result.ciphertext, keys, wrong_digest)
            .expect_err("wrong digest should fail");
        assert!(
            matches!(err, SignalError::InvalidMessage { .. }),
            "should be opaque InvalidMessage, got: {err:?}"
        );
    }

    #[test]
    fn test_key_too_short_fails() {
        let err = attachment_encrypt(b"test".to_vec(), vec![0x00; 63])
            .expect_err("63-byte key should fail");
        assert!(
            matches!(err, SignalError::InvalidKey { .. }),
            "should be InvalidKey, got: {err:?}"
        );
    }

    #[test]
    fn test_key_too_long_fails() {
        let err = attachment_encrypt(b"test".to_vec(), vec![0x00; 65])
            .expect_err("65-byte key should fail");
        assert!(
            matches!(err, SignalError::InvalidKey { .. }),
            "should be InvalidKey, got: {err:?}"
        );
    }

    #[test]
    fn test_ciphertext_too_short_fails() {
        let keys = test_keys();
        let err = attachment_decrypt(vec![0x00; 47], keys, vec![0x00; 32])
            .expect_err("ciphertext < 48 bytes should fail");
        assert!(
            matches!(err, SignalError::InvalidArgument { .. }),
            "should be InvalidArgument, got: {err:?}"
        );
    }

    #[test]
    fn test_iv_is_16_bytes() {
        let keys = test_keys();
        let result =
            attachment_encrypt(b"IV test".to_vec(), keys).expect("encryption should succeed");

        // IV is the first 16 bytes of the ciphertext
        assert!(
            result.ciphertext.len() >= 16,
            "ciphertext must start with 16-byte IV"
        );
        // Verify by checking that the IV portion exists and is reasonable
        let iv = &result.ciphertext[..16];
        assert_eq!(iv.len(), 16, "IV must be exactly 16 bytes");
    }

    #[test]
    fn test_unique_ivs_per_encryption() {
        let keys = test_keys();
        let plaintext = b"same text".to_vec();

        let r1 = attachment_encrypt(plaintext.clone(), keys.clone()).expect("should succeed");
        let r2 = attachment_encrypt(plaintext, keys).expect("should succeed");

        // IVs are the first 16 bytes of each ciphertext
        let iv1 = &r1.ciphertext[..16];
        let iv2 = &r2.ciphertext[..16];

        assert_ne!(iv1, iv2, "IVs must be unique per encryption (CSPRNG)");
    }

    #[test]
    fn test_hmac_is_last_32_bytes() {
        let keys = test_keys();
        let plaintext = b"HMAC layout test".to_vec();

        let result =
            attachment_encrypt(plaintext, keys.clone()).expect("encryption should succeed");

        let len = result.ciphertext.len();
        let stored_mac = &result.ciphertext[len - 32..];
        let iv_and_encrypted = &result.ciphertext[..len - 32];

        // Independently recompute HMAC-SHA256 over IV || encrypted_data
        let hmac_key = &keys[32..64];
        let mut mac =
            <HmacSha256 as Mac>::new_from_slice(hmac_key).expect("HMAC key should be valid");
        mac.update(iv_and_encrypted);
        let expected_mac = mac.finalize().into_bytes();

        assert_eq!(
            stored_mac,
            expected_mac.as_slice(),
            "last 32 bytes of ciphertext must be the HMAC-SHA256 of IV || encrypted_data"
        );
    }

    #[test]
    fn test_plaintext_hash_is_sha256_of_input() {
        let plaintext = b"hash verification test".to_vec();
        let keys = test_keys();

        let result =
            attachment_encrypt(plaintext.clone(), keys).expect("encryption should succeed");

        let expected_hash = Sha256::digest(&plaintext).to_vec();
        assert_eq!(
            result.plaintext_hash, expected_hash,
            "plaintext_hash must be SHA-256 of the original plaintext"
        );
    }

    #[test]
    fn test_digest_is_sha256_of_ciphertext() {
        let plaintext = b"digest verification test".to_vec();
        let keys = test_keys();

        let result =
            attachment_encrypt(plaintext, keys).expect("encryption should succeed");

        let expected_digest = Sha256::digest(&result.ciphertext).to_vec();
        assert_eq!(
            result.digest, expected_digest,
            "digest must be SHA-256 of the entire ciphertext blob (IV + encrypted_data + HMAC)"
        );
    }

    #[test]
    fn test_decrypt_key_too_short_fails() {
        let keys = test_keys();
        let result =
            attachment_encrypt(b"test".to_vec(), keys).expect("encryption should succeed");

        let err = attachment_decrypt(result.ciphertext, vec![0x00; 32], result.digest)
            .expect_err("32-byte key should fail for decrypt");
        assert!(
            matches!(err, SignalError::InvalidKey { .. }),
            "should be InvalidKey, got: {err:?}"
        );
    }

    #[test]
    fn test_decrypt_key_too_long_fails() {
        let keys = test_keys();
        let result =
            attachment_encrypt(b"test".to_vec(), keys).expect("encryption should succeed");

        let err = attachment_decrypt(result.ciphertext, vec![0x00; 128], result.digest)
            .expect_err("128-byte key should fail for decrypt");
        assert!(
            matches!(err, SignalError::InvalidKey { .. }),
            "should be InvalidKey, got: {err:?}"
        );
    }

    // -----------------------------------------------------------------------
    // Known-Answer Tests (KAT)
    //
    // Vectors generated independently with pycryptodome — see
    // tools/generate_kat_vectors.py for the reference implementation.
    // -----------------------------------------------------------------------

    use hex_literal::hex;

    // --- Vector 1: "Hello Signal", key = 0x01*32 || 0x02*32, iv = 0x03*16 ---
    const V1_PLAINTEXT: &[u8] = b"Hello Signal";
    const V1_KEY: [u8; 64] = hex!("01010101010101010101010101010101010101010101010101010101010101010202020202020202020202020202020202020202020202020202020202020202");
    const V1_IV: [u8; 16] = hex!("03030303030303030303030303030303");
    const V1_CIPHERTEXT: [u8; 64] = hex!("03030303030303030303030303030303caa6cf4a34d417a41e4aa590244bbe819e823b44b04eda7cf7b807d7c6e7524d4e2a8d92070897738ebd602d3e1a0ca5");
    const V1_DIGEST: [u8; 32] = hex!("09b4660f47167c61edca74fffc2f3b50819e90da04ee943e86ab42412b7139df");

    // --- Vector 2: empty plaintext, key = 0x10*32 || 0x20*32, iv = 0x30*16 ---
    const V2_PLAINTEXT: &[u8] = b"";
    const V2_KEY: [u8; 64] = hex!("10101010101010101010101010101010101010101010101010101010101010102020202020202020202020202020202020202020202020202020202020202020");
    const V2_IV: [u8; 16] = hex!("30303030303030303030303030303030");
    const V2_CIPHERTEXT: [u8; 64] = hex!("30303030303030303030303030303030aa166c8ee814654c52e9f15751425b8355164a9be9353bd8b1fb4cbdcc00451760d8c36a15b324bd2b2a8bf8cf50c6e3");
    const V2_DIGEST: [u8; 32] = hex!("c509149bce526b877defe0c32b6ef868c340c3fa54456649488b95d37218cf77");

    // --- Vector 3: block-aligned "0123456789abcdef", key = 0xAA*32 || 0xBB*32, iv = 0xCC*16 ---
    const V3_PLAINTEXT: &[u8] = b"0123456789abcdef";
    const V3_KEY: [u8; 64] = hex!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    const V3_IV: [u8; 16] = hex!("cccccccccccccccccccccccccccccccc");
    const V3_CIPHERTEXT: [u8; 80] = hex!("cccccccccccccccccccccccccccccccc1e70e325b729fe73fc970d168943419f7dc581835e2b2952050edb1db845738307967f56865063815cad02c17d70093c816e347d75bdfe7b35a4a1d41df4af0d");
    const V3_DIGEST: [u8; 32] = hex!("b640c2f875acb50f9288e5c282c4c697d2f57b4fe860b0551a679ba21270492a");

    // -- Encrypt KATs: verify attachment_encrypt_inner produces expected ciphertext + digest --

    #[test]
    fn test_kat_encrypt_vector_1() {
        let result = attachment_encrypt_inner(V1_PLAINTEXT, &V1_KEY, &V1_IV)
            .expect("encrypt should succeed");
        assert_eq!(result.ciphertext, V1_CIPHERTEXT.to_vec(), "ciphertext mismatch");
        assert_eq!(result.digest, V1_DIGEST.to_vec(), "digest mismatch");
    }

    #[test]
    fn test_kat_encrypt_vector_2() {
        let result = attachment_encrypt_inner(V2_PLAINTEXT, &V2_KEY, &V2_IV)
            .expect("encrypt should succeed");
        assert_eq!(result.ciphertext, V2_CIPHERTEXT.to_vec(), "ciphertext mismatch");
        assert_eq!(result.digest, V2_DIGEST.to_vec(), "digest mismatch");
    }

    #[test]
    fn test_kat_encrypt_vector_3() {
        let result = attachment_encrypt_inner(V3_PLAINTEXT, &V3_KEY, &V3_IV)
            .expect("encrypt should succeed");
        assert_eq!(result.ciphertext, V3_CIPHERTEXT.to_vec(), "ciphertext mismatch");
        assert_eq!(result.digest, V3_DIGEST.to_vec(), "digest mismatch");
    }

    // -- Decrypt KATs: verify attachment_decrypt recovers expected plaintext --

    #[test]
    fn test_kat_decrypt_vector_1() {
        let plaintext = attachment_decrypt(V1_CIPHERTEXT.to_vec(), V1_KEY.to_vec(), V1_DIGEST.to_vec())
            .expect("decrypt should succeed");
        assert_eq!(plaintext, V1_PLAINTEXT, "plaintext mismatch");
    }

    #[test]
    fn test_kat_decrypt_vector_2() {
        let plaintext = attachment_decrypt(V2_CIPHERTEXT.to_vec(), V2_KEY.to_vec(), V2_DIGEST.to_vec())
            .expect("decrypt should succeed");
        assert_eq!(plaintext, V2_PLAINTEXT, "plaintext mismatch");
    }

    #[test]
    fn test_kat_decrypt_vector_3() {
        let plaintext = attachment_decrypt(V3_CIPHERTEXT.to_vec(), V3_KEY.to_vec(), V3_DIGEST.to_vec())
            .expect("decrypt should succeed");
        assert_eq!(plaintext, V3_PLAINTEXT, "plaintext mismatch");
    }
}
