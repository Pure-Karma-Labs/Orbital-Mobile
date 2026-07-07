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

/// Verify that corrupting one byte of the ECIES sealed envelope causes opening to fail.
#[test]
fn golden_ecies_corrupted_byte_fails() {
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

    let mut sealed: Vec<u8> = hex!(
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

    // Corrupt a byte in the ciphertext portion (offset 50, within the encrypted data)
    sealed[50] ^= 0xFF;

    let result = ecies_open(sealed, group_id, recipient_private_key, sender_public_key);
    assert!(
        result.is_err(),
        "corrupted sealed envelope must fail opening (proves the fixture has teeth)"
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
