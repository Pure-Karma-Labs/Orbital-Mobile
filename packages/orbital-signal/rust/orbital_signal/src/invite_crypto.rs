//! Invite-link crypto: encrypt / decrypt a 32-byte group key using a
//! symmetric key derived from an invite code and group ID.
//!
//! Wire format: `nonce(12) || ciphertext(32) || tag(16)` = 60 bytes.
//!
//! Key derivation: HKDF-SHA256(ikm = invite_code, salt = group_id,
//! info = "orbital-invite-v1") → 32-byte AES-256-GCM key.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::error::SignalError;

const INVITE_HKDF_INFO: &[u8] = b"orbital-invite-v1";
const INVITE_NONCE_LEN: usize = 12;
const INVITE_KEY_LEN: usize = 32;
const INVITE_TAG_LEN: usize = 16;
const INVITE_BLOB_LEN: usize = INVITE_NONCE_LEN + INVITE_KEY_LEN + INVITE_TAG_LEN;

fn invite_derive_key(
    invite_code: &[u8],
    group_id: &[u8],
) -> Result<Zeroizing<[u8; 32]>, SignalError> {
    let hk = Hkdf::<Sha256>::new(Some(group_id), invite_code);
    let mut okm = Zeroizing::new([0u8; 32]);
    hk.expand(INVITE_HKDF_INFO, &mut *okm).map_err(|_| SignalError::InternalError {
        reason: "invite: HKDF expand failed".into(),
    })?;
    Ok(okm)
}

#[uniffi::export]
pub fn invite_encrypt_group_key(
    group_key: Vec<u8>,
    invite_code: Vec<u8>,
    group_id: Vec<u8>,
) -> Result<Vec<u8>, SignalError> {
    let group_key = Zeroizing::new(group_key);

    if group_key.len() != INVITE_KEY_LEN {
        return Err(SignalError::InvalidArgument {
            reason: format!(
                "invite_encrypt: group_key must be exactly {} bytes, got {}",
                INVITE_KEY_LEN,
                group_key.len()
            ),
        });
    }
    if invite_code.is_empty() {
        return Err(SignalError::InvalidArgument {
            reason: "invite_encrypt: invite_code must not be empty".into(),
        });
    }
    if group_id.is_empty() {
        return Err(SignalError::InvalidArgument {
            reason: "invite_encrypt: group_id must not be empty".into(),
        });
    }

    let derived_key = invite_derive_key(&invite_code, &group_id)?;

    let cipher = Aes256Gcm::new_from_slice(&*derived_key).map_err(|_| {
        SignalError::InternalError {
            reason: "invite_encrypt: failed to construct AES-256-GCM cipher".into(),
        }
    })?;

    let mut nonce_bytes = [0u8; INVITE_NONCE_LEN];
    rand::fill(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher.encrypt(nonce, group_key.as_ref()).map_err(|_| {
        SignalError::InternalError {
            reason: "invite_encrypt: AES-256-GCM encryption failed".into(),
        }
    })?;

    let mut blob = Vec::with_capacity(INVITE_BLOB_LEN);
    blob.extend_from_slice(&nonce_bytes);
    blob.extend_from_slice(&ciphertext);

    Ok(blob)
}

#[uniffi::export]
pub fn invite_decrypt_group_key(
    encrypted_blob: Vec<u8>,
    invite_code: Vec<u8>,
    group_id: Vec<u8>,
) -> Result<Vec<u8>, SignalError> {
    if encrypted_blob.len() != INVITE_BLOB_LEN {
        return Err(SignalError::InvalidArgument {
            reason: format!(
                "invite_decrypt: encrypted_blob must be exactly {} bytes, got {}",
                INVITE_BLOB_LEN,
                encrypted_blob.len()
            ),
        });
    }
    if invite_code.is_empty() {
        return Err(SignalError::InvalidArgument {
            reason: "invite_decrypt: invite_code must not be empty".into(),
        });
    }
    if group_id.is_empty() {
        return Err(SignalError::InvalidArgument {
            reason: "invite_decrypt: group_id must not be empty".into(),
        });
    }

    let nonce_bytes = &encrypted_blob[..INVITE_NONCE_LEN];
    let ciphertext_with_tag = &encrypted_blob[INVITE_NONCE_LEN..];

    let derived_key = invite_derive_key(&invite_code, &group_id)?;

    let cipher = Aes256Gcm::new_from_slice(&*derived_key).map_err(|_| {
        SignalError::InternalError {
            reason: "invite_decrypt: failed to construct AES-256-GCM cipher".into(),
        }
    })?;

    let nonce = Nonce::from_slice(nonce_bytes);

    let plaintext = cipher.decrypt(nonce, ciphertext_with_tag).map_err(|_| {
        SignalError::InvalidMessage {
            reason: "decryption failed".into(),
        }
    })?;

    Ok(plaintext)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_GROUP_KEY: [u8; 32] = [0x42u8; 32];
    const TEST_INVITE_CODE: &[u8] = b"ABCDEFGHJKMNPQRSTVW0";
    const TEST_GROUP_ID: &[u8] = b"550e8400-e29b-41d4-a716-446655440000";

    fn gk() -> Vec<u8> { TEST_GROUP_KEY.to_vec() }
    fn ic() -> Vec<u8> { TEST_INVITE_CODE.to_vec() }
    fn gid() -> Vec<u8> { TEST_GROUP_ID.to_vec() }

    #[test]
    fn test_roundtrip() {
        let blob = invite_encrypt_group_key(gk(), ic(), gid()).expect("encrypt");
        assert_eq!(blob.len(), INVITE_BLOB_LEN);
        let recovered = invite_decrypt_group_key(blob, ic(), gid()).expect("decrypt");
        assert_eq!(recovered, gk());
    }

    #[test]
    fn test_wrong_invite_code_fails() {
        let blob = invite_encrypt_group_key(gk(), ic(), gid()).expect("encrypt");
        let wrong_code = b"XXXXXXXXXXXXXXXXXXX1".to_vec();
        let err = invite_decrypt_group_key(blob, wrong_code, gid()).unwrap_err();
        assert!(matches!(err, SignalError::InvalidMessage { .. }));
    }

    #[test]
    fn test_wrong_group_id_fails() {
        let blob = invite_encrypt_group_key(gk(), ic(), gid()).expect("encrypt");
        let wrong_gid = b"00000000-0000-0000-0000-000000000000".to_vec();
        let err = invite_decrypt_group_key(blob, ic(), wrong_gid).unwrap_err();
        assert!(matches!(err, SignalError::InvalidMessage { .. }));
    }

    #[test]
    fn test_tampered_ciphertext_fails() {
        let mut blob = invite_encrypt_group_key(gk(), ic(), gid()).expect("encrypt");
        blob[20] ^= 0xFF;
        let err = invite_decrypt_group_key(blob, ic(), gid()).unwrap_err();
        assert!(matches!(err, SignalError::InvalidMessage { .. }));
    }

    #[test]
    fn test_tampered_nonce_fails() {
        let mut blob = invite_encrypt_group_key(gk(), ic(), gid()).expect("encrypt");
        blob[0] ^= 0xFF;
        let err = invite_decrypt_group_key(blob, ic(), gid()).unwrap_err();
        assert!(matches!(err, SignalError::InvalidMessage { .. }));
    }

    #[test]
    fn test_tampered_tag_fails() {
        let mut blob = invite_encrypt_group_key(gk(), ic(), gid()).expect("encrypt");
        let last = blob.len() - 1;
        blob[last] ^= 0xFF;
        let err = invite_decrypt_group_key(blob, ic(), gid()).unwrap_err();
        assert!(matches!(err, SignalError::InvalidMessage { .. }));
    }

    #[test]
    fn test_short_blob_rejected() {
        let err = invite_decrypt_group_key(vec![0u8; 59], ic(), gid()).unwrap_err();
        assert!(matches!(err, SignalError::InvalidArgument { .. }));
    }

    #[test]
    fn test_long_blob_rejected() {
        let err = invite_decrypt_group_key(vec![0u8; 61], ic(), gid()).unwrap_err();
        assert!(matches!(err, SignalError::InvalidArgument { .. }));
    }

    #[test]
    fn test_short_group_key_rejected() {
        let err = invite_encrypt_group_key(vec![0u8; 31], ic(), gid()).unwrap_err();
        assert!(matches!(err, SignalError::InvalidArgument { .. }));
    }

    #[test]
    fn test_long_group_key_rejected() {
        let err = invite_encrypt_group_key(vec![0u8; 33], ic(), gid()).unwrap_err();
        assert!(matches!(err, SignalError::InvalidArgument { .. }));
    }

    #[test]
    fn test_empty_invite_code_rejected() {
        let err = invite_encrypt_group_key(gk(), vec![], gid()).unwrap_err();
        assert!(matches!(err, SignalError::InvalidArgument { .. }));

        let blob = invite_encrypt_group_key(gk(), ic(), gid()).unwrap();
        let err = invite_decrypt_group_key(blob, vec![], gid()).unwrap_err();
        assert!(matches!(err, SignalError::InvalidArgument { .. }));
    }

    #[test]
    fn test_empty_group_id_rejected() {
        let err = invite_encrypt_group_key(gk(), ic(), vec![]).unwrap_err();
        assert!(matches!(err, SignalError::InvalidArgument { .. }));
    }

    #[test]
    fn test_different_encryptions_produce_different_blobs() {
        let blob1 = invite_encrypt_group_key(gk(), ic(), gid()).unwrap();
        let blob2 = invite_encrypt_group_key(gk(), ic(), gid()).unwrap();
        assert_ne!(blob1, blob2);
        let k1 = invite_decrypt_group_key(blob1, ic(), gid()).unwrap();
        let k2 = invite_decrypt_group_key(blob2, ic(), gid()).unwrap();
        assert_eq!(k1, gk());
        assert_eq!(k2, gk());
    }

    #[test]
    fn test_blob_structure() {
        let blob = invite_encrypt_group_key(gk(), ic(), gid()).unwrap();
        assert_eq!(blob.len(), 60);
        let nonce = &blob[..12];
        assert!(nonce.iter().any(|&b| b != 0));
    }
}
