//! Known-Answer Test vectors for the HKDF-SHA256 / HMAC-SHA256 uniffi exports
//! (`src/kdf.rs`, issue #917). Every assertion below runs through the **public**
//! export, so it covers the validation layer as well as the primitive.
//!
//! ## Why these live in `tests/` and not inline
//!
//! The crate's established split: inline `#[cfg(test)]` for behaviour,
//! `tests/` for hardcoded fixture tables (`golden_ciphertext_tests.rs`
//! precedent). `scripts/rust-input-digest.sh` deliberately excludes `tests/`,
//! so editing a vector here cannot condemn a good xcframework. The one
//! exception is RFC 5869 Test Case 3 (zero-length salt *and* info), which the
//! public export rejects by design; it is tested inline in `src/kdf.rs`
//! against the private `_raw` helper.
//!
//! ## Provenance of the vectors
//!
//! * `rfc5869_*` and `rfc4231_*` are **published values transcribed from
//!   RFC 5869 Appendix A.1-A.3 and RFC 4231 section 4**. They share no code
//!   with the implementation under test. The RFC section is cited in each
//!   docblock.
//! * `kat_utf8_*` and `orbital_import_kat` are minted by
//!   `tools/generate_kdf_kat_vectors.py` — stdlib only (`hashlib`, `hmac`,
//!   `base64`), with HKDF written out from RFC 5869 rather than imported. That
//!   generator **reproduces every RFC value above as a self-check before it
//!   mints anything**, so the RFC tables here are independently verified
//!   transcriptions.
//!
//! ## How to regenerate / re-verify the non-RFC vectors
//!
//! ```sh
//! cd packages/orbital-signal/rust/orbital_signal
//! python3 -I tools/generate_kdf_kat_vectors.py | grep '^FIXTURE:'
//! ```
//!
//! The script prints `SELFCHECK …` lines first; it exits non-zero without
//! minting anything if a published value fails to reproduce.

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use hex_literal::hex;
use orbital_signal::*;

// =============================================================================
// RFC 5869 — HKDF-SHA256 (Appendix A, SHA-256 cases)
// =============================================================================

/// RFC 5869 Appendix A.1, Test Case 1: basic test case with SHA-256.
/// 22-byte IKM, 13-byte salt, 10-byte info, L = 42.
#[test]
fn rfc5869_sha256_case_1() {
    let ikm = vec![0x0bu8; 22];
    let salt: Vec<u8> = (0x00u8..=0x0c).collect();
    let info: Vec<u8> = (0xf0u8..=0xf9).collect();

    let okm = hkdf_sha256(ikm, salt, info, 42).expect("RFC 5869 case 1");

    assert_eq!(
        okm[..],
        hex!(
            "3cb25f25faacd57a90434f64d0362f2a"
            "2d2d0a90cf1a5a4c5db02d56ecc4c5bf"
            "34007208d5b887185865"
        )[..]
    );
}

/// RFC 5869 Appendix A.2, Test Case 2: longer inputs and output, SHA-256.
/// 80-byte IKM / salt / info, L = 82 — three HKDF-Expand blocks.
#[test]
fn rfc5869_sha256_case_2() {
    let ikm: Vec<u8> = (0x00u8..=0x4f).collect();
    let salt: Vec<u8> = (0x60u8..=0xaf).collect();
    let info: Vec<u8> = (0xb0u8..=0xff).collect();
    assert_eq!((ikm.len(), salt.len(), info.len()), (80, 80, 80));

    let okm = hkdf_sha256(ikm, salt, info, 82).expect("RFC 5869 case 2");

    assert_eq!(
        okm[..],
        hex!(
            "b11e398dc80327a1c8e7f78c596a4934"
            "4f012eda2d4efad8a050cc4c19afa97c"
            "59045a99cac7827271cb41c65e590e09"
            "da3275600c2f09b8367793a9aca3db71"
            "cc30c58179ec3e87c14c01d5c1f3434f"
            "1d87"
        )[..]
    );
}

// =============================================================================
// RFC 4231 — HMAC-SHA-256 (section 4, all seven cases)
// =============================================================================

/// RFC 4231 section 4.2, Test Case 1.
#[test]
fn rfc4231_case_1() {
    let tag = hmac_sha256(vec![0x0bu8; 20], b"Hi There".to_vec()).expect("RFC 4231 case 1");
    assert_eq!(
        tag[..],
        hex!("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7")[..]
    );
}

/// RFC 4231 section 4.3, Test Case 2: key shorter than the hash length.
#[test]
fn rfc4231_case_2() {
    let tag = hmac_sha256(b"Jefe".to_vec(), b"what do ya want for nothing?".to_vec())
        .expect("RFC 4231 case 2");
    assert_eq!(
        tag[..],
        hex!("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843")[..]
    );
}

/// RFC 4231 section 4.4, Test Case 3.
#[test]
fn rfc4231_case_3() {
    let tag = hmac_sha256(vec![0xaau8; 20], vec![0xddu8; 50]).expect("RFC 4231 case 3");
    assert_eq!(
        tag[..],
        hex!("773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe")[..]
    );
}

/// RFC 4231 section 4.5, Test Case 4: 25-byte incrementing key.
#[test]
fn rfc4231_case_4() {
    let key: Vec<u8> = (0x01u8..=0x19).collect();
    assert_eq!(key.len(), 25);
    let tag = hmac_sha256(key, vec![0xcdu8; 50]).expect("RFC 4231 case 4");
    assert_eq!(
        tag[..],
        hex!("82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b")[..]
    );
}

/// RFC 4231 section 4.6, Test Case 5: HMAC-SHA-256-128, i.e. the tag truncated
/// to its first 16 bytes. The RFC publishes only the truncated value, which is
/// why this asserts `tag[..16]` — and that doubles as coverage of the exact
/// 16-byte truncation #924 performs on `import_key`.
#[test]
fn rfc4231_case_5() {
    let tag = hmac_sha256(vec![0x0cu8; 20], b"Test With Truncation".to_vec())
        .expect("RFC 4231 case 5");
    assert_eq!(tag.len(), 32, "the export always returns the full tag");
    assert_eq!(tag[..16], hex!("a3b6167473100ee06e0c796c2955552b")[..]);
}

/// RFC 4231 section 4.7, Test Case 6: 131-byte key — exercises `hmac`'s
/// hash-the-key branch in `get_der_key` (key longer than the 64-byte block).
#[test]
fn rfc4231_case_6() {
    let tag = hmac_sha256(
        vec![0xaau8; 131],
        b"Test Using Larger Than Block-Size Key - Hash Key First".to_vec(),
    )
    .expect("RFC 4231 case 6");
    assert_eq!(
        tag[..],
        hex!("60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54")[..]
    );
}

/// RFC 4231 section 4.8, Test Case 7: 131-byte key and a multi-block message.
#[test]
fn rfc4231_case_7() {
    // Written with Rust line continuations (`\` + newline eats the newline and
    // the following indentation), so the length assertion below is what proves
    // no stray space crept in.
    let data = b"This is a test using a larger than block-size key and a larger \
                 than block-size data. The key needs to be hashed before being \
                 used by the HMAC algorithm.";
    assert_eq!(data.len(), 152, "RFC 4231 case 7 data is 152 octets");

    let tag = hmac_sha256(vec![0xaau8; 131], data.to_vec()).expect("RFC 4231 case 7");
    assert_eq!(
        tag[..],
        hex!("9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2")[..]
    );
}

// =============================================================================
// UTF-8 encoder-fidelity vectors (minted; see the header for the recipe)
// =============================================================================
//
// Same ikm/salt for all three HKDF vectors and the same key for all three HMAC
// vectors — only `info` / `input` varies, so a failure localises to the encoded
// text. The `*_INFO_HEX` assertions pin the UTF-8 bytes the vector was minted
// from, so a mangled source literal (a latin1 round trip, a lost ZWJ, a
// surrogate pair rewritten as U+FFFD) fails on the input rather than silently
// shifting the expected output.

const UTF8_IKM: [u8; 32] = [0x11u8; 32];
const UTF8_SALT: &[u8] = b"orbital-kdf-kat-v1";
const UTF8_HMAC_KEY: [u8; 32] = [0x22u8; 32];

/// Plain ASCII baseline.
#[test]
fn kat_utf8_ascii() {
    let text = "orbital-import-2026-11-04";
    assert_eq!(
        text.as_bytes(),
        &hex!("6f72626974616c2d696d706f72742d323032362d31312d3034")[..]
    );

    let okm = hkdf_sha256(
        UTF8_IKM.to_vec(),
        UTF8_SALT.to_vec(),
        text.as_bytes().to_vec(),
        32,
    )
    .expect("hkdf ascii");
    assert_eq!(
        okm[..],
        hex!("9c23d9f5f5118ee5848c65a518a97c86233ab18116044f850a5fa4ecae526861")[..]
    );

    let tag = hmac_sha256(UTF8_HMAC_KEY.to_vec(), text.as_bytes().to_vec()).expect("hmac ascii");
    assert_eq!(
        tag[..],
        hex!("7748eeb958a370228f7802ca393acf22b6de887cfc1f522418435a3aa1eb2c3f")[..]
    );
}

/// Every codepoint is above U+00FF (Cyrillic, CJK, Greek), so a
/// latin1-truncating encoder — the `encodeUTF8` bug class of #373 — cannot
/// represent any of it and produces different bytes.
#[test]
fn kat_utf8_non_latin1() {
    let text = "Пост-日本語-Ω";
    assert!(text.chars().all(|c| c == '-' || c as u32 > 0xFF));
    assert_eq!(
        text.as_bytes(),
        &hex!("d09fd0bed181d1822de697a5e69cace8aa9e2dcea9")[..]
    );

    let okm = hkdf_sha256(
        UTF8_IKM.to_vec(),
        UTF8_SALT.to_vec(),
        text.as_bytes().to_vec(),
        32,
    )
    .expect("hkdf non-latin1");
    assert_eq!(
        okm[..],
        hex!("6a5364d8b63a21f77fb8bdc7fe50dde2db3615b5a58da39f70eb50aa766dd3b0")[..]
    );

    let tag =
        hmac_sha256(UTF8_HMAC_KEY.to_vec(), text.as_bytes().to_vec()).expect("hmac non-latin1");
    assert_eq!(
        tag[..],
        hex!("739fe6a0c5ba2a09d0a6b07a38dafa36ebebf784f063585735b882d7e3b62cf0")[..]
    );
}

/// Non-BMP codepoints (each U+1F46x person is a UTF-16 surrogate pair) joined
/// by U+200D ZERO WIDTH JOINER, plus a regional-indicator flag pair. A JS-side
/// encoder that splits on UTF-16 code units, drops the ZWJ, or normalises the
/// sequence produces different bytes here.
#[test]
fn kat_utf8_emoji() {
    let text = "👩‍👩‍👧‍👦 family 🇺🇸 flag";
    assert!(text.chars().any(|c| c as u32 > 0xFFFF), "needs a non-BMP codepoint");
    assert!(text.contains('\u{200D}'), "needs a ZWJ");
    assert_eq!(
        text.as_bytes(),
        &hex!(
            "f09f91a9e2808df09f91a9e2808df09f"
            "91a7e2808df09f91a62066616d696c79"
            "20f09f87baf09f87b820666c6167"
        )[..]
    );

    let okm = hkdf_sha256(
        UTF8_IKM.to_vec(),
        UTF8_SALT.to_vec(),
        text.as_bytes().to_vec(),
        32,
    )
    .expect("hkdf emoji");
    assert_eq!(
        okm[..],
        hex!("ddc3b5298ba63c27be59e7f52d81a0881e8ac914352ba4d175350856868c6784")[..]
    );

    let tag = hmac_sha256(UTF8_HMAC_KEY.to_vec(), text.as_bytes().to_vec()).expect("hmac emoji");
    assert_eq!(
        tag[..],
        hex!("914ea48afaf0959b86305c3be77f4545f8ad852aa025dab1b09fd72f6b233725")[..]
    );
}

// =============================================================================
// orbital_import_kat — the end-to-end #924 derivation as one fixture
// =============================================================================

/// The cross-layer contract between this crate and #924's TypeScript, pinned
/// as a fixture rather than a round trip. #924's Jest test asserts against the
/// same `IMPORT_KEY_16` / `IMPORT_KEY_B64` values.
///
/// Exact bytes, so nothing is left to interpretation:
///
/// * `ikm`  = the orbit group key, here the synthetic `[0x42; 32]`.
/// * `salt` = `"orbital-meta-import-v1"` as ASCII — the protocol version
///   string. Bumping it is a one-line TypeScript change by design (#917 §0).
/// * `info` = the member's userId as the **lowercase hyphenated UUID** in
///   UTF-8. It is the only per-member input; the backend's cross-member
///   unlinkability depends on it.
/// * `output_len` = 32 → `K_import`.
/// * HMAC input framing = `source` bytes, then a single `0x00`, then
///   `source_item_id` as **opaque bytes**. **#925 owns the length-prefixed
///   framing inside `source_item_id`; #924 passes it through unchanged.**
///   This layer never looks inside it.
/// * `import_key` = the first 16 bytes of the 32-byte tag.
/// * The wire form the server validates (`IMPORT_KEY_B64_RE`) is **standard
///   padded base64** (RFC 4648 section 4) of those 16 bytes — not base64url.
///
/// Vectors are minted with Python's `.encode('utf-8')`, so lone surrogates are
/// out of scope.
///
/// # Fold-forward for the next real `src/kdf.rs` change
///
/// `src/kdf.rs` still carries the stale clause `#924 owns its internal
/// length-prefixed encoding`. It is wrong — #925 owns that framing — and it is
/// deliberately NOT corrected today: `scripts/rust-input-digest.sh` hashes
/// `src/`, so editing even a comment there condemns every built xcframework
/// and forces a Rust rebuild on every machine for a prose fix. `tests/` and
/// `tools/` are excluded, which is why the correction lives here instead.
///
/// Security invariant 30.5 watches for that clause and fails the day someone
/// removes it. **This doc comment is the single home of the two replacement
/// texts**; every other site points here rather than restating them.
///
/// * **`src/kdf.rs` lines 7-8** become: `source_item_id` is opaque here; #925
///   owns its framing; #924 passes it through unchanged.
/// * **`src/kdf.rs` lines 56-64, the removal trigger**, become: the live
///   caller is `src/services/crypto/importCrypto.ts`; invariant 30
///   (`import-kdf-call-sites`) pins both that caller and the generated
///   exports, so any removal must take rule 30 with it.
#[test]
fn orbital_import_kat() {
    const GROUP_KEY: [u8; 32] = [0x42u8; 32];
    const IMPORT_SALT: &[u8] = b"orbital-meta-import-v1";
    const USER_ID: &[u8] = b"3f2a1c6e-8b4d-4f1a-9c7e-5d0a2b6f8e14";
    const SOURCE: &[u8] = b"facebook";
    let source_item_id = "pfbid0Qx7m9Lz2👩‍👩‍👧‍👦-post";

    // Pin the minted input bytes (see kat_utf8_emoji for why).
    assert_eq!(
        source_item_id.as_bytes(),
        &hex!(
            "7066626964305178376d394c7a32f09f"
            "91a9e2808df09f91a9e2808df09f91a7"
            "e2808df09f91a62d706f7374"
        )[..]
    );

    // Step 1: K_import = hkdf_sha256(group_key, salt, user_id, 32)
    let k_import = hkdf_sha256(
        GROUP_KEY.to_vec(),
        IMPORT_SALT.to_vec(),
        USER_ID.to_vec(),
        32,
    )
    .expect("K_import");
    assert_eq!(
        k_import[..],
        hex!("29d7d22cf36b6ed3d5749fb529a8714f82a1e8422df95e6ca3744cdd9d4a8b03")[..]
    );

    // Step 2: import_key = hmac_sha256(K_import, source || 0x00 || item_id)[..16]
    let mut framed = Vec::new();
    framed.extend_from_slice(SOURCE);
    framed.push(0x00);
    framed.extend_from_slice(source_item_id.as_bytes());
    assert_eq!(
        framed[..],
        hex!(
            "66616365626f6f6b007066626964305178"
            "376d394c7a32f09f91a9e2808df09f91a9"
            "e2808df09f91a7e2808df09f91a62d706f"
            "7374"
        )[..]
    );

    let tag = hmac_sha256(k_import, framed).expect("import_key tag");
    assert_eq!(
        tag[..],
        hex!("e947a36857b1a2590992e60b20852f68538746ac9f116acead49cf284f4b0084")[..],
        "full 32-byte tag"
    );
    assert_eq!(
        tag[..16],
        hex!("e947a36857b1a2590992e60b20852f68")[..],
        "the 16-byte import_key #924 persists"
    );

    // The base64 wire form, spelled out so #924's TypeScript test and the
    // server's IMPORT_KEY_B64_RE have one shared literal to agree on. Encoded
    // here rather than merely asserted, so the literal cannot drift from the
    // bytes above. STANDARD (padded, +/ alphabet), not URL_SAFE.
    const IMPORT_KEY_B64: &str = "6UejaFexolkJkuYLIIUvaA==";
    assert_eq!(STANDARD.encode(&tag[..16]), IMPORT_KEY_B64);
}

// =============================================================================
// orbital_import_v1_frame_kat — the same derivation over a REAL #925 frame
// =============================================================================
//
// `orbital_import_kat` above proves the derivation over a hand-written
// `source_item_id`. These two prove it over the bytes #925 actually produces,
// one per `kind`, and are the CROSS-LAYER pin: the frame hex below is asserted
// from the TypeScript side too, by running the real `buildSourceItemId` in
// `src/services/crypto/__tests__/importCrypto.kat.test.ts`. If #925's framing
// ever changes, that test and these fixtures disagree, which is the whole
// point — a silent framing change re-identifies every imported post and a
// re-import would duplicate a member's entire history.
//
// Minted by `tools/generate_kdf_kat_vectors.py`, whose own v1 framer is
// written from #925's LAYOUT SECTION rather than its code and self-checks
// against two goldens `sourceItemId.test.ts` already pins. So the hex here is
// an independently reproduced value, not a string copied between test files.
//
// Same group key and member as `orbital_import_kat`, so `K_import` is
// byte-identical and any difference localises to the frame.

const FRAME_GROUP_KEY: [u8; 32] = [0x42u8; 32];
const FRAME_IMPORT_SALT: &[u8] = b"orbital-meta-import-v1";
const FRAME_USER_ID: &[u8] = b"3f2a1c6e-8b4d-4f1a-9c7e-5d0a2b6f8e14";
const FRAME_K_IMPORT: [u8; 32] =
    hex!("29d7d22cf36b6ed3d5749fb529a8714f82a1e8422df95e6ca3744cdd9d4a8b03");

/// `K_import` for the shared fixture member, asserted against the value
/// `orbital_import_kat` pins so the two sections cannot drift apart.
fn frame_k_import() -> Vec<u8> {
    let k_import = hkdf_sha256(
        FRAME_GROUP_KEY.to_vec(),
        FRAME_IMPORT_SALT.to_vec(),
        FRAME_USER_ID.to_vec(),
        32,
    )
    .expect("K_import");
    assert_eq!(k_import[..], FRAME_K_IMPORT[..]);
    k_import
}

/// `source ‖ 0x00 ‖ source_item_id`, built the one way #924 builds it.
fn frame_hmac_input(source: &[u8], frame: &[u8]) -> Vec<u8> {
    let mut framed = Vec::with_capacity(source.len() + 1 + frame.len());
    framed.extend_from_slice(source);
    framed.push(0x00);
    framed.extend_from_slice(frame);
    framed
}

/// kind 0x01, a Facebook content-derived frame. Everything a naive encoder
/// gets wrong is stacked into one vector: Cyrillic and CJK (every codepoint
/// above U+00FF, so a latin1 truncation changes the bytes), a ZWJ family
/// sequence (non-BMP, i.e. surrogate pairs in UTF-16), a link URL, and three
/// media basenames whose sorted order differs from their file order — with a
/// `.mp4` among them, because a post's identity includes the video #925 holds.
#[test]
fn orbital_import_v1_frame_kat() {
    const SOURCE: &[u8] = b"facebook";
    let frame = hex!(
        "0101000000006553f10000000037d09f"
        "d180d0b8d0b2d0b5d18220e697a5e69c"
        "ace8aa9e20f09f91a9e2808df09f91a9"
        "e2808df09f91a7e2808df09f91a62066"
        "616d696c790000001b68747470733a2f"
        "2f6578616d706c652e6f72672f706f73"
        "742f34320000000300000005612e6a70"
        "6700000005622e6a706700000008636c"
        "69702e6d7034"
    );

    // The frame's own shape, spelled out so a mis-transcribed fixture fails
    // here rather than as an opaque tag mismatch: v1, kind 0x01, and the
    // epoch-SECONDS timestamp 1700000000 (0x6553f100) as a big-endian i64.
    // Deliberately NOT epoch ms — that is `ImportMetaV1.originalCreatedAt`.
    assert_eq!(&frame[..2], &[0x01, 0x01]);
    assert_eq!(&frame[2..10], &1_700_000_000i64.to_be_bytes());

    let framed = frame_hmac_input(SOURCE, &frame);
    assert_eq!(
        framed[..],
        hex!(
            "66616365626f6f6b0001010000000065"
            "53f10000000037d09fd180d0b8d0b2d0"
            "b5d18220e697a5e69cace8aa9e20f09f"
            "91a9e2808df09f91a9e2808df09f91a7"
            "e2808df09f91a62066616d696c790000"
            "001b68747470733a2f2f6578616d706c"
            "652e6f72672f706f73742f3432000000"
            "0300000005612e6a706700000005622e"
            "6a706700000008636c69702e6d7034"
        )[..]
    );

    let tag = hmac_sha256(frame_k_import(), framed).expect("import_key tag");
    assert_eq!(
        tag[..],
        hex!(
            "fabbcb1b141109c7f897c9301aaca8b2"
            "729cdfc2282324944d8b9b45eb044186"
        )[..],
        "full 32-byte tag"
    );
    assert_eq!(
        tag[..16],
        hex!("fabbcb1b141109c7f897c9301aaca8b2")[..],
        "the 16-byte import_key #924 persists"
    );
    assert_eq!(STANDARD.encode(&tag[..16]), "+rvLGxQRCcf4l8kwGqyosg==");
}

/// kind 0x02, an Instagram `fbid` frame — and the only fixture whose `source`
/// is `instagram`, so the `source ‖ 0x00` prefix is pinned for both values the
/// vocabulary admits.
#[test]
fn orbital_import_v2_fbid_frame_kat() {
    const SOURCE: &[u8] = b"instagram";
    let frame = hex!("0102000000113137393938383737363635353434333332");

    // v1, kind 0x02, then a u32 big-endian length of 17 — the fbid's digits.
    assert_eq!(&frame[..2], &[0x01, 0x02]);
    assert_eq!(&frame[2..6], &17u32.to_be_bytes());
    assert_eq!(&frame[6..], b"17998877665544332");

    let framed = frame_hmac_input(SOURCE, &frame);
    assert_eq!(
        framed[..],
        hex!(
            "696e7374616772616d00010200000011"
            "31373939383837373636353534343333"
            "32"
        )[..]
    );

    let tag = hmac_sha256(frame_k_import(), framed).expect("import_key tag");
    assert_eq!(
        tag[..],
        hex!(
            "c724c3c1313aea4ed39332c46084fefa"
            "ecad2358144b2869b972bbe086ae9bc4"
        )[..],
        "full 32-byte tag"
    );
    assert_eq!(tag[..16], hex!("c724c3c1313aea4ed39332c46084fefa")[..]);
    assert_eq!(STANDARD.encode(&tag[..16]), "xyTDwTE66k7TkzLEYIT++g==");
}
