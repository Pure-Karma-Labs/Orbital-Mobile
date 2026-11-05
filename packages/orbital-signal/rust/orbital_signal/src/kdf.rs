//! HKDF-SHA256 and HMAC-SHA256 primitives for TypeScript.
//!
//! Sole intended caller: the Meta import dedup-key derivation (#924):
//!   K_import   = hkdf_sha256(group_key, b"orbital-meta-import-v1", user_id, 32)
//!   import_key = hmac_sha256(K_import, source || 0x00 || source_item_id)[..16]
//!
//! `source_item_id` is opaque here; #924 owns its internal length-prefixed
//! encoding. `user_id` is the lowercase hyphenated UUID as UTF-8 bytes.
//!
//! These are generic primitives on purpose — see #917 for why a purpose-built
//! export was rejected — but they are not a general-purpose crypto API. Any new
//! caller needs its own domain-separating `salt`. `info` is load-bearing too:
//! for #924 it is the only per-member input, and the backend's cross-member
//! unlinkability depends on it (Orbital-Backend importService.js).
//!
//! `import_key` is unlinkable to the server but recomputable by any orbit
//! member (group key + a public user id), so it must never serve as proof of
//! authorship or a capability. Authorisation stays on the session's author_id.
//!
//! # Zeroization
//!
//! Covered: the owned `ikm` / `key` parameter (wrapped as the first statement,
//! so every early return still wipes it) and the HKDF working `okm` buffer.
//! Not covered — residues no caller can avoid without forking a dependency:
//! uniffi's lift copy, HKDF-Extract's discarded PRK, the three keyed HMAC
//! compression states per HKDF call, `get_der_key`'s zero-padded block, and the
//! return value (Rust `Vec`, `RustBuffer`, Hermes `ArrayBuffer`). `Zeroizing`
//! here is a real but partial mitigation; see the #917 PR body for the long
//! form. The HMAC tag is deliberately NOT wrapped: `into_bytes()` yields a
//! `GenericArray` that does not implement `Zeroize`, so copying it into a
//! `Zeroizing` would add a copy without wiping the original. The tag
//! (`import_key`) is a persisted dedup token, not a secret — the zeroization
//! budget belongs to the group key and `K_import`.
//!
//! Verified against `hkdf` 0.12.4, `hmac` 0.12.1, `uniffi_core` 0.31.2: none
//! has a `zeroize` feature, a `Drop` impl, or any mention of zeroize.
//! Re-verify on any hkdf/hmac/uniffi_core bump.
//!
//! `salt`, `info` and `input` are non-secret by contract and are not zeroized.
//!
//! # Group-key rotation is now coupled to import dedup
//!
//! `K_import` is derived from the orbit's group key, so `import_key` for a
//! given source item changes the moment the group key changes. Every
//! `import_key` already persisted in `import_items` (client) and already
//! stored server-side (#924 and Backend #315) was computed under the *old*
//! key. A rotation therefore (1) makes every previously imported item look
//! new, so a re-import of the same archive would duplicate the entire history,
//! and (2) cannot be fixed by re-deriving, because only the 16-byte MAC is
//! stored (`threads` columns, never served) and the source archive may be gone.
//! `threads.import_key` is also immutable by trigger (Backend migration 046),
//! so any backfill would need an explicit DISABLE TRIGGER. The one viable path
//! is a key epoch carried alongside each `import_key`; it does not exist today.
//! See #917 and #924.
//!
//! # Removal trigger
//!
//! These exports have no caller until #924. If #924 closes without merging,
//! delete `src/kdf.rs` and its `lib.rs` lines, `tests/kdf_kat_tests.rs`,
//! `tools/generate_kdf_kat_vectors.py`, the `mixStub` entries in
//! `__mocks__/orbital-signal.ts`, and the rows in
//! `docs/libsignal-api-surface.md` and `docs/encryption-export-compliance.md`,
//! then regenerate the bindings and rebuild both platforms. Checkable
//! condition: no `src/**/*.{ts,tsx}` match for `hkdfSha256|hmacSha256`.

use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::error::SignalError;

type HmacSha256 = Hmac<Sha256>;

/// RFC 5869 caps HKDF-Expand output at 255 * HashLen. For SHA-256: 8160 bytes.
const HKDF_MAX_OUTPUT_LEN: u32 = 255 * 32;

#[uniffi::export]
pub fn hkdf_sha256(
    ikm: Vec<u8>,
    salt: Vec<u8>,
    info: Vec<u8>,
    output_len: u32,
) -> Result<Vec<u8>, SignalError> {
    let ikm = Zeroizing::new(ikm);

    // output_len is validated FIRST so an absurd value can never reach an
    // allocation path: a JS `-1` lifts as u32::MAX, which would be a 4 GiB
    // vec![0u8; _] if the bound were checked after the alloc.
    if output_len == 0 || output_len > HKDF_MAX_OUTPUT_LEN {
        return Err(SignalError::InvalidArgument {
            reason: format!(
                "hkdf_sha256: output_len must be between 1 and {}, got {}",
                HKDF_MAX_OUTPUT_LEN, output_len
            ),
        });
    }
    if ikm.is_empty() {
        return Err(SignalError::InvalidArgument {
            reason: "hkdf_sha256: ikm must not be empty".into(),
        });
    }
    if salt.is_empty() {
        return Err(SignalError::InvalidArgument {
            reason: "hkdf_sha256: salt must not be empty".into(),
        });
    }
    // RFC 5869 permits an empty `info`, but #924's `info` is the runtime userId
    // — the only input separating one member's K_import from another's. An
    // empty value would silently give every member the same key and nothing
    // downstream would notice, because dedup is scoped by author.
    if info.is_empty() {
        return Err(SignalError::InvalidArgument {
            reason: "hkdf_sha256: info must not be empty".into(),
        });
    }

    let okm = hkdf_sha256_raw(&ikm, Some(&salt), &info, output_len as usize)?;
    Ok(okm.to_vec()) // deliberate copy; the Zeroizing original is wiped on drop
}

#[uniffi::export]
pub fn hmac_sha256(key: Vec<u8>, input: Vec<u8>) -> Result<Vec<u8>, SignalError> {
    let key = Zeroizing::new(key);

    if key.is_empty() {
        return Err(SignalError::InvalidArgument {
            reason: "hmac_sha256: key must not be empty".into(),
        });
    }
    // HMAC over an empty message is well-defined, but in #924 the input is
    // `source || 0x00 || source_item_id` and can never be empty — an empty
    // input means the UTF-8 encoder returned nothing, which is exactly the
    // encodeUTF8-truncation class of bug #373 guards against.
    if input.is_empty() {
        return Err(SignalError::InvalidArgument {
            reason: "hmac_sha256: input must not be empty".into(),
        });
    }

    let mut mac =
        <HmacSha256 as Mac>::new_from_slice(&key).map_err(|_| SignalError::InternalError {
            reason: "hmac_sha256: failed to construct HMAC-SHA256".into(),
        })?;
    mac.update(&input);
    Ok(mac.finalize().into_bytes().to_vec())
}

/// Emptiness policy lives in the exports; this enforces only the RFC length
/// ceiling. Exists so RFC 5869 Test Case 3 (zero-length salt) can be tested
/// without relaxing the export's domain-separation requirement, and stays
/// private so a sibling module cannot bypass that policy.
///
/// Sibling precedent: `invite_crypto.rs`'s `invite_derive_key` is a separate
/// private HKDF helper on purpose (fixed `[u8; 32]`, no heap key) — the two are
/// not merged.
fn hkdf_sha256_raw(
    ikm: &[u8],
    salt: Option<&[u8]>,
    info: &[u8],
    output_len: usize,
) -> Result<Zeroizing<Vec<u8>>, SignalError> {
    let hk = Hkdf::<Sha256>::new(salt, ikm);
    let mut okm = Zeroizing::new(vec![0u8; output_len]);
    hk.expand(info, &mut okm).map_err(|_| SignalError::InternalError {
        reason: "hkdf_sha256: HKDF expand failed".into(),
    })?;
    Ok(okm)
}

#[cfg(test)]
mod tests {
    use super::*;

    const IKM: [u8; 32] = [0x11u8; 32];
    const SALT: &[u8] = b"orbital-kdf-test-salt";
    const INFO: &[u8] = b"orbital-kdf-test-info";
    const KEY: [u8; 32] = [0x22u8; 32];
    const INPUT: &[u8] = b"orbital-kdf-test-input";

    fn ikm() -> Vec<u8> {
        IKM.to_vec()
    }
    fn salt() -> Vec<u8> {
        SALT.to_vec()
    }
    fn info() -> Vec<u8> {
        INFO.to_vec()
    }
    fn key() -> Vec<u8> {
        KEY.to_vec()
    }
    fn input() -> Vec<u8> {
        INPUT.to_vec()
    }

    fn reason(err: SignalError) -> String {
        match err {
            SignalError::InvalidArgument { reason } => reason,
            other => panic!("expected InvalidArgument, got {other:?}"),
        }
    }

    /// RFC 5869 Appendix A.3 (Test Case 3): zero-length salt AND zero-length
    /// info. Goes through the private `_raw` helper because the public export
    /// rejects both as caller bugs. Also documents the verified-in-source fact
    /// that `None` and `Some(&[])` are identical for SHA-256 (hkdf-0.12.4
    /// src/lib.rs: `None` becomes `Output::<H>::default()`, 32 zero bytes;
    /// `Some(&[])` is zero-padded to the same 64-byte HMAC block).
    #[test]
    fn rfc5869_case3_zero_length_salt_and_info() {
        let rfc_ikm = [0x0bu8; 22];
        let expected = [
            0x8du8, 0xa4, 0xe7, 0x75, 0xa5, 0x63, 0xc1, 0x8f, 0x71, 0x5f, 0x80, 0x2a, 0x06, 0x3c,
            0x5a, 0x31, 0xb8, 0xa1, 0x1f, 0x5c, 0x5e, 0xe1, 0x87, 0x9e, 0xc3, 0x45, 0x4e, 0x5f,
            0x3c, 0x73, 0x8d, 0x2d, 0x9d, 0x20, 0x13, 0x95, 0xfa, 0xa4, 0xb6, 0x1a, 0x96, 0xc8,
        ];

        let with_empty = hkdf_sha256_raw(&rfc_ikm, Some(&[]), &[], 42).expect("raw with empty salt");
        assert_eq!(&with_empty[..], &expected[..]);

        let with_none = hkdf_sha256_raw(&rfc_ikm, None, &[], 42).expect("raw with no salt");
        assert_eq!(&with_none[..], &with_empty[..]);
    }

    #[test]
    fn output_len_bounds() {
        let one = hkdf_sha256(ikm(), salt(), info(), 1).expect("output_len 1");
        assert_eq!(one.len(), 1);

        let max = hkdf_sha256(ikm(), salt(), info(), 8160).expect("output_len 8160");
        assert_eq!(max.len(), 8160);

        for bad in [0u32, 8161, u32::MAX] {
            let err = hkdf_sha256(ikm(), salt(), info(), bad).unwrap_err();
            assert!(
                matches!(err, SignalError::InvalidArgument { .. }),
                "output_len {bad} should be rejected"
            );
        }
    }

    #[test]
    fn empty_ikm_rejected() {
        let err = hkdf_sha256(vec![], salt(), info(), 32).unwrap_err();
        assert!(matches!(err, SignalError::InvalidArgument { .. }));
    }

    #[test]
    fn empty_salt_rejected() {
        let err = hkdf_sha256(ikm(), vec![], info(), 32).unwrap_err();
        assert!(matches!(err, SignalError::InvalidArgument { .. }));
    }

    #[test]
    fn empty_info_rejected() {
        let err = hkdf_sha256(ikm(), salt(), vec![], 32).unwrap_err();
        assert!(matches!(err, SignalError::InvalidArgument { .. }));
    }

    #[test]
    fn hmac_empty_key_rejected() {
        let err = hmac_sha256(vec![], input()).unwrap_err();
        assert!(matches!(err, SignalError::InvalidArgument { .. }));
    }

    #[test]
    fn hmac_empty_input_rejected() {
        let err = hmac_sha256(key(), vec![]).unwrap_err();
        assert!(matches!(err, SignalError::InvalidArgument { .. }));
    }

    /// Locks the "no key bytes in error text" property to string equality
    /// rather than a vague grep. Only the parameter name — and, for
    /// output_len, the non-secret offending integer — may appear.
    #[test]
    fn error_texts_are_exact() {
        assert_eq!(
            reason(hkdf_sha256(ikm(), salt(), info(), 0).unwrap_err()),
            "hkdf_sha256: output_len must be between 1 and 8160, got 0"
        );
        assert_eq!(
            reason(hkdf_sha256(ikm(), salt(), info(), 8161).unwrap_err()),
            "hkdf_sha256: output_len must be between 1 and 8160, got 8161"
        );
        assert_eq!(
            reason(hkdf_sha256(vec![], salt(), info(), 32).unwrap_err()),
            "hkdf_sha256: ikm must not be empty"
        );
        assert_eq!(
            reason(hkdf_sha256(ikm(), vec![], info(), 32).unwrap_err()),
            "hkdf_sha256: salt must not be empty"
        );
        assert_eq!(
            reason(hkdf_sha256(ikm(), salt(), vec![], 32).unwrap_err()),
            "hkdf_sha256: info must not be empty"
        );
        assert_eq!(
            reason(hmac_sha256(vec![], input()).unwrap_err()),
            "hmac_sha256: key must not be empty"
        );
        assert_eq!(
            reason(hmac_sha256(key(), vec![]).unwrap_err()),
            "hmac_sha256: input must not be empty"
        );
    }

    #[test]
    fn salt_domain_separation() {
        let a = hkdf_sha256(ikm(), salt(), info(), 32).unwrap();
        let b = hkdf_sha256(ikm(), b"orbital-kdf-other-salt".to_vec(), info(), 32).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn info_domain_separation() {
        let a = hkdf_sha256(ikm(), salt(), info(), 32).unwrap();
        let b = hkdf_sha256(ikm(), salt(), b"orbital-kdf-other-info".to_vec(), 32).unwrap();
        assert_ne!(a, b);
    }

    /// HKDF output is a prefix stream: asking for more bytes must not perturb
    /// the first block. Proves correct multi-block T(i) chunking.
    #[test]
    fn okm_is_a_prefix_stream() {
        let short = hkdf_sha256(ikm(), salt(), info(), 32).unwrap();
        let long = hkdf_sha256(ikm(), salt(), info(), 64).unwrap();
        assert_eq!(short.len(), 32);
        assert_eq!(long.len(), 64);
        assert_eq!(&long[..32], &short[..]);
    }

    #[test]
    fn hmac_tag_is_32_bytes() {
        let tag = hmac_sha256(key(), input()).unwrap();
        assert_eq!(tag.len(), 32);
    }

    #[test]
    fn hmac_one_bit_input_flip_changes_tag() {
        let a = hmac_sha256(key(), input()).unwrap();
        let mut flipped = input();
        flipped[0] ^= 0x01;
        let b = hmac_sha256(key(), flipped).unwrap();
        assert_ne!(a, b);
    }
}
