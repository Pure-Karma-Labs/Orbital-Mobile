//! Golden-ciphertext regression fixtures for orbital_signal.
//!
//! These tests decrypt HARDCODED byte-literal ciphertexts captured from a known-good
//! build.  Round-trip tests prove encrypt-then-decrypt works within one build but
//! cannot detect a dependency upgrade that silently changes the wire format (both
//! sides change together).  These fixtures catch that: any format drift fails
//! `cargo test` before it can reach production and silently corrupt persisted data.
//!
//! ## How to regenerate fixtures
//!
//! Run the `#[ignore]`d generator tests with:
//!
//! ```sh
//! cargo test --features dev-roundtrip -p orbital_signal \
//!     --test golden_ciphertext_tests -- --ignored --nocapture 2>&1 | grep '^FIXTURE:'
//! ```
//!
//! Copy the printed hex into the corresponding `golden_*` test, rebuild with
//! `cargo test --features dev-roundtrip`, and verify the new fixture decrypts.
//!
//! ## Signal Protocol session fixture
//!
//! SKIPPED — Signal Protocol session ciphertext depends on session state (ratchet
//! counters, chain keys) that changes with every message.  A hardcoded session
//! ciphertext would be coupled to an exact internal session serialization, making
//! it fragile across libsignal patch releases without adding meaningful coverage
//! beyond the existing round-trip tests in protocol_roundtrip_tests.rs.
//!
//! The three fixtures below cover the layers Orbital controls directly:
//! content encryption (AES-256-GCM), key wrapping (signed ECIES), and invite
//! link encryption (HKDF-derived AES-256-GCM).

use hex_literal::hex;
use orbital_signal::*;

/// Helper: encode bytes as lowercase hex string (for generator output only).
#[allow(dead_code)]
fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// =============================================================================
// Fixture generators (#[ignore]d — run manually to capture new fixture bytes)
// =============================================================================

/// Generator: AES-256-GCM content encryption fixture.
///
/// Uses obvious-constant keys so the fixture is clearly synthetic.
/// Prints all values needed to reconstruct the decrypt-only test.
#[test]
#[ignore]
fn generate_content_crypto_fixture() {
    // TEST VECTOR — synthetic key, never used outside this test
    let key = vec![0x01u8; 32];
    let plaintext = b"Hello from Orbital golden test vector!".to_vec();
    let aad = b"golden-test-group-id".to_vec();

    let result = aes_gcm_encrypt(plaintext.clone(), key.clone(), aad.clone())
        .expect("encryption should succeed");

    println!("FIXTURE:content_crypto");
    println!("FIXTURE:key={}", to_hex(&key));
    println!("FIXTURE:plaintext={}", to_hex(&plaintext));
    println!("FIXTURE:aad={}", to_hex(&aad));
    println!("FIXTURE:iv={}", to_hex(&result.iv));
    println!("FIXTURE:ciphertext={}", to_hex(&result.ciphertext));

    // Verify the fixture decrypts correctly
    let recovered = aes_gcm_decrypt(result.ciphertext, result.iv, key, aad)
        .expect("self-check decrypt");
    assert_eq!(recovered, plaintext, "self-check failed");
    println!("FIXTURE:self_check=PASS");
}

/// Generator: signed ECIES envelope fixture.
///
/// Generates sender + recipient keypairs via the crate's API, seals a 32-byte
/// group key, and prints all inputs + the sealed envelope for the decrypt-only test.
#[test]
#[ignore]
fn generate_ecies_fixture() {
    let sender_identity = generate_identity_key_pair();
    let recipient_identity = generate_identity_key_pair();

    // TEST VECTOR — synthetic 32-byte "group key"
    let plaintext = vec![0x42u8; 32];
    let group_id = b"golden-ecies-group-id".to_vec();

    let sealed = ecies_seal(
        plaintext.clone(),
        group_id.clone(),
        recipient_identity.public_key.clone(),
        sender_identity.private_key.clone(),
        sender_identity.public_key.clone(),
    )
    .expect("ecies_seal should succeed");

    assert_eq!(sealed.len(), 190, "ECIES sealed envelope must be 190 bytes");

    println!("FIXTURE:ecies");
    println!(
        "FIXTURE:sender_private_key={}",
        to_hex(&sender_identity.private_key)
    );
    println!(
        "FIXTURE:sender_public_key={}",
        to_hex(&sender_identity.public_key)
    );
    println!(
        "FIXTURE:recipient_private_key={}",
        to_hex(&recipient_identity.private_key)
    );
    println!(
        "FIXTURE:recipient_public_key={}",
        to_hex(&recipient_identity.public_key)
    );
    println!("FIXTURE:plaintext={}", to_hex(&plaintext));
    println!("FIXTURE:group_id={}", to_hex(&group_id));
    println!("FIXTURE:sealed={}", to_hex(&sealed));

    // Verify the fixture opens correctly
    let recovered = ecies_open(
        sealed,
        group_id,
        recipient_identity.private_key,
        sender_identity.public_key,
    )
    .expect("self-check ecies_open");
    assert_eq!(recovered, plaintext, "self-check failed");
    println!("FIXTURE:self_check=PASS");
}

/// Generator: invite-link encryption fixture.
///
/// Uses obvious-constant inputs so the fixture is clearly synthetic.
#[test]
#[ignore]
fn generate_invite_crypto_fixture() {
    // TEST VECTOR — synthetic values, never used outside this test
    let group_key = vec![0x42u8; 32];
    let invite_code = b"GOLDENTESTCODE20".to_vec();
    let group_id = b"golden-invite-group-id".to_vec();

    let blob = invite_encrypt_group_key(group_key.clone(), invite_code.clone(), group_id.clone())
        .expect("invite_encrypt should succeed");

    assert_eq!(blob.len(), 60, "invite blob must be 60 bytes");

    println!("FIXTURE:invite_crypto");
    println!("FIXTURE:group_key={}", to_hex(&group_key));
    println!("FIXTURE:invite_code={}", to_hex(&invite_code));
    println!("FIXTURE:group_id={}", to_hex(&group_id));
    println!("FIXTURE:blob={}", to_hex(&blob));

    // Verify the fixture decrypts correctly
    let recovered =
        invite_decrypt_group_key(blob, invite_code, group_id).expect("self-check invite_decrypt");
    assert_eq!(recovered, group_key, "self-check failed");
    println!("FIXTURE:self_check=PASS");
}

// =============================================================================
// Golden ciphertext tests — decrypt HARDCODED fixtures, assert known plaintext
// =============================================================================

/// Golden fixture 1: AES-256-GCM content encryption.
///
/// Verifies that the current aes-gcm crate decrypts a ciphertext produced by an
/// earlier build.  Catches silent wire-format changes from aes-gcm upgrades.
///
/// Fixture components:
/// - Key: 32 bytes of 0x01 (obvious synthetic constant)
/// - Plaintext: "Hello from Orbital golden test vector!" (38 bytes)
/// - AAD: "golden-test-group-id" (20 bytes)
/// - IV: 12-byte nonce captured from a single encrypt call
/// - Ciphertext: 54 bytes (38 plaintext + 16 GCM auth tag)
#[test]
fn golden_content_crypto_decrypt() {
    // TEST VECTOR — synthetic key, never used outside this test
    let key: Vec<u8> = hex!("01010101 01010101 01010101 01010101 01010101 01010101 01010101 01010101")
        .to_vec();

    // "Hello from Orbital golden test vector!"
    let expected_plaintext: Vec<u8> = hex!(
        "48656c6c 6f206672 6f6d204f 72626974 616c2067 6f6c6465"
        "6e207465 73742076 6563746f 7221"
    )
    .to_vec();

    // "golden-test-group-id"
    let aad: Vec<u8> = hex!("676f6c64 656e2d74 6573742d 67726f75 702d6964").to_vec();

    // Captured IV (12 bytes)
    let iv: Vec<u8> = hex!("4f7665c6 d87a0dcc 5ce713d7").to_vec();

    // Captured ciphertext (38 bytes encrypted data + 16 byte GCM auth tag = 54 bytes)
    let ciphertext: Vec<u8> = hex!(
        "07d399d2 ce4a2c8e 2a2a4313 8aa28517 7cdd0c78 d5c248d9"
        "54657882 195c75d0 620f729f 8a03a7ce 5dba49dd ffa5e623"
        "79fef78f 3f8d"
    )
    .to_vec();

    let decrypted = aes_gcm_decrypt(ciphertext, iv, key, aad)
        .expect("golden content_crypto fixture must decrypt successfully");

    assert_eq!(
        decrypted, expected_plaintext,
        "golden content_crypto: decrypted plaintext does not match fixture"
    );

    // Also verify the plaintext is the expected ASCII string
    assert_eq!(
        String::from_utf8(decrypted).unwrap(),
        "Hello from Orbital golden test vector!"
    );
}

/// Golden fixture 2: signed ECIES sealed envelope.
///
/// Verifies that the current ECIES implementation (X25519 ECDH + HKDF-SHA256 +
/// AES-256-GCM + XEdDSA signature) can open a 190-byte envelope produced by an
/// earlier build.  Catches changes in the KDF info string, envelope layout,
/// or X25519/signature computation.
///
/// Fixture components:
/// - Sender keypair: randomly generated, captured as hex
/// - Recipient keypair: randomly generated, captured as hex
/// - Plaintext: 32 bytes of 0x42 (synthetic group key)
/// - Group ID: "golden-ecies-group-id" (21 bytes)
/// - Sealed envelope: 190 bytes (version + ephemeral_pub + nonce + ct+tag + sender_pub + signature)
#[test]
fn golden_ecies_open() {
    // TEST VECTOR — synthetic keypair captured from generate_ecies_fixture, never used outside this test
    let sender_public_key: Vec<u8> = hex!(
        "05e17777 018f8e77 14e7b65a 941c8820 9426403c 45f3e8fa"
        "e1baec13 6ea6601a 1c"
    )
    .to_vec();

    // TEST VECTOR — synthetic recipient private key, never used outside this test
    let recipient_private_key: Vec<u8> = hex!(
        "f066e663 4db398be 04fc60c9 70d056e0 81a254a1 82e3df17"
        "f111b6e3 db47ae70"
    )
    .to_vec();

    // Synthetic 32-byte "group key"
    let expected_plaintext: Vec<u8> =
        hex!("42424242 42424242 42424242 42424242 42424242 42424242 42424242 42424242")
            .to_vec();

    // "golden-ecies-group-id"
    let group_id: Vec<u8> = hex!(
        "676f6c64 656e2d65 636965732d67726f 75702d69 64"
    )
    .to_vec();

    // Captured 190-byte sealed envelope
    let sealed: Vec<u8> = hex!(
        "02e9bd83 db67d708 be8173ea becc0a18 7ecf30de ca0ea3d3"
        "d9c60f4b b0e35c0d 5a8883da 3f56f2bf 11a7e26e 665e7c4e"
        "ca4fce91 b90a24d5 653fc3e0 92c92235 b9e4668b eacbcb72"
        "241350eb 60362cdb f63066c2 a9839bca 1e5d99d3 2c05e177"
        "77018f8e 7714e7b6 5a941c88 209426403c45f3e8 fae1baec"
        "136ea660 1a1c4ba3 3344f79f 74d1ce4e 118291a4 ee81f0f3"
        "947ee6a1 ef2ced15 ae0ddb89 306c9ca6 f28c0e1f 041ecb52"
        "39114e48 f3bea547 621d9f55 1c34b4c9 3f1c6534 6d82"
    )
    .to_vec();

    assert_eq!(sealed.len(), 190, "sealed envelope must be exactly 190 bytes");

    let decrypted = ecies_open(sealed, group_id, recipient_private_key, sender_public_key)
        .expect("golden ECIES fixture must open successfully");

    assert_eq!(
        decrypted, expected_plaintext,
        "golden ECIES: decrypted group key does not match fixture"
    );
}

/// Golden fixture 3: invite-link encryption.
///
/// Verifies that the current invite crypto (HKDF-SHA256 key derivation +
/// AES-256-GCM) can decrypt a 60-byte invite blob produced by an earlier build.
/// Catches changes in the HKDF info string ("orbital-invite-v1"), salt usage,
/// or blob layout (nonce||ciphertext||tag).
///
/// Fixture components:
/// - Group key: 32 bytes of 0x42 (obvious synthetic constant)
/// - Invite code: "GOLDENTESTCODE20" (16 bytes)
/// - Group ID: "golden-invite-group-id" (22 bytes)
/// - Encrypted blob: 60 bytes (12 nonce + 32 ciphertext + 16 GCM tag)
#[test]
fn golden_invite_crypto_decrypt() {
    // TEST VECTOR — synthetic group key, never used outside this test
    let expected_group_key: Vec<u8> =
        hex!("42424242 42424242 42424242 42424242 42424242 42424242 42424242 42424242")
            .to_vec();

    // "GOLDENTESTCODE20"
    let invite_code: Vec<u8> = hex!("474f4c44 454e5445 5354434f 44453230").to_vec();

    // "golden-invite-group-id"
    let group_id: Vec<u8> = hex!(
        "676f6c64 656e2d69 6e766974 652d6772 6f75702d 6964"
    )
    .to_vec();

    // Captured 60-byte blob (12 nonce + 32 ciphertext + 16 GCM auth tag)
    let blob: Vec<u8> = hex!(
        "82c97976 4ceb0714 e7e686fd fe310442 afbba8ae d23c38ce"
        "9521758a 52354445 c6c128ab 412b1661 24a10a19 66eb8941"
        "b2ca5fc2 2a14890c d670bea3"
    )
    .to_vec();

    assert_eq!(blob.len(), 60, "invite blob must be exactly 60 bytes");

    let decrypted = invite_decrypt_group_key(blob, invite_code, group_id)
        .expect("golden invite fixture must decrypt successfully");

    assert_eq!(
        decrypted, expected_group_key,
        "golden invite_crypto: decrypted group key does not match fixture"
    );
}

// =============================================================================
// Negative tests: verify fixtures have teeth (wrong inputs must fail)
// =============================================================================

/// Verify that corrupting one byte of the content_crypto ciphertext causes decryption
/// to fail.  This proves the golden test actually guards against format changes.
#[test]
fn golden_content_crypto_corrupted_byte_fails() {
    let key: Vec<u8> = hex!("01010101 01010101 01010101 01010101 01010101 01010101 01010101 01010101")
        .to_vec();
    let aad: Vec<u8> = hex!("676f6c64 656e2d74 6573742d 67726f75 702d6964").to_vec();
    let iv: Vec<u8> = hex!("4f7665c6 d87a0dcc 5ce713d7").to_vec();

    let mut ciphertext: Vec<u8> = hex!(
        "07d399d2 ce4a2c8e 2a2a4313 8aa28517 7cdd0c78 d5c248d9"
        "54657882 195c75d0 620f729f 8a03a7ce 5dba49dd ffa5e623"
        "79fef78f 3f8d"
    )
    .to_vec();

    // Corrupt the first byte of ciphertext
    ciphertext[0] ^= 0xFF;

    let result = aes_gcm_decrypt(ciphertext, iv, key, aad);
    assert!(
        result.is_err(),
        "corrupted ciphertext must fail decryption (proves the fixture has teeth)"
    );
}

// ECIES envelope layout (verified against ecies.rs constants and parsing code):
//
//   Offset     Field                   Size    Region
//   ------     -----                   ----    ------
//   [0]        version byte (0x02)      1      \
//   [1..33]    ephemeral X25519 pub    32       |  unsigned portion
//   [33..45]   AES-GCM nonce           12       |  (signed over by XEdDSA)
//   [45..93]   ciphertext + GCM tag    48      /
//   [93..126]  sender public key       33      sender identity (0x05 || 32 raw)
//   [126..190] XEdDSA signature        64      signature over [0..93]
//
// Validation order in ecies_open:
//   1. Length check (190 bytes)
//   2. Version check (byte 0 == 0x02)
//   3. Sender identity check (constant-time eq against expected_sender_public_key)
//   4. Sender public key deserialization
//   5. XEdDSA signature verification over unsigned portion [0..93]
//   6. ECDH + KDF
//   7. AES-256-GCM decryption
//
// The three corruption tests below each pin a specific validation layer so that a
// future refactor that silently reorders or removes a check fails a specific test.

/// Helper: return the golden ECIES fixture inputs (shared across corruption tests).
fn golden_ecies_fixture() -> (Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>) {
    let sender_public_key: Vec<u8> = hex!(
        "05e17777 018f8e77 14e7b65a 941c8820 9426403c 45f3e8fa"
        "e1baec13 6ea6601a 1c"
    )
    .to_vec();
    let recipient_private_key: Vec<u8> = hex!(
        "f066e663 4db398be 04fc60c9 70d056e0 81a254a1 82e3df17"
        "f111b6e3 db47ae70"
    )
    .to_vec();
    let group_id: Vec<u8> = hex!(
        "676f6c64 656e2d65 636965732d67726f 75702d69 64"
    )
    .to_vec();
    let sealed: Vec<u8> = hex!(
        "02e9bd83 db67d708 be8173ea becc0a18 7ecf30de ca0ea3d3"
        "d9c60f4b b0e35c0d 5a8883da 3f56f2bf 11a7e26e 665e7c4e"
        "ca4fce91 b90a24d5 653fc3e0 92c92235 b9e4668b eacbcb72"
        "241350eb 60362cdb f63066c2 a9839bca 1e5d99d3 2c05e177"
        "77018f8e 7714e7b6 5a941c88 209426403c45f3e8 fae1baec"
        "136ea660 1a1c4ba3 3344f79f 74d1ce4e 118291a4 ee81f0f3"
        "947ee6a1 ef2ced15 ae0ddb89 306c9ca6 f28c0e1f 041ecb52"
        "39114e48 f3bea547 621d9f55 1c34b4c9 3f1c6534 6d82"
    )
    .to_vec();
    (sender_public_key, recipient_private_key, group_id, sealed)
}

/// Corruption case 1: Flip a byte in the unsigned (ciphertext) region [45..93].
///
/// Layer exercised: XEdDSA signature verification (step 5).
/// The unsigned portion has changed but the signature has not, so
/// `verify_signature(corrupted_unsigned, original_signature)` must fail.
#[test]
fn golden_ecies_corrupted_ciphertext_region_fails() {
    let (sender_pub, recipient_priv, group_id, mut sealed) = golden_ecies_fixture();

    // Offset 50 is within the ciphertext+tag field [45..93], part of the unsigned
    // portion that the XEdDSA signature covers.
    sealed[50] ^= 0xFF;

    let err = ecies_open(sealed, group_id, recipient_priv, sender_pub)
        .expect_err("corrupted unsigned portion must fail opening");
    assert!(
        matches!(err, SignalError::InvalidSignature),
        "corruption in unsigned portion (ciphertext region) must be caught by \
         signature verification, got: {err:?}"
    );
}

/// Corruption case 2: Flip a byte in the sender_pub region [93..126].
///
/// Layer exercised: Sender identity check (step 3).
/// The embedded sender public key no longer matches expected_sender_public_key,
/// so the constant-time comparison rejects it BEFORE signature verification.
#[test]
fn golden_ecies_corrupted_sender_pub_fails() {
    let (sender_pub, recipient_priv, group_id, mut sealed) = golden_ecies_fixture();

    // Offset 100 is within the sender_pub field [93..126].  Corrupting it makes
    // the embedded sender key diverge from the expected key passed to ecies_open.
    sealed[100] ^= 0xFF;

    let err = ecies_open(sealed, group_id, recipient_priv, sender_pub)
        .expect_err("corrupted sender_pub must fail opening");
    assert!(
        matches!(err, SignalError::InvalidKey { .. }),
        "corruption in sender_pub region must be caught by sender identity check \
         (constant-time eq), got: {err:?}"
    );
}

/// Corruption case 3: Flip a byte in the signature region [126..190].
///
/// Layer exercised: XEdDSA signature verification (step 5).
/// The unsigned portion is intact and the sender_pub matches, so the sender
/// identity check passes.  But the corrupted signature bytes cause
/// `verify_signature(valid_unsigned, corrupted_signature)` to fail.
#[test]
fn golden_ecies_corrupted_signature_fails() {
    let (sender_pub, recipient_priv, group_id, mut sealed) = golden_ecies_fixture();

    // Offset 150 is within the signature field [126..190].
    sealed[150] ^= 0xFF;

    let err = ecies_open(sealed, group_id, recipient_priv, sender_pub)
        .expect_err("corrupted signature must fail opening");
    assert!(
        matches!(err, SignalError::InvalidSignature),
        "corruption in signature region must be caught by signature verification, \
         got: {err:?}"
    );
}

/// Verify that corrupting one byte of the invite blob causes decryption to fail.
#[test]
fn golden_invite_crypto_corrupted_byte_fails() {
    let invite_code: Vec<u8> = hex!("474f4c44 454e5445 5354434f 44453230").to_vec();
    let group_id: Vec<u8> = hex!(
        "676f6c64 656e2d69 6e766974 652d6772 6f75702d 6964"
    )
    .to_vec();

    let mut blob: Vec<u8> = hex!(
        "82c97976 4ceb0714 e7e686fd fe310442 afbba8ae d23c38ce"
        "9521758a 52354445 c6c128ab 412b1661 24a10a19 66eb8941"
        "b2ca5fc2 2a14890c d670bea3"
    )
    .to_vec();

    // Corrupt a byte in the middle of the ciphertext
    blob[20] ^= 0xFF;

    let result = invite_decrypt_group_key(blob, invite_code, group_id);
    assert!(
        result.is_err(),
        "corrupted invite blob must fail decryption (proves the fixture has teeth)"
    );
}

// =============================================================================
// Golden fixture 4: Attachment encryption (AES-256-CBC + HMAC-SHA256)
// =============================================================================

/// Generator: attachment encryption fixture (AES-256-CBC + HMAC-SHA256).
///
/// Uses obvious-constant keys.  Since `attachment_encrypt` generates a random IV
/// internally, each run produces unique output — run once, capture, hardcode.
///
/// ```sh
/// cargo test --features dev-roundtrip -p orbital_signal \
///     --test golden_ciphertext_tests -- --ignored --nocapture 2>&1 | grep '^FIXTURE:'
/// ```
#[test]
#[ignore]
fn generate_attachment_crypto_fixture() {
    // TEST VECTOR — synthetic 64-byte key (32 AES + 32 HMAC), never used outside this test
    let keys = {
        let mut k = vec![0x03u8; 32]; // AES key
        k.extend_from_slice(&[0x04u8; 32]); // HMAC key
        k
    };
    let plaintext = b"Orbital attachment golden vector!".to_vec();

    let result =
        attachment_encrypt(plaintext.clone(), keys.clone()).expect("encryption should succeed");

    println!("FIXTURE:attachment_crypto");
    println!("FIXTURE:keys={}", to_hex(&keys));
    println!("FIXTURE:plaintext={}", to_hex(&plaintext));
    println!("FIXTURE:ciphertext={}", to_hex(&result.ciphertext));
    println!("FIXTURE:digest={}", to_hex(&result.digest));
    println!("FIXTURE:plaintext_hash={}", to_hex(&result.plaintext_hash));

    // Verify the fixture decrypts correctly
    let recovered = attachment_decrypt(result.ciphertext, keys, result.digest)
        .expect("self-check decrypt");
    assert_eq!(recovered, plaintext, "self-check failed");
    println!("FIXTURE:self_check=PASS");
}

/// Golden fixture 4: Signal Protocol attachment encryption (AES-256-CBC + HMAC-SHA256).
///
/// Verifies that the current attachment crypto implementation can decrypt a
/// ciphertext blob produced by an earlier build.  Catches silent wire-format
/// changes from aes/cbc/hmac crate upgrades.
///
/// Attachment ciphertext layout:
///   IV (16 bytes) || AES-256-CBC encrypted data (PKCS7 padded) || HMAC-SHA256 (32 bytes)
///
/// Fixture components:
/// - Keys: 64 bytes (0x03*32 AES key || 0x04*32 HMAC key)
/// - Plaintext: "Orbital attachment golden vector!" (32 bytes)
/// - Ciphertext: 96 bytes (16 IV + 48 encrypted data [32 + 16 PKCS7 pad] + 32 HMAC)
/// - Digest: SHA-256 of the entire ciphertext blob
#[test]
fn golden_attachment_crypto_decrypt() {
    // TEST VECTOR — synthetic 64-byte key, never used outside this test
    let keys: Vec<u8> = hex!(
        "03030303 03030303 03030303 03030303 03030303 03030303 03030303 03030303"
        "04040404 04040404 04040404 04040404 04040404 04040404 04040404 04040404"
    )
    .to_vec();

    // "Orbital attachment golden vector!" (32 bytes)
    let expected_plaintext: Vec<u8> = hex!(
        "4f726269 74616c20 61747461 63686d65 6e742067 6f6c6465"
        "6e207665 63746f72 21"
    )
    .to_vec();

    // Captured 96-byte blob (16 IV + 48 AES-256-CBC encrypted data + 32 HMAC-SHA256)
    let ciphertext: Vec<u8> = hex!(
        "bbc87c64 af73e23e 71bc201e dda97c20 370bb925 a41beaad"
        "b6d8d019 3edde5ef ea005319 ef4a0593 36e45fe6 ee497c5b"
        "65abd473 29a96651 53810b29 d282f52f 7090698d 3c5fb302"
        "b39e56c6 69e92394 8d6ca3f7 e9a1e8c6 0cdca381 3ef29381"
    )
    .to_vec();

    // SHA-256 digest of the entire ciphertext blob
    let digest: Vec<u8> = hex!(
        "7a86e23b 19b018d9 1dad0b29 d903d390 c298d824 12b4b53c"
        "d844d594 e15552b6"
    )
    .to_vec();

    let decrypted = attachment_decrypt(ciphertext, keys, digest)
        .expect("golden attachment fixture must decrypt successfully");

    assert_eq!(
        decrypted, expected_plaintext,
        "golden attachment_crypto: decrypted plaintext does not match fixture"
    );

    assert_eq!(
        String::from_utf8(decrypted).unwrap(),
        "Orbital attachment golden vector!"
    );
}

/// Negative: corrupted HMAC tag must produce InvalidMessage.
///
/// The HMAC is the last 32 bytes of the attachment ciphertext blob.
/// Corruption is detected before decryption (MAC-then-decrypt).
#[test]
fn golden_attachment_crypto_corrupted_mac_fails() {
    let keys: Vec<u8> = hex!(
        "03030303 03030303 03030303 03030303 03030303 03030303 03030303 03030303"
        "04040404 04040404 04040404 04040404 04040404 04040404 04040404 04040404"
    )
    .to_vec();

    // Same fixture as golden_attachment_crypto_decrypt (96 bytes)
    let mut ciphertext: Vec<u8> = hex!(
        "bbc87c64 af73e23e 71bc201e dda97c20 370bb925 a41beaad"
        "b6d8d019 3edde5ef ea005319 ef4a0593 36e45fe6 ee497c5b"
        "65abd473 29a96651 53810b29 d282f52f 7090698d 3c5fb302"
        "b39e56c6 69e92394 8d6ca3f7 e9a1e8c6 0cdca381 3ef29381"
    )
    .to_vec();

    // Digest for the UNCORRUPTED ciphertext (corruption happens after this point,
    // so the digest check would also fail, but HMAC verification runs first)
    let digest: Vec<u8> = hex!(
        "7a86e23b 19b018d9 1dad0b29 d903d390 c298d824 12b4b53c"
        "d844d594 e15552b6"
    )
    .to_vec();

    // Corrupt the last byte of the HMAC tag
    let last = ciphertext.len() - 1;
    ciphertext[last] ^= 0xFF;

    let err = attachment_decrypt(ciphertext, keys, digest)
        .expect_err("corrupted HMAC must fail");
    assert!(
        matches!(err, SignalError::InvalidMessage { .. }),
        "corrupted HMAC must produce opaque InvalidMessage (MAC-then-decrypt), got: {err:?}"
    );
}

/// Negative: truncated ciphertext (below minimum 48 bytes) must produce InvalidArgument.
///
/// Minimum attachment ciphertext is 48 bytes: 16 (IV) + 0 (empty data) + 32 (HMAC).
/// Truncation below this threshold is caught by the length check before any crypto.
#[test]
fn golden_attachment_crypto_truncated_fails() {
    let keys: Vec<u8> = hex!(
        "03030303 03030303 03030303 03030303 03030303 03030303 03030303 03030303"
        "04040404 04040404 04040404 04040404 04040404 04040404 04040404 04040404"
    )
    .to_vec();

    // 47 bytes — one byte short of the 48-byte minimum
    let truncated: Vec<u8> = vec![0x00; 47];
    let digest: Vec<u8> = vec![0x00; 32];

    let err = attachment_decrypt(truncated, keys, digest)
        .expect_err("truncated ciphertext must fail");
    assert!(
        matches!(err, SignalError::InvalidArgument { .. }),
        "ciphertext below 48-byte minimum must produce InvalidArgument, got: {err:?}"
    );
}
