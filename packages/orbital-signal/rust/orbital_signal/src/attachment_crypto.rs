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
// Streaming attachment decryptor (issue #578)
// ---------------------------------------------------------------------------

use base64::Engine as _;

/// Length of the IV prefix.
const IV_LEN: usize = 16;
/// Length of the trailing HMAC-SHA256 tag.
const MAC_LEN: usize = 32;
/// AES block size.
const BLOCK_LEN: usize = 16;
/// Smallest structurally valid blob: IV(16) + one CBC block(16) + HMAC(32).
const MIN_CT_LEN: u64 = (IV_LEN + BLOCK_LEN + MAC_LEN) as u64;
/// Non-body overhead: IV(16) + HMAC(32).
const CT_OVERHEAD: u64 = (IV_LEN + MAC_LEN) as u64;

/// Base64 engine for the decryptor's FFI boundary (standard alphabet, canonical padding).
const B64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::STANDARD;

/// The single opaque error returned for EVERY content-dependent failure of the
/// streaming decryptor — malformed base64, structural mismatch, MAC mismatch,
/// digest mismatch, pass-2 divergence, bad PKCS7. Identical text to the one-shot
/// `attachment_decrypt` so the two paths are indistinguishable to a caller.
fn decryptor_opaque_error() -> SignalError {
    SignalError::InvalidMessage {
        reason: "decryption failed".to_string(),
    }
}

/// Caller-misuse error (wrong phase / already-terminated decryptor). Distinct
/// from [`decryptor_opaque_error`] on purpose: misuse is a programming bug in
/// the JS layer and carries no information about ciphertext content.
fn decryptor_misuse_error(reason: &str) -> SignalError {
    SignalError::InvalidArgument {
        reason: reason.to_string(),
    }
}

/// Decode a base64 chunk from the FFI boundary.
///
/// **Chunk-alignment contract:** each chunk must be an independently,
/// canonically padded base64 encoding of its own byte range — exactly what
/// RNFS `read(path, len, pos, 'base64')` produces. Slicing one large base64
/// string at arbitrary offsets, or concatenating padded chunk encodings into
/// a single push, is NOT valid input and fails with the opaque error below.
///
/// **Forgiving about ASCII whitespace only.** iOS RNFS `read()` returns
/// line-broken base64, so newlines/spaces/tabs/CRs are stripped before decoding.
/// Every other malformed input (bad alphabet byte, bad length, non-canonical
/// padding) is rejected with the OPAQUE error: mid-stream base64 corruption is
/// indistinguishable from ciphertext corruption, and both must look the same.
fn decode_chunk_base64(input: &str) -> Result<Vec<u8>, SignalError> {
    let bytes = input.as_bytes();
    if bytes.iter().any(u8::is_ascii_whitespace) {
        // Slow path: strip whitespace into a filtered copy first.
        let filtered: Vec<u8> = bytes
            .iter()
            .copied()
            .filter(|b| !b.is_ascii_whitespace())
            .collect();
        B64.decode(&filtered)
    } else {
        // Fast path: no whitespace, decode directly with no intermediate copy.
        B64.decode(bytes)
    }
    .map_err(|_| decryptor_opaque_error())
}

/// Pass-1 state: HMAC + SHA-256 digest verification over the ciphertext blob,
/// before a single plaintext byte exists.
struct VerifyState {
    /// AES-256 key, carried forward into pass 2.
    aes_key: Zeroizing<Vec<u8>>,
    /// Running HMAC-SHA256 over IV || ciphertext (fed only known-non-MAC bytes).
    hmac: HmacSha256,
    /// Pristine clone of the keyed HMAC, used to start pass 2 without retaining
    /// the raw HMAC key bytes a second time.
    hmac_fresh: HmacSha256,
    /// Running SHA-256 over the ENTIRE blob (IV || ciphertext || HMAC).
    digest_hasher: Sha256,
    /// Trailing bytes not yet fed to the HMAC. Held at <= 32 bytes so that the
    /// final 32 bytes (the MAC itself) never reach the HMAC.
    lag: Zeroizing<Vec<u8>>,
    /// Total bytes pushed so far.
    total_len: u64,
    /// Digest bound at construction — JS cannot skip or substitute it.
    expected_digest: Vec<u8>,
}

/// Pass-2 state: streaming AES-256-CBC decryption of an already-verified blob.
struct DecryptState {
    /// AES-256 key, used to build `decryptor` once the IV has arrived.
    aes_key: Zeroizing<Vec<u8>>,
    /// Built lazily once the 16-byte IV has been fully consumed.
    decryptor: Option<Aes256CbcDec>,
    /// Pass-2 HMAC over IV || ciphertext — recomputed to detect a blob that
    /// changed on disk between the two passes (TOCTOU).
    hmac: HmacSha256,
    /// The MAC verified in pass 1; pass 2 must reproduce it exactly.
    expected_mac: [u8; MAC_LEN],
    /// Blob length as established (and structurally validated) by pass 1.
    ct_len: u64,
    /// Body length = `ct_len - 48`; a positive multiple of 16.
    body_len: u64,
    /// Bytes consumed by pass 2 so far.
    pos: u64,
    /// Partial IV accumulator (< 16 bytes).
    iv_buf: Zeroizing<Vec<u8>>,
    /// Partial ciphertext block accumulator (< 16 bytes).
    carry: Zeroizing<Vec<u8>>,
    /// The most recently decrypted plaintext block, held back because it may be
    /// the PKCS7-padded final block.
    held: Option<Zeroizing<Vec<u8>>>,
}

/// The decryptor's phase. `None` in the `Mutex` slot is the terminal state.
/// Both variants are boxed: each carries several hundred bytes of hasher and
/// cipher state, and an unboxed enum would make every `Option<DecryptorPhase>`
/// move copy the larger of the two (clippy::large_enum_variant).
enum DecryptorPhase {
    Verifying(Box<VerifyState>),
    Decrypting(Box<DecryptState>),
}

/// Streaming attachment decryptor using Signal Protocol format
/// (AES-256-CBC + HMAC-SHA256), issue #578.
///
/// Wire format: IV(16) || AES-256-CBC/PKCS7 ciphertext || HMAC-SHA256(32)
///
/// **Two passes over the same on-disk blob, in this order:**
/// 1. `verify_push(chunk_b64)` … `verify_finalize()` — HMAC + SHA-256 digest are
///    verified before any plaintext exists.
/// 2. `decrypt_push(chunk_b64) -> base64` … `decrypt_finalize() -> base64` — the
///    plaintext is streamed out.
///
/// **Why one object rather than a verifier + a decryptor:** a JS-held "verified"
/// token would be forgeable, and uniffi Objects cannot be passed as constructor
/// arguments (see lib.rs). The only route to plaintext is a phase transition
/// gated inside Rust.
///
/// **Poison-on-every-error:** ANY `Err` from ANY method takes the state, so a
/// failed decryptor can never be resumed or coaxed into emitting plaintext.
///
/// **TOCTOU caveat — containment, not prefix authenticity.** Pass 2 recomputes
/// the HMAC and `decrypt_finalize` requires it to equal pass 1's MAC at exactly
/// the same length, but under CBC malleability a blob modified BETWEEN the two
/// passes can emit attacker-influenced plaintext before finalize detects it.
/// Safety is therefore procedural and belongs to the caller: the plaintext
/// `.tmp` file MUST NOT be promoted before `decrypt_finalize` returns `Ok`, MUST
/// be unlinked on every failure path, and MUST NEVER be treated as a resumable
/// artifact.
///
/// **FFI boundary is base64 `String`, not `Vec<u8>`** — RNFS hands JS base64 and
/// hands base64 back; transcoding in Hermes measured 45-120 ms/MB of JS-thread
/// blocking (issue #578 PR-0 benchmark), so Rust owns the transcode.
#[derive(uniffi::Object)]
pub struct AttachmentDecryptor {
    state: Mutex<Option<DecryptorPhase>>,
}

impl std::fmt::Debug for AttachmentDecryptor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let phase = match &*self.state.lock().unwrap() {
            Some(DecryptorPhase::Verifying(_)) => "verifying",
            Some(DecryptorPhase::Decrypting(_)) => "decrypting",
            None => "terminated",
        };
        f.debug_struct("AttachmentDecryptor")
            .field("phase", &phase)
            .finish()
    }
}

#[uniffi::export]
impl AttachmentDecryptor {
    /// Create a streaming decryptor bound to a key and an expected digest.
    ///
    /// `keys` must be exactly 64 bytes: first 32 = AES-256 key, last 32 = HMAC key.
    /// `expected_digest` is the SHA-256 digest of the entire ciphertext blob; it
    /// is bound here so the JS caller cannot skip the digest check.
    ///
    /// A wrong-length `expected_digest` is deliberately NOT rejected here — it
    /// fails opaquely in `verify_finalize`, exactly as the one-shot
    /// `attachment_decrypt` does, so the two paths stay indistinguishable.
    ///
    /// # Errors
    ///
    /// - `InvalidKey` if `keys` is not exactly 64 bytes.
    #[uniffi::constructor]
    pub fn new(keys: Vec<u8>, expected_digest: Vec<u8>) -> Result<Arc<Self>, SignalError> {
        // Zeroize the FFI-boundary key material on drop
        let keys = Zeroizing::new(keys);
        if keys.len() != 64 {
            return Err(SignalError::InvalidKey {
                reason: format!(
                    "attachment decryption requires a 64-byte key (32 AES + 32 HMAC), got {}",
                    keys.len()
                ),
            });
        }

        let aes_key = Zeroizing::new(keys[..32].to_vec());
        let hmac_fresh = <HmacSha256 as Mac>::new_from_slice(&keys[32..64]).map_err(|_| {
            SignalError::InvalidKey {
                reason: "failed to construct HMAC-SHA256".to_string(),
            }
        })?;

        Ok(Arc::new(Self {
            state: Mutex::new(Some(DecryptorPhase::Verifying(Box::new(VerifyState {
                aes_key,
                hmac: hmac_fresh.clone(),
                hmac_fresh,
                digest_hasher: Sha256::new(),
                lag: Zeroizing::new(Vec::with_capacity(MAC_LEN)),
                total_len: 0,
                expected_digest,
            })))),
        }))
    }

    /// Pass 1: feed the next base64 chunk of the ciphertext blob.
    ///
    /// Every byte feeds the digest hasher; only bytes known not to be part of
    /// the trailing 32-byte MAC feed the HMAC.
    ///
    /// # Errors
    ///
    /// - `InvalidMessage` (opaque) if the chunk is not valid base64.
    /// - `InvalidArgument` if the decryptor is not in the verifying phase.
    pub fn verify_push(&self, chunk_b64: String) -> Result<(), SignalError> {
        let mut guard = self.state.lock().unwrap();
        let result = Self::verify_push_inner(&mut guard, &chunk_b64);
        if result.is_err() {
            *guard = None;
        }
        result
    }

    /// Pass 1 completion: structural validation, then HMAC, then digest.
    ///
    /// On success the decryptor transitions to the decrypting phase. On any
    /// failure the decryptor is poisoned and can never emit plaintext.
    ///
    /// # Errors
    ///
    /// - `InvalidMessage` (opaque) on structural, MAC, or digest failure.
    /// - `InvalidArgument` if the decryptor is not in the verifying phase.
    pub fn verify_finalize(&self) -> Result<(), SignalError> {
        let mut guard = self.state.lock().unwrap();
        let result = Self::verify_finalize_inner(&mut guard);
        if result.is_err() {
            *guard = None;
        }
        result
    }

    /// Pass 2: feed the next base64 chunk of the SAME blob, receive base64
    /// plaintext.
    ///
    /// Output lags the input: the final decrypted block is always held back
    /// because it carries the PKCS7 padding, and sub-block remainders wait for
    /// the next chunk. An empty base64 string is a valid (empty) result.
    ///
    /// # Errors
    ///
    /// - `InvalidMessage` (opaque) on malformed base64 or bytes past `ct_len`.
    /// - `InvalidArgument` if the decryptor is not in the decrypting phase.
    pub fn decrypt_push(&self, chunk_b64: String) -> Result<String, SignalError> {
        let mut guard = self.state.lock().unwrap();
        let result = Self::decrypt_push_inner(&mut guard, &chunk_b64).map(|out| B64.encode(out));
        if result.is_err() {
            *guard = None;
        }
        result
    }

    /// Pass 2 completion: length + MAC re-check, PKCS7 strip, terminal state.
    ///
    /// Returns the base64 plaintext tail (the unpadded final block, possibly
    /// empty). The decryptor is consumed either way.
    ///
    /// # Errors
    ///
    /// - `InvalidMessage` (opaque) if pass 2 did not consume exactly `ct_len`
    ///   bytes, if the pass-2 HMAC diverges from pass 1's, or if PKCS7 padding
    ///   is invalid.
    /// - `InvalidArgument` if the decryptor is not in the decrypting phase.
    pub fn decrypt_finalize(&self) -> Result<String, SignalError> {
        let mut guard = self.state.lock().unwrap();
        let result = Self::decrypt_finalize_inner(&mut guard).map(|out| B64.encode(out));
        if result.is_err() {
            *guard = None;
        }
        result
    }
}

/// Inner implementations. Kept out of the `#[uniffi::export]` block: they take
/// the state slot directly so the exported wrappers can apply the
/// poison-on-every-error rule in exactly one place.
impl AttachmentDecryptor {
    fn verify_push_inner(
        slot: &mut Option<DecryptorPhase>,
        chunk_b64: &str,
    ) -> Result<(), SignalError> {
        let state = match slot.as_mut() {
            Some(DecryptorPhase::Verifying(state)) => state,
            Some(DecryptorPhase::Decrypting(_)) => {
                return Err(decryptor_misuse_error(
                    "verify_push called after verify_finalize",
                ));
            }
            None => return Err(decryptor_misuse_error("decryptor is no longer usable")),
        };

        let chunk = decode_chunk_base64(chunk_b64)?;

        state.total_len = state
            .total_len
            .checked_add(chunk.len() as u64)
            .ok_or_else(decryptor_opaque_error)?;

        // Every byte contributes to the digest over the whole blob.
        state.digest_hasher.update(&chunk);

        // Only bytes that cannot be part of the trailing MAC feed the HMAC.
        state.lag.extend_from_slice(&chunk);
        if state.lag.len() > MAC_LEN {
            let feed_len = state.lag.len() - MAC_LEN;
            let feed: Vec<u8> = state.lag.drain(..feed_len).collect();
            state.hmac.update(&feed);
        }

        Ok(())
    }

    fn verify_finalize_inner(slot: &mut Option<DecryptorPhase>) -> Result<(), SignalError> {
        let phase = slot
            .take()
            .ok_or_else(|| decryptor_misuse_error("decryptor is no longer usable"))?;
        let state = match phase {
            DecryptorPhase::Verifying(state) => state,
            DecryptorPhase::Decrypting(_) => {
                return Err(decryptor_misuse_error("verify_finalize already called"));
            }
        };

        let VerifyState {
            aes_key,
            hmac,
            hmac_fresh,
            digest_hasher,
            lag,
            total_len,
            expected_digest,
        } = *state;

        let ct_len = total_len;

        // Structural validation FIRST. A group member holds both the key and the
        // digest and can mint a self-consistent blob of any length, so a blob
        // that is too short or not block-aligned must never reach the hand-rolled
        // block bookkeeping below (where it would truncate silently or panic
        // across the FFI boundary). The one-shot path got this for free from
        // `decrypt_padded_vec_mut`.
        if ct_len < MIN_CT_LEN || !(ct_len - CT_OVERHEAD).is_multiple_of(BLOCK_LEN as u64) {
            return Err(decryptor_opaque_error());
        }

        // Guaranteed by ct_len >= 64, but assert rather than assume.
        if lag.len() != MAC_LEN {
            return Err(decryptor_opaque_error());
        }

        // (1) HMAC over IV || ciphertext — constant-time inside `verify_slice`.
        hmac.verify_slice(lag.as_slice())
            .map_err(|_| decryptor_opaque_error())?;

        // (2) SHA-256 digest over the entire blob — constant-time compare.
        let actual_digest = digest_hasher.finalize();
        if expected_digest.len() != actual_digest.len()
            || !bool::from(actual_digest.as_slice().ct_eq(expected_digest.as_slice()))
        {
            return Err(decryptor_opaque_error());
        }

        let mut expected_mac = [0u8; MAC_LEN];
        expected_mac.copy_from_slice(lag.as_slice());

        *slot = Some(DecryptorPhase::Decrypting(Box::new(DecryptState {
            aes_key,
            decryptor: None,
            hmac: hmac_fresh,
            expected_mac,
            ct_len,
            body_len: ct_len - CT_OVERHEAD,
            pos: 0,
            iv_buf: Zeroizing::new(Vec::with_capacity(IV_LEN)),
            carry: Zeroizing::new(Vec::new()),
            held: None,
        })));

        Ok(())
    }

    fn decrypt_push_inner(
        slot: &mut Option<DecryptorPhase>,
        chunk_b64: &str,
    ) -> Result<Vec<u8>, SignalError> {
        let state = match slot.as_mut() {
            Some(DecryptorPhase::Decrypting(state)) => state,
            Some(DecryptorPhase::Verifying(_)) => {
                return Err(decryptor_misuse_error(
                    "decrypt_push called before verify_finalize",
                ));
            }
            None => return Err(decryptor_misuse_error("decryptor is no longer usable")),
        };

        let chunk = decode_chunk_base64(chunk_b64)?;
        let mut input = chunk.as_slice();
        let mut output = Vec::new();

        // --- Region A: the 16-byte IV ---
        if state.pos < IV_LEN as u64 {
            // pos < 16, so the subtraction and the cast are both in range.
            let want = IV_LEN - state.pos as usize;
            let take = want.min(input.len());
            let (head, rest) = input.split_at(take);
            state.hmac.update(head);
            state.iv_buf.extend_from_slice(head);
            state.pos = state
                .pos
                .checked_add(take as u64)
                .ok_or_else(decryptor_opaque_error)?;
            input = rest;

            if state.iv_buf.len() == IV_LEN {
                let iv: [u8; IV_LEN] =
                    state.iv_buf[..]
                        .try_into()
                        .map_err(|_| SignalError::InternalError {
                            reason: "IV slice conversion failed".to_string(),
                        })?;
                let aes_key = Zeroizing::new(<[u8; 32]>::try_from(&state.aes_key[..]).map_err(
                    |_| SignalError::InternalError {
                        reason: "key slice conversion failed".to_string(),
                    },
                )?);
                state.decryptor = Some(Aes256CbcDec::new(&(*aes_key).into(), &iv.into()));
                state.iv_buf.clear();
            }
        }

        // --- Region B: the CBC body ---
        let body_end = IV_LEN as u64 + state.body_len;
        if state.pos < body_end && !input.is_empty() {
            let remaining = body_end - state.pos;
            let take = usize::try_from(remaining)
                .unwrap_or(usize::MAX)
                .min(input.len());
            let (head, rest) = input.split_at(take);
            state.hmac.update(head);
            state.carry.extend_from_slice(head);

            let full_blocks = state.carry.len() / BLOCK_LEN;
            if full_blocks > 0 {
                let block_bytes = full_blocks * BLOCK_LEN;
                let to_decrypt: Vec<u8> = state.carry.drain(..block_bytes).collect();

                // Move the decryptor and the held block out of `state` so the
                // loop does not hold two mutable borrows of it at once.
                let mut decryptor =
                    state
                        .decryptor
                        .take()
                        .ok_or_else(|| SignalError::InternalError {
                            reason: "CBC decryptor not initialized".to_string(),
                        })?;
                let mut held = state.held.take();

                for ct_block in to_decrypt.chunks_exact(BLOCK_LEN) {
                    let block: [u8; BLOCK_LEN] =
                        ct_block
                            .try_into()
                            .map_err(|_| SignalError::InternalError {
                                reason: "block slice conversion failed".to_string(),
                            })?;
                    let mut block = block.into();
                    decryptor.decrypt_block_mut(&mut block);
                    // Emit the PREVIOUS block; always hold the newest one back,
                    // because it may be the PKCS7-padded final block.
                    if let Some(previous) = held.replace(Zeroizing::new(block.to_vec())) {
                        output.extend_from_slice(&previous);
                    }
                }

                state.decryptor = Some(decryptor);
                state.held = held;
            }

            state.pos = state
                .pos
                .checked_add(take as u64)
                .ok_or_else(decryptor_opaque_error)?;
            input = rest;
        }

        // --- Region C: the trailing MAC (absorbed, never decrypted) ---
        if state.pos < state.ct_len && !input.is_empty() {
            let remaining = state.ct_len - state.pos;
            let take = usize::try_from(remaining)
                .unwrap_or(usize::MAX)
                .min(input.len());
            state.pos = state
                .pos
                .checked_add(take as u64)
                .ok_or_else(decryptor_opaque_error)?;
            input = &input[take..];
        }

        // Anything left over means pass 2 saw more bytes than pass 1 verified.
        if !input.is_empty() {
            return Err(decryptor_opaque_error());
        }

        Ok(output)
    }

    fn decrypt_finalize_inner(slot: &mut Option<DecryptorPhase>) -> Result<Vec<u8>, SignalError> {
        let phase = slot
            .take()
            .ok_or_else(|| decryptor_misuse_error("decryptor is no longer usable"))?;
        let state = match phase {
            DecryptorPhase::Decrypting(state) => state,
            DecryptorPhase::Verifying(_) => {
                return Err(decryptor_misuse_error(
                    "decrypt_finalize called before verify_finalize",
                ));
            }
        };

        let DecryptState {
            hmac,
            expected_mac,
            ct_len,
            pos,
            carry,
            held,
            ..
        } = *state;

        // Pass 2 must have seen exactly the blob pass 1 verified.
        if pos != ct_len || !carry.is_empty() {
            return Err(decryptor_opaque_error());
        }

        let held = held.ok_or_else(decryptor_opaque_error)?;
        if held.len() != BLOCK_LEN {
            return Err(decryptor_opaque_error());
        }

        // The blob must not have changed between the two passes.
        let actual_mac = hmac.finalize().into_bytes();
        if !bool::from(actual_mac.as_slice().ct_eq(&expected_mac)) {
            return Err(decryptor_opaque_error());
        }

        // Strip PKCS7. Safe to branch on padding bytes: the MAC was verified in
        // pass 1 AND re-verified immediately above, so there is no oracle here.
        let pad_len = held[BLOCK_LEN - 1] as usize;
        if pad_len == 0 || pad_len > BLOCK_LEN {
            return Err(decryptor_opaque_error());
        }
        if !held[BLOCK_LEN - pad_len..]
            .iter()
            .all(|&byte| byte as usize == pad_len)
        {
            return Err(decryptor_opaque_error());
        }

        Ok(held[..BLOCK_LEN - pad_len].to_vec())
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

    // -----------------------------------------------------------------------
    // Streaming decryptor tests (AttachmentDecryptor, issue #578)
    // -----------------------------------------------------------------------

    fn b64(bytes: &[u8]) -> String {
        B64.encode(bytes)
    }

    fn unb64(text: &str) -> Vec<u8> {
        B64.decode(text).expect("decryptor output must be valid base64")
    }

    /// Split a blob into base64 chunks of `size` bytes (`usize::MAX` = one chunk).
    fn b64_chunks(blob: &[u8], size: usize) -> Vec<String> {
        assert!(!blob.is_empty(), "blob must be non-empty");
        let size = size.min(blob.len());
        blob.chunks(size).map(b64).collect()
    }

    /// Full two-pass streaming decrypt with independent pass-1 / pass-2 chunkings.
    fn streaming_decrypt(
        blob: &[u8],
        keys: &[u8],
        digest: &[u8],
        pass1_chunk: usize,
        pass2_chunk: usize,
    ) -> Result<Vec<u8>, SignalError> {
        let dec = AttachmentDecryptor::new(keys.to_vec(), digest.to_vec())?;

        for chunk in b64_chunks(blob, pass1_chunk) {
            dec.verify_push(chunk)?;
        }
        dec.verify_finalize()?;

        let mut plaintext = Vec::new();
        for chunk in b64_chunks(blob, pass2_chunk) {
            plaintext.extend_from_slice(&unb64(&dec.decrypt_push(chunk)?));
        }
        plaintext.extend_from_slice(&unb64(&dec.decrypt_finalize()?));
        Ok(plaintext)
    }

    /// A decryptor that has already completed pass 1 over `blob`.
    fn verified_decryptor(blob: &[u8], keys: &[u8], digest: &[u8]) -> Arc<AttachmentDecryptor> {
        let dec = AttachmentDecryptor::new(keys.to_vec(), digest.to_vec())
            .expect("construction should succeed");
        dec.verify_push(b64(blob)).expect("verify_push should succeed");
        dec.verify_finalize().expect("verify_finalize should succeed");
        dec
    }

    /// Forge a blob of EXACTLY `len` bytes carrying a valid HMAC and digest.
    /// Models a group member who holds the key and can mint self-consistent
    /// blobs of arbitrary (including structurally invalid) length.
    fn forge_authenticated_blob(len: usize, keys: &[u8]) -> (Vec<u8>, Vec<u8>) {
        assert!(len >= 32, "forged blob must have room for the MAC");
        let mut blob: Vec<u8> = (0..len - 32).map(|i| (i % 251) as u8).collect();
        let mut mac = <HmacSha256 as Mac>::new_from_slice(&keys[32..64]).expect("valid HMAC key");
        mac.update(&blob);
        blob.extend_from_slice(&mac.finalize().into_bytes());
        assert_eq!(blob.len(), len);
        let digest = Sha256::digest(&blob).to_vec();
        (blob, digest)
    }

    fn assert_opaque(err: &SignalError, context: &str) {
        assert!(
            matches!(err, SignalError::InvalidMessage { reason } if reason == "decryption failed"),
            "{context}: expected the opaque InvalidMessage, got: {err:?}"
        );
    }

    fn assert_misuse(err: &SignalError, context: &str) {
        assert!(
            matches!(err, SignalError::InvalidArgument { .. }),
            "{context}: expected InvalidArgument, got: {err:?}"
        );
    }

    /// A poisoned decryptor must reject every method — and never emit plaintext.
    fn assert_poisoned(dec: &AttachmentDecryptor, context: &str) {
        assert_misuse(
            &dec.verify_push(b64(b"x")).expect_err("verify_push must fail"),
            context,
        );
        assert_misuse(
            &dec.verify_finalize().expect_err("verify_finalize must fail"),
            context,
        );
        assert_misuse(
            &dec.decrypt_push(b64(b"x")).expect_err("decrypt_push must fail"),
            context,
        );
        assert_misuse(
            &dec.decrypt_finalize()
                .expect_err("decrypt_finalize must fail"),
            context,
        );
    }

    /// Parametric: two-pass streaming decrypt == one-shot decrypt, across
    /// plaintext lengths and the full cross product of pass-1 / pass-2 chunkings.
    #[test]
    fn test_streaming_decrypt_matches_oneshot_parametric() {
        let keys = test_keys();
        let iv: [u8; 16] = hex!("0f1e2d3c4b5a69788796a5b4c3d2e1f0");

        let lengths: Vec<usize> = vec![0, 1, 15, 16, 17, 31, 32, 4096 + 13, 1_000_000];

        for &len in &lengths {
            let plaintext: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
            let blob = oneshot_encrypt(&plaintext, &keys, &iv);

            // Byte-at-a-time chunking is O(blob) FFI calls per pass, so it is
            // exercised on the small blobs; the 1 MB case uses realistic sizes.
            let chunkings: Vec<usize> = if len <= 4096 + 13 {
                vec![1, 7, 16, 64, usize::MAX]
            } else {
                vec![1_000, 65_536, 1_048_576, usize::MAX]
            };

            // Cross-check the one-shot path agrees on the same blob.
            let oneshot = attachment_decrypt(
                blob.ciphertext.clone(),
                keys.clone(),
                blob.digest.clone(),
            )
            .expect("one-shot decrypt should succeed");
            assert_eq!(oneshot, plaintext, "one-shot mismatch for len={len}");

            for &pass1 in &chunkings {
                for &pass2 in &chunkings {
                    let streamed =
                        streaming_decrypt(&blob.ciphertext, &keys, &blob.digest, pass1, pass2)
                            .unwrap_or_else(|e| {
                                panic!("streaming decrypt failed for len={len} p1={pass1} p2={pass2}: {e:?}")
                            });
                    assert_eq!(
                        streamed, plaintext,
                        "plaintext mismatch for len={len} pass1={pass1} pass2={pass2}"
                    );
                }
            }
        }
    }

    /// Random-split chunking (deterministic LCG, no rand dev-dependency).
    #[test]
    fn test_streaming_decrypt_random_splits() {
        let keys = test_keys();
        let iv: [u8; 16] = hex!("5566778899aabbcc5566778899aabbcc");

        fn next_rand(state: &mut u64) -> usize {
            *state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((*state >> 33) as usize) % 1024 + 1
        }

        for &len in &[0usize, 1, 15, 16, 17, 31, 32, 4096 + 13, 100_000] {
            let plaintext: Vec<u8> = (0..len).map(|i| (i % 197) as u8).collect();
            let blob = oneshot_encrypt(&plaintext, &keys, &iv);

            let mut rng_state: u64 = len as u64 ^ 0x5157_5245;
            let dec = AttachmentDecryptor::new(keys.clone(), blob.digest.clone())
                .expect("construction should succeed");

            // Pass 1 with random splits
            let mut offset = 0;
            while offset < blob.ciphertext.len() {
                let take = next_rand(&mut rng_state).min(blob.ciphertext.len() - offset);
                dec.verify_push(b64(&blob.ciphertext[offset..offset + take]))
                    .expect("verify_push should succeed");
                offset += take;
            }
            dec.verify_finalize().expect("verify_finalize should succeed");

            // Pass 2 with a DIFFERENT random split
            let mut streamed = Vec::new();
            offset = 0;
            while offset < blob.ciphertext.len() {
                let take = next_rand(&mut rng_state).min(blob.ciphertext.len() - offset);
                let out = dec
                    .decrypt_push(b64(&blob.ciphertext[offset..offset + take]))
                    .expect("decrypt_push should succeed");
                streamed.extend_from_slice(&unb64(&out));
                offset += take;
            }
            streamed.extend_from_slice(
                &unb64(&dec.decrypt_finalize().expect("decrypt_finalize should succeed")),
            );

            assert_eq!(streamed, plaintext, "random-split mismatch for len={len}");
        }
    }

    /// Golden KAT replay through the streaming decryptor with unaligned chunkings.
    #[test]
    fn test_streaming_decrypt_kat_vectors() {
        for (name, ct, key, digest, expected) in [
            ("V1", V1_CIPHERTEXT.to_vec(), V1_KEY.to_vec(), V1_DIGEST.to_vec(), V1_PLAINTEXT),
            ("V2", V2_CIPHERTEXT.to_vec(), V2_KEY.to_vec(), V2_DIGEST.to_vec(), V2_PLAINTEXT),
            ("V3", V3_CIPHERTEXT.to_vec(), V3_KEY.to_vec(), V3_DIGEST.to_vec(), V3_PLAINTEXT),
        ] {
            for (pass1, pass2) in [(3, 5), (7, 13), (1, 64), (usize::MAX, 17)] {
                let plaintext = streaming_decrypt(&ct, &key, &digest, pass1, pass2)
                    .unwrap_or_else(|e| panic!("{name} p1={pass1} p2={pass2} failed: {e:?}"));
                assert_eq!(plaintext, expected, "{name} plaintext mismatch");
            }
        }
    }

    /// Streaming encryptor output feeds the streaming decryptor.
    #[test]
    fn test_streaming_encryptor_to_decryptor_roundtrip() {
        let keys = test_keys();
        let plaintext: Vec<u8> = (0..70_000u32).map(|i| (i % 253) as u8).collect();

        let enc = AttachmentEncryptor::new(keys.clone()).expect("construction should succeed");
        let mut blob = Vec::new();
        for chunk in plaintext.chunks(4_099) {
            blob.extend_from_slice(&enc.push(chunk.to_vec()).expect("push should succeed"));
        }
        let result = enc.finalize().expect("finalize should succeed");
        blob.extend_from_slice(&result.tail);

        let streamed = streaming_decrypt(&blob, &keys, &result.digest, 8_192, 3_331)
            .expect("streaming decrypt should succeed");
        assert_eq!(streamed, plaintext);
    }

    /// Empty base64 chunks are valid no-ops in both passes.
    #[test]
    fn test_streaming_decrypt_empty_chunks_are_noops() {
        let keys = test_keys();
        let iv: [u8; 16] = hex!("00112233445566770011223344556677");
        let plaintext = b"empty chunk tolerance".to_vec();
        let blob = oneshot_encrypt(&plaintext, &keys, &iv);

        let dec = AttachmentDecryptor::new(keys.clone(), blob.digest.clone())
            .expect("construction should succeed");
        dec.verify_push(String::new()).expect("empty verify_push ok");
        dec.verify_push(b64(&blob.ciphertext)).expect("verify_push ok");
        dec.verify_push(String::new()).expect("empty verify_push ok");
        dec.verify_finalize().expect("verify_finalize ok");

        let mut out = Vec::new();
        out.extend_from_slice(&unb64(&dec.decrypt_push(String::new()).expect("empty ok")));
        out.extend_from_slice(&unb64(
            &dec.decrypt_push(b64(&blob.ciphertext)).expect("decrypt_push ok"),
        ));
        out.extend_from_slice(&unb64(&dec.decrypt_push(String::new()).expect("empty ok")));
        out.extend_from_slice(&unb64(&dec.decrypt_finalize().expect("finalize ok")));

        assert_eq!(out, plaintext);
    }

    /// iOS RNFS `read()` returns line-broken base64 — whitespace must be tolerated.
    #[test]
    fn test_streaming_decrypt_tolerates_whitespace_in_base64() {
        let keys = test_keys();
        let iv: [u8; 16] = hex!("9988776655443322998877665544332f");
        let plaintext = b"line-broken base64 from RNFS read()".to_vec();
        let blob = oneshot_encrypt(&plaintext, &keys, &iv);

        // Wrap at 24 chars with CRLF, plus leading/trailing whitespace.
        let wrapped = {
            let raw = b64(&blob.ciphertext);
            let mut out = String::from("\n");
            for (i, ch) in raw.chars().enumerate() {
                if i > 0 && i % 24 == 0 {
                    out.push_str("\r\n");
                }
                out.push(ch);
            }
            out.push_str(" \t\n");
            out
        };
        assert!(wrapped.contains('\n'), "test fixture must contain newlines");

        let dec = AttachmentDecryptor::new(keys.clone(), blob.digest.clone())
            .expect("construction should succeed");
        dec.verify_push(wrapped.clone()).expect("whitespace verify_push should succeed");
        dec.verify_finalize().expect("verify_finalize should succeed");
        let mut out = unb64(&dec.decrypt_push(wrapped).expect("whitespace decrypt_push should succeed"));
        out.extend_from_slice(&unb64(&dec.decrypt_finalize().expect("finalize should succeed")));
        assert_eq!(out, plaintext);
    }

    /// Malformed base64 is opaque (indistinguishable from ciphertext corruption)
    /// and poisons the decryptor in both phases.
    #[test]
    fn test_streaming_decrypt_malformed_base64_is_opaque_and_poisons() {
        let keys = test_keys();
        let iv: [u8; 16] = hex!("abcdefabcdefabcdefabcdefabcdefab");
        let blob = oneshot_encrypt(b"malformed base64", &keys, &iv);

        // Pass 1
        let dec = AttachmentDecryptor::new(keys.clone(), blob.digest.clone())
            .expect("construction should succeed");
        let err = dec
            .verify_push("!!!not base64!!!".to_string())
            .expect_err("malformed base64 must fail");
        assert_opaque(&err, "verify_push malformed base64");
        assert_poisoned(&dec, "after malformed base64 in verify_push");

        // Pass 2
        let dec = verified_decryptor(&blob.ciphertext, &keys, &blob.digest);
        let err = dec
            .decrypt_push("****".to_string())
            .expect_err("malformed base64 must fail");
        assert_opaque(&err, "decrypt_push malformed base64");
        assert_poisoned(&dec, "after malformed base64 in decrypt_push");
    }

    /// Chunk-alignment contract: slicing one big base64 string at a non-group
    /// boundary is invalid input — opaque failure + poison, never a panic or a
    /// distinguishable error. (Valid chunks are what RNFS `read()` produces:
    /// each one an independently padded encoding of its own byte range.)
    #[test]
    fn test_streaming_decrypt_rejects_text_split_base64_chunk() {
        let keys = test_keys();
        let iv: [u8; 16] = hex!("5151515151515151626262626262626f");
        let blob = oneshot_encrypt(b"text-split chunk contract vector", &keys, &iv);

        let dec = AttachmentDecryptor::new(keys, blob.digest.clone())
            .expect("construction should succeed");
        let full = b64(&blob.ciphertext);
        // Split mid-4-char group: neither half is an independently padded encoding.
        let (head, _tail) = full.split_at(6);
        let err = dec
            .verify_push(head.to_string())
            .expect_err("text-split base64 chunk must fail");
        assert_opaque(&err, "verify_push text-split base64 chunk");
        assert_poisoned(&dec, "after text-split base64 chunk");
    }

    /// Chunk-alignment contract: concatenating two independently padded chunk
    /// encodings into a single push is invalid input (embedded padding) —
    /// opaque failure + poison.
    #[test]
    fn test_streaming_decrypt_rejects_concatenated_padded_chunks() {
        let keys = test_keys();
        let iv: [u8; 16] = hex!("7373737373737373848484848484848f");
        let blob = oneshot_encrypt(b"concatenated chunk contract vector", &keys, &iv);

        let dec = AttachmentDecryptor::new(keys, blob.digest.clone())
            .expect("construction should succeed");
        // 50 % 3 != 0, so the first encoding carries '=' padding; concatenating
        // the second after it embeds that padding mid-string.
        let first = b64(&blob.ciphertext[..50]);
        let second = b64(&blob.ciphertext[50..]);
        assert!(
            first.ends_with('='),
            "test requires the first chunk encoding to carry padding"
        );
        let err = dec
            .verify_push(format!("{first}{second}"))
            .expect_err("concatenated padded chunk encodings must fail");
        assert_opaque(&err, "verify_push concatenated padded chunks");
        assert_poisoned(&dec, "after concatenated padded chunks");
    }

    /// Tampered ciphertext body → opaque failure at verify_finalize + poison.
    #[test]
    fn test_streaming_decrypt_tampered_ciphertext_fails_and_poisons() {
        let keys = test_keys();
        let iv: [u8; 16] = hex!("1212121212121212343434343434343e");
        let blob = oneshot_encrypt(b"tampered body test vector", &keys, &iv);

        let mut tampered = blob.ciphertext.clone();
        tampered[20] ^= 0xFF;

        let dec = AttachmentDecryptor::new(keys.clone(), blob.digest.clone())
            .expect("construction should succeed");
        dec.verify_push(b64(&tampered)).expect("verify_push should succeed");
        let err = dec.verify_finalize().expect_err("tampered body must fail");
        assert_opaque(&err, "tampered body");
        assert_poisoned(&dec, "after tampered body");
    }

    /// Tampered MAC → opaque failure at verify_finalize + poison.
    #[test]
    fn test_streaming_decrypt_tampered_mac_fails_and_poisons() {
        let keys = test_keys();
        let iv: [u8; 16] = hex!("2323232323232323454545454545454f");
        let blob = oneshot_encrypt(b"tampered mac test vector", &keys, &iv);

        let mut tampered = blob.ciphertext.clone();
        let mac_start = tampered.len() - 32;
        tampered[mac_start] ^= 0xFF;

        let dec = AttachmentDecryptor::new(keys.clone(), blob.digest.clone())
            .expect("construction should succeed");
        // Chunk across the MAC boundary to exercise the 32-byte lag buffer.
        for chunk in b64_chunks(&tampered, 7) {
            dec.verify_push(chunk).expect("verify_push should succeed");
        }
        let err = dec.verify_finalize().expect_err("tampered MAC must fail");
        assert_opaque(&err, "tampered MAC");
        assert_poisoned(&dec, "after tampered MAC");
    }

    /// Wrong digest (MAC still valid) → opaque failure + poison.
    #[test]
    fn test_streaming_decrypt_wrong_digest_fails_and_poisons() {
        let keys = test_keys();
        let iv: [u8; 16] = hex!("3434343434343434565656565656565a");
        let blob = oneshot_encrypt(b"digest mismatch test", &keys, &iv);

        let dec = AttachmentDecryptor::new(keys.clone(), vec![0x00; 32])
            .expect("construction should succeed");
        dec.verify_push(b64(&blob.ciphertext)).expect("verify_push should succeed");
        let err = dec.verify_finalize().expect_err("wrong digest must fail");
        assert_opaque(&err, "wrong digest");
        assert_poisoned(&dec, "after wrong digest");
    }

    /// A digest of the wrong LENGTH fails opaquely, exactly like the one-shot.
    #[test]
    fn test_streaming_decrypt_wrong_digest_length_fails() {
        let keys = test_keys();
        let iv: [u8; 16] = hex!("45454545454545456767676767676760");
        let blob = oneshot_encrypt(b"short digest test", &keys, &iv);

        let dec = AttachmentDecryptor::new(keys.clone(), vec![0x00; 31])
            .expect("construction should succeed");
        dec.verify_push(b64(&blob.ciphertext)).expect("verify_push should succeed");
        let err = dec.verify_finalize().expect_err("31-byte digest must fail");
        assert_opaque(&err, "wrong digest length");
    }

    /// Structural validation: authenticated blobs whose length cannot be a valid
    /// IV || CBC body || MAC layout are rejected opaquely, without panicking.
    #[test]
    fn test_streaming_decrypt_structural_lengths_rejected() {
        let keys = test_keys();

        // 48 = IV+MAC with a zero-length body; 63 = below the minimum;
        // 65 and 71 = above the minimum but not 16-byte aligned.
        for len in [48usize, 63, 65, 64 + 7] {
            let (blob, digest) = forge_authenticated_blob(len, &keys);

            let dec = AttachmentDecryptor::new(keys.clone(), digest)
                .expect("construction should succeed");
            for chunk in b64_chunks(&blob, 9) {
                dec.verify_push(chunk).expect("verify_push should succeed");
            }
            let err = match dec.verify_finalize() {
                Ok(()) => panic!("len={len} must be rejected"),
                Err(err) => err,
            };
            assert_opaque(&err, &format!("structural len={len}"));
            assert_poisoned(&dec, &format!("after structural len={len}"));
        }
    }

    /// A structurally valid, correctly authenticated 64-byte blob (empty
    /// plaintext) IS accepted — the boundary case just above the rejects.
    #[test]
    fn test_streaming_decrypt_minimum_valid_length_accepted() {
        let keys = test_keys();
        let iv: [u8; 16] = hex!("56565656565656567878787878787871");
        let blob = oneshot_encrypt(b"", &keys, &iv);
        assert_eq!(blob.ciphertext.len(), 64, "empty plaintext must yield a 64-byte blob");

        let streamed = streaming_decrypt(&blob.ciphertext, &keys, &blob.digest, 5, 11)
            .expect("64-byte blob should decrypt");
        assert!(streamed.is_empty(), "empty plaintext expected");
    }

    /// Wrong AES key with the correct HMAC key: pass 1 and the pass-2 MAC both
    /// pass, and the failure lands on PKCS7 — still opaque, still poisoned.
    #[test]
    fn test_streaming_decrypt_wrong_aes_key_same_hmac_key_fails() {
        let keys = test_keys();
        let iv: [u8; 16] = hex!("6767676767676767898989898989898e");
        let blob = oneshot_encrypt(b"aes key mismatch test", &keys, &iv);

        let mut wrong_keys = vec![0x11; 32];
        wrong_keys.extend_from_slice(&keys[32..]);

        let err = streaming_decrypt(&blob.ciphertext, &wrong_keys, &blob.digest, 64, 64)
            .expect_err("wrong AES key must fail");
        assert_opaque(&err, "wrong AES key");
    }

    /// Key length validation happens at construction.
    #[test]
    fn test_streaming_decrypt_key_length_validation() {
        for len in [0usize, 32, 63, 65, 128] {
            let err = AttachmentDecryptor::new(vec![0x00; len], vec![0x00; 32])
                .expect_err("non-64-byte key must fail");
            assert!(
                matches!(err, SignalError::InvalidKey { .. }),
                "len={len} should be InvalidKey, got: {err:?}"
            );
        }
        AttachmentDecryptor::new(vec![0x00; 64], vec![0x00; 32])
            .expect("64-byte key should construct");
    }

    // --- State machine ---

    #[test]
    fn test_streaming_decrypt_push_before_verify_finalize_errors() {
        let keys = test_keys();
        let iv: [u8; 16] = hex!("78787878787878789a9a9a9a9a9a9a9d");
        let blob = oneshot_encrypt(b"phase machine", &keys, &iv);

        let dec = AttachmentDecryptor::new(keys, blob.digest.clone())
            .expect("construction should succeed");
        dec.verify_push(b64(&blob.ciphertext)).expect("verify_push should succeed");

        // No verify_finalize yet — plaintext must be unreachable.
        let err = dec
            .decrypt_push(b64(&blob.ciphertext))
            .expect_err("decrypt_push before verify_finalize must fail");
        assert_misuse(&err, "decrypt_push before verify_finalize");
        assert_poisoned(&dec, "after decrypt-before-verify");
    }

    #[test]
    fn test_streaming_decrypt_finalize_before_verify_finalize_errors() {
        let keys = test_keys();
        let dec = AttachmentDecryptor::new(keys, vec![0x00; 32])
            .expect("construction should succeed");
        let err = dec
            .decrypt_finalize()
            .expect_err("decrypt_finalize before verify_finalize must fail");
        assert_misuse(&err, "decrypt_finalize before verify_finalize");
        assert_poisoned(&dec, "after decrypt_finalize-before-verify");
    }

    #[test]
    fn test_streaming_decrypt_verify_push_after_verify_finalize_errors() {
        let keys = test_keys();
        let iv: [u8; 16] = hex!("8989898989898989abababababababa1");
        let blob = oneshot_encrypt(b"verify push after finalize", &keys, &iv);

        let dec = verified_decryptor(&blob.ciphertext, &keys, &blob.digest);
        let err = dec
            .verify_push(b64(&blob.ciphertext))
            .expect_err("verify_push after verify_finalize must fail");
        assert_misuse(&err, "verify_push after verify_finalize");
        assert_poisoned(&dec, "after verify_push-after-finalize");
    }

    #[test]
    fn test_streaming_decrypt_double_verify_finalize_errors() {
        let keys = test_keys();
        let iv: [u8; 16] = hex!("9a9a9a9a9a9a9a9abcbcbcbcbcbcbcb2");
        let blob = oneshot_encrypt(b"double verify finalize", &keys, &iv);

        let dec = verified_decryptor(&blob.ciphertext, &keys, &blob.digest);
        let err = dec
            .verify_finalize()
            .expect_err("second verify_finalize must fail");
        assert_misuse(&err, "double verify_finalize");
        assert_poisoned(&dec, "after double verify_finalize");
    }

    #[test]
    fn test_streaming_decrypt_push_after_decrypt_finalize_errors() {
        let keys = test_keys();
        let iv: [u8; 16] = hex!("abababababababacdcdcdcdcdcdcdcd3");
        let blob = oneshot_encrypt(b"push after decrypt finalize", &keys, &iv);

        let dec = verified_decryptor(&blob.ciphertext, &keys, &blob.digest);
        dec.decrypt_push(b64(&blob.ciphertext)).expect("decrypt_push should succeed");
        dec.decrypt_finalize().expect("decrypt_finalize should succeed");

        let err = dec
            .decrypt_push(b64(&blob.ciphertext))
            .expect_err("decrypt_push after decrypt_finalize must fail");
        assert_misuse(&err, "decrypt_push after decrypt_finalize");

        let err = dec
            .decrypt_finalize()
            .expect_err("second decrypt_finalize must fail");
        assert_misuse(&err, "double decrypt_finalize");
    }

    /// Any error — even one raised in the middle of a healthy pass 2 — must take
    /// the state, so no subsequent call can emit another plaintext byte.
    #[test]
    fn test_streaming_decrypt_any_error_poisons_mid_pass_two() {
        let keys = test_keys();
        let iv: [u8; 16] = hex!("bcbcbcbcbcbcbcbdededededededede4");
        let plaintext: Vec<u8> = (0..512u32).map(|i| (i % 251) as u8).collect();
        let blob = oneshot_encrypt(&plaintext, &keys, &iv);

        let dec = verified_decryptor(&blob.ciphertext, &keys, &blob.digest);
        // Healthy partial pass 2...
        dec.decrypt_push(b64(&blob.ciphertext[..100]))
            .expect("decrypt_push should succeed");
        // ...then one malformed chunk.
        let err = dec
            .decrypt_push("~~~~".to_string())
            .expect_err("malformed chunk must fail");
        assert_opaque(&err, "mid-pass-2 malformed chunk");
        assert_poisoned(&dec, "after mid-pass-2 error");
    }

    // --- TOCTOU: the blob changes between pass 1 and pass 2 ---

    /// A flipped ciphertext byte in pass 2 diverges from the verified plaintext
    /// at/after the tampered block, and `decrypt_finalize` refuses + poisons.
    #[test]
    fn test_streaming_decrypt_toctou_flipped_byte() {
        let keys = test_keys();
        let iv: [u8; 16] = hex!("cdcdcdcdcdcdcdcefefefefefefefef5");
        let plaintext: Vec<u8> = (0..160u32).map(|i| (i % 251) as u8).collect();
        let blob = oneshot_encrypt(&plaintext, &keys, &iv);

        // Flip a byte inside body block index 2 (blob offset 16 + 32 .. 16 + 48).
        let tamper_offset = 16 + 32 + 5;
        let mut tampered = blob.ciphertext.clone();
        tampered[tamper_offset] ^= 0xFF;

        let dec = verified_decryptor(&blob.ciphertext, &keys, &blob.digest);
        let mut emitted = Vec::new();
        for chunk in b64_chunks(&tampered, 37) {
            emitted.extend_from_slice(
                &unb64(&dec.decrypt_push(chunk).expect("decrypt_push should succeed")),
            );
        }
        let err = dec
            .decrypt_finalize()
            .expect_err("pass-2 tampering must be caught at finalize");
        assert_opaque(&err, "TOCTOU flipped byte");
        assert_poisoned(&dec, "after TOCTOU flipped byte");

        // Containment: everything before the tampered block matches; the
        // tampered block itself does not. (This is why `.tmp` must never be
        // promoted before decrypt_finalize returns Ok.)
        assert!(emitted.len() >= 48, "expected at least 3 emitted blocks");
        assert_eq!(
            &emitted[..32],
            &plaintext[..32],
            "plaintext before the tampered block must be unchanged"
        );
        assert_ne!(
            &emitted[32..48],
            &plaintext[32..48],
            "the tampered block must diverge"
        );
    }

    /// Extra bytes in pass 2 are rejected at push time.
    #[test]
    fn test_streaming_decrypt_toctou_extra_bytes() {
        let keys = test_keys();
        let iv: [u8; 16] = hex!("dededededededeff0f0f0f0f0f0f0f06");
        let blob = oneshot_encrypt(b"grown between passes", &keys, &iv);

        let mut grown = blob.ciphertext.clone();
        grown.extend_from_slice(&[0xAA; 16]);

        let dec = verified_decryptor(&blob.ciphertext, &keys, &blob.digest);
        let err = dec
            .decrypt_push(b64(&grown))
            .expect_err("bytes past ct_len must fail");
        assert_opaque(&err, "TOCTOU extra bytes");
        assert_poisoned(&dec, "after TOCTOU extra bytes");
    }

    /// A truncated blob in pass 2 is caught at finalize (pos != ct_len).
    #[test]
    fn test_streaming_decrypt_toctou_truncated() {
        let keys = test_keys();
        let iv: [u8; 16] = hex!("ef0f0f0f0f0f0f0f1010101010101017");
        let plaintext: Vec<u8> = (0..96u32).map(|i| (i % 251) as u8).collect();
        let blob = oneshot_encrypt(&plaintext, &keys, &iv);

        let truncated = &blob.ciphertext[..blob.ciphertext.len() - 20];

        let dec = verified_decryptor(&blob.ciphertext, &keys, &blob.digest);
        for chunk in b64_chunks(truncated, 23) {
            dec.decrypt_push(chunk).expect("decrypt_push should succeed");
        }
        let err = dec
            .decrypt_finalize()
            .expect_err("truncated pass 2 must fail");
        assert_opaque(&err, "TOCTOU truncated");
        assert_poisoned(&dec, "after TOCTOU truncated");
    }

    /// Swapping in a DIFFERENT but equally long blob between passes is caught by
    /// the pass-2 HMAC re-check.
    #[test]
    fn test_streaming_decrypt_toctou_substituted_blob() {
        let keys = test_keys();
        let iv: [u8; 16] = hex!("f0f0f0f0f0f0f0f02121212121212128");
        let plaintext: Vec<u8> = (0..96u32).map(|i| (i % 251) as u8).collect();
        let blob = oneshot_encrypt(&plaintext, &keys, &iv);

        // Same length, same key — but a different IV, so a different blob.
        let other_iv: [u8; 16] = hex!("0101010101010101020202020202020c");
        let other = oneshot_encrypt(&plaintext, &keys, &other_iv);
        assert_eq!(blob.ciphertext.len(), other.ciphertext.len());

        let dec = verified_decryptor(&blob.ciphertext, &keys, &blob.digest);
        for chunk in b64_chunks(&other.ciphertext, 31) {
            dec.decrypt_push(chunk).expect("decrypt_push should succeed");
        }
        let err = dec
            .decrypt_finalize()
            .expect_err("substituted blob must fail");
        assert_opaque(&err, "TOCTOU substituted blob");
        assert_poisoned(&dec, "after TOCTOU substituted blob");
    }

    /// `Debug` reports the phase only — never key or plaintext material.
    #[test]
    fn test_streaming_decrypt_debug_reports_phase_only() {
        let keys = test_keys();
        let iv: [u8; 16] = hex!("1111222233334444555566667777888f");
        let blob = oneshot_encrypt(b"debug output", &keys, &iv);

        let dec = AttachmentDecryptor::new(keys.clone(), blob.digest.clone())
            .expect("construction should succeed");
        assert!(format!("{dec:?}").contains("verifying"));

        dec.verify_push(b64(&blob.ciphertext)).expect("verify_push should succeed");
        dec.verify_finalize().expect("verify_finalize should succeed");
        assert!(format!("{dec:?}").contains("decrypting"));

        dec.decrypt_push(b64(&blob.ciphertext)).expect("decrypt_push should succeed");
        dec.decrypt_finalize().expect("decrypt_finalize should succeed");
        // Exact match: the phase name is the ONLY thing Debug may reveal.
        assert_eq!(
            format!("{dec:?}"),
            "AttachmentDecryptor { phase: \"terminated\" }"
        );
    }
}
