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
// Streaming attachment encryptor (issue #123)
// ---------------------------------------------------------------------------

use std::sync::{Arc, Mutex};

/// Result from finalizing a streaming attachment encryption.
#[derive(Debug, Clone, uniffi::Record)]
pub struct AttachmentEncryptorResult {
    /// Final padded CBC block(s) concatenated with the HMAC-SHA256 tag (32 bytes).
    pub tail: Vec<u8>,
    /// SHA-256 digest over IV || ciphertext || HMAC.
    pub digest: Vec<u8>,
    /// SHA-256 hash of the original plaintext (local integrity only).
    pub plaintext_hash: Vec<u8>,
}

/// Internal state for incremental AES-256-CBC + HMAC-SHA256 encryption.
///
/// Carries the CBC encryptor, running HMAC, two SHA-256 hashers (one for
/// the output digest, one for the plaintext hash), and a sub-block carry
/// buffer for incomplete 16-byte blocks between `push()` calls.
struct EncryptorState {
    /// AES-256-CBC encryptor (block-level; we handle PKCS7 manually at finalize).
    encryptor: Aes256CbcEnc,
    /// Running HMAC-SHA256 over IV || ciphertext.
    hmac: HmacSha256,
    /// Running SHA-256 over IV || ciphertext (for the digest output).
    digest_hasher: Sha256,
    /// Running SHA-256 over the plaintext (for the plaintext_hash output).
    plaintext_hasher: Sha256,
    /// Sub-block remainder from the last push (< 16 bytes).
    carry: Zeroizing<Vec<u8>>,
    /// Whether the IV has been emitted as the first 16 bytes of output.
    iv_emitted: bool,
    /// The IV, retained for prepending to the first push output.
    iv: [u8; 16],
}

/// Streaming attachment encryptor using Signal Protocol format
/// (AES-256-CBC + HMAC-SHA256).
///
/// Wire format: IV(16) || AES-256-CBC/PKCS7 ciphertext || HMAC-SHA256(32)
///
/// Usage: construct with `new(keys)`, call `push(chunk)` zero or more times,
/// then call `finalize()` to get the trailing bytes and digests.
#[derive(uniffi::Object)]
pub struct AttachmentEncryptor {
    state: Mutex<Option<EncryptorState>>,
}

impl std::fmt::Debug for AttachmentEncryptor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let finalized = self.state.lock().unwrap().is_none();
        f.debug_struct("AttachmentEncryptor")
            .field("finalized", &finalized)
            .finish()
    }
}

#[uniffi::export]
impl AttachmentEncryptor {
    /// Create a new streaming encryptor.
    ///
    /// `keys` must be exactly 64 bytes: first 32 = AES-256 key, last 32 = HMAC-SHA256 key.
    /// A fresh 16-byte IV is generated via CSPRNG.
    ///
    /// # Errors
    ///
    /// - `InvalidKey` if `keys` is not exactly 64 bytes.
    #[uniffi::constructor]
    pub fn new(keys: Vec<u8>) -> Result<Arc<Self>, SignalError> {
        // Zeroize the FFI-boundary key material on drop
        let keys = Zeroizing::new(keys);
        let mut iv = [0u8; 16];
        rand::fill(&mut iv);
        Self::new_with_iv_inner(&keys, iv)
    }

    /// Feed plaintext into the encryptor.
    ///
    /// Returns whole encrypted 16-byte blocks. Sub-block remainders are
    /// carried internally until the next `push()` or `finalize()`.
    ///
    /// The FIRST call that produces output will prepend the 16-byte IV.
    ///
    /// # Errors
    ///
    /// - `InvalidArgument` if called after `finalize()`.
    pub fn push(&self, plaintext: Vec<u8>) -> Result<Vec<u8>, SignalError> {
        let mut guard = self.state.lock().unwrap();
        let state = guard.as_mut().ok_or_else(|| SignalError::InvalidArgument {
            reason: "encryptor already finalized".to_string(),
        })?;

        // Feed plaintext into the plaintext hasher
        state.plaintext_hasher.update(&plaintext);

        // Combine carry buffer with new plaintext
        state.carry.extend_from_slice(&plaintext);

        // How many complete 16-byte blocks can we encrypt?
        let full_blocks = state.carry.len() / 16;
        if full_blocks == 0 {
            // No full blocks yet — return IV if this is the first push, else empty
            if !state.iv_emitted {
                state.iv_emitted = true;
                let iv_bytes = state.iv.to_vec();
                // Feed IV into HMAC and digest
                state.hmac.update(&iv_bytes);
                state.digest_hasher.update(&iv_bytes);
                return Ok(iv_bytes);
            }
            return Ok(Vec::new());
        }

        let block_bytes = full_blocks * 16;
        let to_encrypt: Vec<u8> = state.carry.drain(..block_bytes).collect();

        // Encrypt block by block (CBC mode chains internally)
        let mut encrypted = Vec::with_capacity(block_bytes);
        for chunk in to_encrypt.chunks_exact(16) {
            let block: [u8; 16] = chunk.try_into().unwrap();
            let mut block = block.into();
            state.encryptor.encrypt_block_mut(&mut block);
            encrypted.extend_from_slice(&block);
        }

        // Build output: prepend IV if first emission
        let mut output = Vec::new();
        if !state.iv_emitted {
            state.iv_emitted = true;
            let iv_bytes = state.iv.to_vec();
            state.hmac.update(&iv_bytes);
            state.digest_hasher.update(&iv_bytes);
            output.extend_from_slice(&iv_bytes);
        }

        // Feed encrypted bytes into HMAC and digest
        state.hmac.update(&encrypted);
        state.digest_hasher.update(&encrypted);

        output.extend_from_slice(&encrypted);
        Ok(output)
    }

    /// Finalize the encryption, consuming the encryptor state.
    ///
    /// Applies PKCS7 padding to any remaining bytes, encrypts the final block(s),
    /// computes the HMAC tag, and produces the digest.
    ///
    /// Returns `AttachmentEncryptorResult` with `tail` (final ciphertext blocks + HMAC),
    /// `digest` (SHA-256 of IV || ciphertext || HMAC), and `plaintext_hash`.
    ///
    /// # Errors
    ///
    /// - `InvalidArgument` if already finalized.
    pub fn finalize(&self) -> Result<AttachmentEncryptorResult, SignalError> {
        let mut guard = self.state.lock().unwrap();
        let state = guard.take().ok_or_else(|| SignalError::InvalidArgument {
            reason: "encryptor already finalized".to_string(),
        })?;

        let EncryptorState {
            mut encryptor,
            mut hmac,
            mut digest_hasher,
            plaintext_hasher,
            carry,
            iv_emitted,
            iv,
        } = state;

        let mut tail = Vec::new();

        // If IV was never emitted (no push, or push with 0 bytes that didn't emit),
        // prepend it now.
        if !iv_emitted {
            let iv_bytes = iv.to_vec();
            hmac.update(&iv_bytes);
            digest_hasher.update(&iv_bytes);
            tail.extend_from_slice(&iv_bytes);
        }

        // (1) PKCS7-pad the carry buffer and encrypt final block(s).
        // PKCS7 padding: if carry.len() == 0 mod 16, add a full 16-byte padding block.
        let pad_len = 16 - (carry.len() % 16);
        let mut padded = carry.to_vec();
        padded.extend(std::iter::repeat_n(pad_len as u8, pad_len));

        // Encrypt the padded final blocks
        let mut final_ct = Vec::with_capacity(padded.len());
        for chunk in padded.chunks_exact(16) {
            let block: [u8; 16] = chunk.try_into().unwrap();
            let mut block = block.into();
            encryptor.encrypt_block_mut(&mut block);
            final_ct.extend_from_slice(&block);
        }

        // (2) Feed final ct bytes into HMAC and digest
        hmac.update(&final_ct);
        digest_hasher.update(&final_ct);

        tail.extend_from_slice(&final_ct);

        // (3) Finalize HMAC -> 32-byte tag
        let hmac_tag = hmac.finalize().into_bytes();

        // (4) Feed HMAC tag into digest
        digest_hasher.update(hmac_tag);

        // Append HMAC to tail
        tail.extend_from_slice(&hmac_tag);

        // (5) Finalize digest
        let digest = digest_hasher.finalize().to_vec();

        // Finalize plaintext hash
        let plaintext_hash = plaintext_hasher.finalize().to_vec();

        Ok(AttachmentEncryptorResult {
            tail,
            digest,
            plaintext_hash,
        })
    }
}

/// Non-exported deterministic-IV constructor for testing.
///
/// **MUST NOT be `#[uniffi::export]`** — a deterministic-IV function
/// exposed via FFI would allow IV reuse, breaking CBC confidentiality.
/// `#[cfg(test)]` keeps it out of production binaries entirely.
impl AttachmentEncryptor {
    #[cfg(test)]
    pub(crate) fn new_with_iv(keys: &[u8], iv: [u8; 16]) -> Result<Arc<Self>, SignalError> {
        let keys = Zeroizing::new(keys.to_vec());
        Self::new_with_iv_inner(&keys, iv)
    }

    fn new_with_iv_inner(keys: &[u8], iv: [u8; 16]) -> Result<Arc<Self>, SignalError> {
        if keys.len() != 64 {
            return Err(SignalError::InvalidKey {
                reason: format!(
                    "attachment encryption requires a 64-byte key (32 AES + 32 HMAC), got {}",
                    keys.len()
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

        let encryptor = Aes256CbcEnc::new(aes_key.into(), &iv.into());
        let hmac = <HmacSha256 as Mac>::new_from_slice(hmac_key).map_err(|_| {
            SignalError::InvalidKey {
                reason: "failed to construct HMAC-SHA256".to_string(),
            }
        })?;

        Ok(Arc::new(Self {
            state: Mutex::new(Some(EncryptorState {
                encryptor,
                hmac,
                digest_hasher: Sha256::new(),
                plaintext_hasher: Sha256::new(),
                carry: Zeroizing::new(Vec::new()),
                iv_emitted: false,
                iv,
            })),
        }))
    }
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

    // -----------------------------------------------------------------------
    // Streaming encryptor tests (AttachmentEncryptor)
    // -----------------------------------------------------------------------

    /// Helper: run the streaming encryptor with given plaintext, IV, and chunking,
    /// returning the concatenated ciphertext blob and the result struct.
    fn streaming_encrypt(
        plaintext: &[u8],
        keys: &[u8],
        iv: [u8; 16],
        chunk_sizes: &[usize],
    ) -> (Vec<u8>, AttachmentEncryptorResult) {
        let enc = AttachmentEncryptor::new_with_iv(keys, iv)
            .expect("streaming encryptor construction should succeed");

        let mut ciphertext_blob = Vec::new();
        let mut offset = 0;

        for &chunk_size in chunk_sizes {
            let end = std::cmp::min(offset + chunk_size, plaintext.len());
            let chunk = &plaintext[offset..end];
            let out = enc.push(chunk.to_vec()).expect("push should succeed");
            ciphertext_blob.extend_from_slice(&out);
            offset = end;
            if offset >= plaintext.len() {
                break;
            }
        }

        // Push any remaining bytes not covered by chunk_sizes
        if offset < plaintext.len() {
            let out = enc.push(plaintext[offset..].to_vec()).expect("push should succeed");
            ciphertext_blob.extend_from_slice(&out);
        }

        let result = enc.finalize().expect("finalize should succeed");
        ciphertext_blob.extend_from_slice(&result.tail);

        (ciphertext_blob, result)
    }

    /// Helper: run the one-shot encryptor with given plaintext, IV, keys.
    fn oneshot_encrypt(
        plaintext: &[u8],
        keys: &[u8],
        iv: &[u8; 16],
    ) -> AttachmentCryptoResult {
        attachment_encrypt_inner(plaintext, keys, iv).expect("one-shot encrypt should succeed")
    }

    /// Parametric: streaming == one-shot across various plaintext lengths and chunkings.
    #[test]
    fn test_streaming_matches_oneshot_parametric() {
        let keys = test_keys();
        let iv: [u8; 16] = hex!("aabbccdd11223344aabbccdd11223344");

        // Plaintext lengths to test
        let lengths: Vec<usize> = vec![0, 1, 15, 16, 17, 31, 32, 4096 + 13, 1_000_000];

        // Chunking strategies (each is a list of chunk sizes; last chunk picks up remainder)
        let chunkings: Vec<Vec<usize>> = vec![
            vec![1; 1_100_000],       // 1-byte chunks
            vec![7; 200_000],         // 7-byte chunks
            vec![16; 70_000],         // 16-byte (block-aligned) chunks
            vec![usize::MAX],         // one-shot (single huge chunk)
        ];

        for &len in &lengths {
            let plaintext: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();

            for chunking in &chunkings {
                let oneshot = oneshot_encrypt(&plaintext, &keys, &iv);
                let (stream_ct, stream_result) =
                    streaming_encrypt(&plaintext, &keys, iv, chunking);

                assert_eq!(
                    stream_ct, oneshot.ciphertext,
                    "ciphertext mismatch for len={len}, chunking={:?}",
                    &chunking[..std::cmp::min(3, chunking.len())]
                );
                assert_eq!(
                    stream_result.digest, oneshot.digest,
                    "digest mismatch for len={len}"
                );
                assert_eq!(
                    stream_result.plaintext_hash, oneshot.plaintext_hash,
                    "plaintext_hash mismatch for len={len}"
                );
            }
        }
    }

    /// Random-split chunking test (deterministic seed for reproducibility).
    #[test]
    fn test_streaming_matches_oneshot_random_splits() {
        let keys = test_keys();
        let iv: [u8; 16] = hex!("deadbeef12345678deadbeef12345678");

        let lengths: Vec<usize> = vec![0, 1, 15, 16, 17, 31, 32, 4096 + 13, 100_000];

        // Simple LCG for deterministic "random" splits (no external crate needed)
        fn next_rand(state: &mut u64) -> usize {
            *state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((*state >> 33) as usize) % 1024 + 1 // 1..1024
        }

        for &len in &lengths {
            let plaintext: Vec<u8> = (0..len).map(|i| (i % 197) as u8).collect();
            let oneshot = oneshot_encrypt(&plaintext, &keys, &iv);

            // Generate random chunk sizes
            let mut rng_state: u64 = len as u64 ^ 0xCAFEBABE;
            let mut chunks = Vec::new();
            let mut remaining = len;
            while remaining > 0 {
                let size = std::cmp::min(next_rand(&mut rng_state), remaining);
                chunks.push(size);
                remaining -= size;
            }

            let (stream_ct, stream_result) =
                streaming_encrypt(&plaintext, &keys, iv, &chunks);

            assert_eq!(
                stream_ct, oneshot.ciphertext,
                "random-split ciphertext mismatch for len={len}"
            );
            assert_eq!(
                stream_result.digest, oneshot.digest,
                "random-split digest mismatch for len={len}"
            );
            assert_eq!(
                stream_result.plaintext_hash, oneshot.plaintext_hash,
                "random-split plaintext_hash mismatch for len={len}"
            );
        }
    }

    /// KAT replay: existing test vectors through streaming path with unaligned chunking.
    #[test]
    fn test_streaming_kat_vector_1_unaligned() {
        let (stream_ct, stream_result) =
            streaming_encrypt(V1_PLAINTEXT, &V1_KEY, V1_IV, &[3, 5, 7]); // unaligned: 3+5+4
        assert_eq!(stream_ct, V1_CIPHERTEXT.to_vec(), "V1 ciphertext mismatch via streaming");
        assert_eq!(stream_result.digest, V1_DIGEST.to_vec(), "V1 digest mismatch via streaming");
    }

    #[test]
    fn test_streaming_kat_vector_2_unaligned() {
        // Empty plaintext: no push needed, just finalize
        let (stream_ct, stream_result) =
            streaming_encrypt(V2_PLAINTEXT, &V2_KEY, V2_IV, &[]);
        assert_eq!(stream_ct, V2_CIPHERTEXT.to_vec(), "V2 ciphertext mismatch via streaming");
        assert_eq!(stream_result.digest, V2_DIGEST.to_vec(), "V2 digest mismatch via streaming");
    }

    #[test]
    fn test_streaming_kat_vector_3_unaligned() {
        // Block-aligned plaintext with 7-byte chunks: 7+7+2
        let (stream_ct, stream_result) =
            streaming_encrypt(V3_PLAINTEXT, &V3_KEY, V3_IV, &[7, 7, 7]);
        assert_eq!(stream_ct, V3_CIPHERTEXT.to_vec(), "V3 ciphertext mismatch via streaming");
        assert_eq!(stream_result.digest, V3_DIGEST.to_vec(), "V3 digest mismatch via streaming");
    }

    /// push(empty) as first call should return exactly 16 bytes (the IV).
    #[test]
    fn test_streaming_push_empty_first() {
        let keys = test_keys();
        let iv: [u8; 16] = hex!("11111111111111111111111111111111");
        let enc = AttachmentEncryptor::new_with_iv(&keys, iv)
            .expect("construction should succeed");

        let out = enc.push(vec![]).expect("push(empty) should succeed");
        // First push emits the IV (16 bytes) even if no plaintext
        assert_eq!(out.len(), 16, "push(empty) as first call should return exactly 16 bytes (IV)");
        assert_eq!(out, iv.to_vec(), "push(empty) first call should return the IV");

        // Finalize with no plaintext: should produce 16 (padding block) + 32 (HMAC) = 48 bytes in tail
        let result = enc.finalize().expect("finalize should succeed");
        assert_eq!(result.tail.len(), 48, "finalize after push(empty) should produce 48 bytes (16 pad block + 32 HMAC)");
    }

    /// push(1 byte) as first call should return exactly 16 bytes (just IV; the 1 byte is carried).
    #[test]
    fn test_streaming_push_1byte_first() {
        let keys = test_keys();
        let iv: [u8; 16] = hex!("22222222222222222222222222222222");
        let enc = AttachmentEncryptor::new_with_iv(&keys, iv)
            .expect("construction should succeed");

        let out = enc.push(vec![0xAB]).expect("push(1B) should succeed");
        // First push with 1 byte: emits IV (16 bytes), 1 byte is carried (no full block)
        assert_eq!(out.len(), 16, "push(1B) as first call should return exactly 16 bytes (IV only)");
        assert_eq!(&out[..16], &iv, "first 16 bytes should be the IV");
    }

    /// Empty input: finalize alone produces a valid 64-byte blob.
    /// 16 (IV) + 16 (padding block for empty plaintext) + 32 (HMAC) = 64 bytes
    #[test]
    fn test_streaming_empty_input_finalize_only() {
        let keys = test_keys();
        let iv: [u8; 16] = hex!("33333333333333333333333333333333");
        let enc = AttachmentEncryptor::new_with_iv(&keys, iv)
            .expect("construction should succeed");

        // No push calls — finalize immediately
        let result = enc.finalize().expect("finalize should succeed");

        // tail should contain: IV (16) + padding block (16) + HMAC (32) = 64 bytes
        assert_eq!(result.tail.len(), 64, "empty-input finalize should produce 64-byte tail");

        // The first 16 bytes of tail should be the IV
        assert_eq!(&result.tail[..16], &iv, "tail should start with IV");

        // Verify the complete blob decrypts to empty plaintext
        let decrypted = attachment_decrypt(result.tail.clone(), keys.clone(), result.digest.clone())
            .expect("empty-input ciphertext should decrypt");
        assert_eq!(decrypted, Vec::<u8>::new(), "decrypted empty-input should be empty");

        // Cross-check against one-shot
        let oneshot = oneshot_encrypt(b"", &keys, &iv);
        assert_eq!(result.tail, oneshot.ciphertext, "empty-input streaming should match one-shot ciphertext");
        assert_eq!(result.digest, oneshot.digest, "empty-input streaming should match one-shot digest");
    }

    /// Double finalize must error.
    #[test]
    fn test_streaming_double_finalize_errors() {
        let keys = test_keys();
        let enc = AttachmentEncryptor::new(keys).expect("construction should succeed");

        enc.finalize().expect("first finalize should succeed");

        let err = enc.finalize().expect_err("second finalize should fail");
        assert!(
            matches!(err, SignalError::InvalidArgument { .. }),
            "double finalize should be InvalidArgument, got: {err:?}"
        );
    }

    /// Push after finalize must error.
    #[test]
    fn test_streaming_push_after_finalize_errors() {
        let keys = test_keys();
        let enc = AttachmentEncryptor::new(keys).expect("construction should succeed");

        enc.finalize().expect("finalize should succeed");

        let err = enc.push(b"data".to_vec()).expect_err("push after finalize should fail");
        assert!(
            matches!(err, SignalError::InvalidArgument { .. }),
            "push after finalize should be InvalidArgument, got: {err:?}"
        );
    }

    /// Key length validation in streaming encryptor.
    #[test]
    fn test_streaming_key_too_short() {
        let err = AttachmentEncryptor::new(vec![0x00; 63])
            .expect_err("63-byte key should fail");
        assert!(
            matches!(err, SignalError::InvalidKey { .. }),
            "should be InvalidKey, got: {err:?}"
        );
    }

    #[test]
    fn test_streaming_key_too_long() {
        let err = AttachmentEncryptor::new(vec![0x00; 65])
            .expect_err("65-byte key should fail");
        assert!(
            matches!(err, SignalError::InvalidKey { .. }),
            "should be InvalidKey, got: {err:?}"
        );
    }

    /// Verify streaming output is decryptable by the existing attachment_decrypt.
    #[test]
    fn test_streaming_roundtrip_via_decrypt() {
        let keys = test_keys();
        let plaintext = b"streaming roundtrip through decrypt".to_vec();

        let enc = AttachmentEncryptor::new(keys.clone()).expect("construction should succeed");
        let mut ct = Vec::new();

        // Push in 10-byte chunks
        for chunk in plaintext.chunks(10) {
            let out = enc.push(chunk.to_vec()).expect("push should succeed");
            ct.extend_from_slice(&out);
        }

        let result = enc.finalize().expect("finalize should succeed");
        ct.extend_from_slice(&result.tail);

        let decrypted = attachment_decrypt(ct, keys, result.digest)
            .expect("streaming ciphertext should decrypt");
        assert_eq!(decrypted, plaintext);
    }

    /// Verify streaming unique IVs (CSPRNG path).
    #[test]
    fn test_streaming_unique_ivs() {
        let keys = test_keys();

        let enc1 = AttachmentEncryptor::new(keys.clone()).expect("should succeed");
        let enc2 = AttachmentEncryptor::new(keys).expect("should succeed");

        let out1 = enc1.push(vec![]).expect("push should succeed");
        let out2 = enc2.push(vec![]).expect("push should succeed");

        assert_ne!(out1, out2, "streaming encryptors must use unique IVs (CSPRNG)");
    }
}
