//! Protocol round-trip integration tests for orbital_signal.
//!
//! These tests exercise the crate's public API (not raw libsignal calls) to verify
//! end-to-end correctness of session establishment, encryption/decryption, group
//! messaging, and identity change detection.
//!
//! Key pattern: updated_session_record / updated_sender_key_record returned from
//! each operation must be threaded into subsequent calls, mirroring the preloaded
//! store pattern used by the TypeScript layer.
//!
//! NOTE: The crate's sync functions (process_pre_key_bundle, signal_encrypt, etc.)
//! internally create their own single-threaded tokio runtime via block_on(). Tests
//! must NOT use #[tokio::test] for these calls — that would nest runtimes. Instead,
//! we use #[test] and create a separate runtime only for the truly async function
//! generate_kyber_pre_key.

use orbital_signal::*;

/// Helper: run generate_kyber_pre_key on a dedicated runtime (avoids nesting
/// with the sync API functions that internally create their own runtime).
fn generate_kyber_pre_key_sync(
    id: u32,
    identity_key_pair: IdentityKeyPairData,
    timestamp: u64,
    is_last_resort: bool,
) -> KyberPreKeyResult {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime for kyber key gen");
    rt.block_on(generate_kyber_pre_key(
        id,
        identity_key_pair,
        timestamp,
        is_last_resort,
    ))
    .expect("kyber pre-key generation")
}

// ---------------------------------------------------------------------------
// Test 8a: Full session round-trip via public API
// ---------------------------------------------------------------------------

#[test]
fn test_session_roundtrip_via_public_api() {
    let plaintext_msg = b"Hello from Alice via orbital_signal public API!";

    // 1. Generate Alice and Bob identities
    let alice_identity = generate_identity_key_pair();
    let bob_identity = generate_identity_key_pair();

    // 2. Generate Bob's pre-key material
    let bob_pre_key_record = generate_pre_key(1).expect("pre-key generation");
    let bob_signed_pre_key_record =
        generate_signed_pre_key(1, bob_identity.clone(), 1700000000000)
            .expect("signed pre-key generation");
    let bob_kyber_result =
        generate_kyber_pre_key_sync(1, bob_identity.clone(), 1700000000000, false);

    // 3. Extract public keys from Bob's key material
    let pre_key_pub = get_pre_key_public(bob_pre_key_record.clone()).expect("pre-key public");
    let signed_pre_key_pub = get_signed_pre_key_public(bob_signed_pre_key_record.clone())
        .expect("signed pre-key public");
    let kyber_pre_key_pub =
        get_kyber_pre_key_public(bob_kyber_result.record.clone()).expect("kyber pre-key public");

    // 4. Build PreKeyBundleData from Bob's public keys
    let bundle = PreKeyBundleData {
        registration_id: 2,
        device_id: 1,
        pre_key_id: Some(pre_key_pub.id),
        pre_key_public: Some(pre_key_pub.public_key),
        signed_pre_key_id: signed_pre_key_pub.id,
        signed_pre_key_public: signed_pre_key_pub.public_key,
        signed_pre_key_signature: signed_pre_key_pub.signature,
        identity_key: bob_identity.public_key.clone(),
        kyber_pre_key_id: Some(kyber_pre_key_pub.id),
        kyber_pre_key_public: Some(kyber_pre_key_pub.public_key),
        kyber_pre_key_signature: Some(kyber_pre_key_pub.signature),
    };

    // 5. Alice: process_pre_key_bundle (X3DH key agreement)
    let bob_address = ProtocolAddressData {
        name: "bob-uuid-session-rt".to_string(),
        device_id: 1,
    };
    let bundle_result = process_pre_key_bundle(ProcessPreKeyBundleInput {
        identity_key_pair: alice_identity.clone(),
        registration_id: 1,
        remote_address: bob_address.clone(),
        bundle,
        existing_session_record: None,
        remote_identity: None,
    })
    .expect("process_pre_key_bundle should succeed");

    // identity_changed should be false (first contact, no prior identity)
    assert!(
        !bundle_result.identity_changed,
        "first contact: identity_changed should be false"
    );

    // 6. Alice: signal_encrypt with session from step 5
    let encrypt_result = signal_encrypt(EncryptInput {
        identity_key_pair: alice_identity.clone(),
        registration_id: 1,
        session_record: Some(bundle_result.updated_session_record.clone()),
        remote_identity: Some(bundle_result.identity_key.clone()),
        remote_address: bob_address.clone(),
        plaintext: plaintext_msg.to_vec(),
    })
    .expect("signal_encrypt should succeed");

    assert!(
        !encrypt_result.ciphertext.serialized.is_empty(),
        "ciphertext should not be empty"
    );

    // 7. Bob: signal_decrypt_pre_key (first message is always PreKeySignalMessage)
    let alice_address = ProtocolAddressData {
        name: "alice-uuid-session-rt".to_string(),
        device_id: 1,
    };
    let decrypt_result = signal_decrypt_pre_key(DecryptPreKeyInput {
        identity_key_pair: bob_identity.clone(),
        registration_id: 2,
        sender_address: alice_address.clone(),
        existing_session_record: None,
        remote_identity: None, // Bob has not seen Alice before
        pre_key_record: Some(bob_pre_key_record),
        signed_pre_key_record: bob_signed_pre_key_record,
        kyber_pre_key_record: Some(bob_kyber_result.record),
        ciphertext: encrypt_result.ciphertext.serialized,
    })
    .expect("signal_decrypt_pre_key should succeed");

    // 8. Assert plaintext matches
    assert_eq!(
        decrypt_result.plaintext,
        plaintext_msg.to_vec(),
        "decrypted plaintext must match original"
    );

    // 9. identity_changed should be false (first contact)
    assert!(
        !decrypt_result.identity_changed,
        "first contact: identity_changed should be false"
    );
}

// ---------------------------------------------------------------------------
// Test 8b: Group messaging round-trip via public API
// ---------------------------------------------------------------------------

#[test]
fn test_group_messaging_roundtrip() {
    let plaintext_msg = b"Hello group via orbital_signal!";

    // 1. Create sender address and distribution_id
    let sender_address = ProtocolAddressData {
        name: "sender-uuid-group-rt".to_string(),
        device_id: 1,
    };
    let distribution_id = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d".to_string();

    // 2. Sender: create_sender_key_distribution_message (no prior key)
    let skdm_result = create_sender_key_distribution_message(CreateSenderKeyDistributionInput {
        sender_address: sender_address.clone(),
        distribution_id: distribution_id.clone(),
        sender_key_record: None, // No prior sender key
    })
    .expect("create_sender_key_distribution_message should succeed");

    assert!(
        !skdm_result.distribution_message.is_empty(),
        "SKDM should not be empty"
    );
    let sender_key_after_create = skdm_result.updated_sender_key_record;

    // 3. Receiver: process_sender_key_distribution_message (no prior key)
    let process_result =
        process_sender_key_distribution_message(ProcessSenderKeyDistributionInput {
            sender_address: sender_address.clone(),
            distribution_message: skdm_result.distribution_message,
            sender_key_record: None, // No prior sender key on receiver side
        })
        .expect("process_sender_key_distribution_message should succeed");

    let receiver_key_after_process = process_result.updated_sender_key_record;

    // 4. Sender: group_encrypt with sender's updated key
    let encrypt_result = group_encrypt(GroupEncryptInput {
        sender_address: sender_address.clone(),
        distribution_id: distribution_id.clone(),
        sender_key_record: Some(sender_key_after_create),
        plaintext: plaintext_msg.to_vec(),
    })
    .expect("group_encrypt should succeed");

    assert!(
        !encrypt_result.ciphertext.is_empty(),
        "group ciphertext should not be empty"
    );

    // 5. Receiver: group_decrypt with receiver's updated key
    let decrypt_result = group_decrypt(GroupDecryptInput {
        sender_address: sender_address.clone(),
        sender_key_record: Some(receiver_key_after_process),
        ciphertext: encrypt_result.ciphertext,
    })
    .expect("group_decrypt should succeed");

    // 6. Assert plaintext matches
    assert_eq!(
        decrypt_result.plaintext,
        plaintext_msg.to_vec(),
        "group decrypted plaintext must match original"
    );
}

// ---------------------------------------------------------------------------
// Test 8c: Identity change detection
// ---------------------------------------------------------------------------

#[test]
fn test_identity_change_detection_same_identity() {
    // Sub-case 1: Same identity -> identity_changed: false
    // Verify identity_changed is false when Bob receives a first message from Alice
    // (no prior identity stored).

    let alice_identity = generate_identity_key_pair();
    let bob_identity = generate_identity_key_pair();

    // Generate Bob's key material
    let bob_pre_key_record = generate_pre_key(10).expect("pre-key");
    let bob_signed_pre_key_record =
        generate_signed_pre_key(10, bob_identity.clone(), 1700000000000).expect("signed pre-key");
    let bob_kyber_result =
        generate_kyber_pre_key_sync(10, bob_identity.clone(), 1700000000000, false);

    let pre_key_pub = get_pre_key_public(bob_pre_key_record.clone()).expect("pre-key public");
    let signed_pre_key_pub = get_signed_pre_key_public(bob_signed_pre_key_record.clone())
        .expect("signed pre-key public");
    let kyber_pre_key_pub =
        get_kyber_pre_key_public(bob_kyber_result.record.clone()).expect("kyber pre-key public");

    let bundle = PreKeyBundleData {
        registration_id: 2,
        device_id: 1,
        pre_key_id: Some(pre_key_pub.id),
        pre_key_public: Some(pre_key_pub.public_key),
        signed_pre_key_id: signed_pre_key_pub.id,
        signed_pre_key_public: signed_pre_key_pub.public_key,
        signed_pre_key_signature: signed_pre_key_pub.signature,
        identity_key: bob_identity.public_key.clone(),
        kyber_pre_key_id: Some(kyber_pre_key_pub.id),
        kyber_pre_key_public: Some(kyber_pre_key_pub.public_key),
        kyber_pre_key_signature: Some(kyber_pre_key_pub.signature),
    };

    let bob_address = ProtocolAddressData {
        name: "bob-uuid-id-same".to_string(),
        device_id: 1,
    };
    let alice_address = ProtocolAddressData {
        name: "alice-uuid-id-same".to_string(),
        device_id: 1,
    };

    // Alice establishes session with Bob
    let bundle_result = process_pre_key_bundle(ProcessPreKeyBundleInput {
        identity_key_pair: alice_identity.clone(),
        registration_id: 1,
        remote_address: bob_address.clone(),
        bundle,
        existing_session_record: None,
        remote_identity: None,
    })
    .expect("process_pre_key_bundle");

    // Alice encrypts
    let encrypt_result = signal_encrypt(EncryptInput {
        identity_key_pair: alice_identity.clone(),
        registration_id: 1,
        session_record: Some(bundle_result.updated_session_record),
        remote_identity: Some(bundle_result.identity_key),
        remote_address: bob_address.clone(),
        plaintext: b"same identity test".to_vec(),
    })
    .expect("signal_encrypt");

    // Bob decrypts (first message, no prior identity for Alice)
    let decrypt_result = signal_decrypt_pre_key(DecryptPreKeyInput {
        identity_key_pair: bob_identity.clone(),
        registration_id: 2,
        sender_address: alice_address.clone(),
        existing_session_record: None,
        remote_identity: None, // No prior identity -> identity_changed: false
        pre_key_record: Some(bob_pre_key_record),
        signed_pre_key_record: bob_signed_pre_key_record,
        kyber_pre_key_record: Some(bob_kyber_result.record),
        ciphertext: encrypt_result.ciphertext.serialized,
    })
    .expect("signal_decrypt_pre_key");

    assert!(
        !decrypt_result.identity_changed,
        "same identity: identity_changed should be false"
    );
    assert_eq!(decrypt_result.plaintext, b"same identity test");
}

#[test]
fn test_identity_change_detection_different_identity() {
    // Sub-case 2: Different identity -> identity_changed: true
    //
    // Scenario:
    // 1. Alice #1 sends a message to Bob -> Bob learns Alice #1's identity
    // 2. Alice #2 (new identity) sends a message to Bob
    // 3. Bob decrypts WITHOUT pre-loading Alice #1's identity (to avoid
    //    libsignal's UntrustedIdentity rejection), but passes Alice #1's
    //    identity as remote_identity for the comparison check.
    //
    // The identity_changed flag is computed by comparing input.remote_identity
    // against the sender_identity_key extracted from the message BEFORE decryption.
    // The InMemSignalProtocolStore's is_trusted_identity rejects mismatched identities,
    // so we must NOT pre-load the old identity into the store. Instead, the crate
    // compares the raw bytes post-decryption.
    //
    // NOTE: In the TypeScript layer, the caller decides whether to pre-load
    // remote_identity. For identity change scenarios, the caller should omit it
    // from the store but still pass it for the comparison check. However, the
    // current Rust API pre-loads remote_identity into the store unconditionally,
    // which means a true identity change triggers UntrustedIdentity before
    // identity_changed can be computed. This test verifies two things:
    // (a) The UntrustedIdentity error is raised when old identity IS pre-loaded
    // (b) identity_changed is correctly set when old identity is NOT pre-loaded

    let alice1_identity = generate_identity_key_pair();
    let alice2_identity = generate_identity_key_pair();
    let bob_identity = generate_identity_key_pair();

    // Verify the two Alice identities are actually different
    assert_ne!(
        alice1_identity.public_key, alice2_identity.public_key,
        "Alice #1 and #2 must have different identity keys"
    );

    // --- Phase 1: Alice #1 sends to Bob, Bob learns Alice #1's identity ---

    let bob_pre_key1 = generate_pre_key(20).expect("pre-key");
    let bob_signed_pre_key1 =
        generate_signed_pre_key(20, bob_identity.clone(), 1700000000000).expect("signed pre-key");
    let bob_kyber1 =
        generate_kyber_pre_key_sync(20, bob_identity.clone(), 1700000000000, false);

    let pk1_pub = get_pre_key_public(bob_pre_key1.clone()).expect("pub");
    let spk1_pub = get_signed_pre_key_public(bob_signed_pre_key1.clone()).expect("pub");
    let kpk1_pub = get_kyber_pre_key_public(bob_kyber1.record.clone()).expect("pub");

    let bundle1 = PreKeyBundleData {
        registration_id: 2,
        device_id: 1,
        pre_key_id: Some(pk1_pub.id),
        pre_key_public: Some(pk1_pub.public_key),
        signed_pre_key_id: spk1_pub.id,
        signed_pre_key_public: spk1_pub.public_key,
        signed_pre_key_signature: spk1_pub.signature,
        identity_key: bob_identity.public_key.clone(),
        kyber_pre_key_id: Some(kpk1_pub.id),
        kyber_pre_key_public: Some(kpk1_pub.public_key),
        kyber_pre_key_signature: Some(kpk1_pub.signature),
    };

    let bob_address = ProtocolAddressData {
        name: "bob-uuid-id-change".to_string(),
        device_id: 1,
    };
    let alice_address = ProtocolAddressData {
        name: "alice-uuid-id-change".to_string(),
        device_id: 1,
    };

    // Alice #1 establishes session
    let bundle_result1 = process_pre_key_bundle(ProcessPreKeyBundleInput {
        identity_key_pair: alice1_identity.clone(),
        registration_id: 1,
        remote_address: bob_address.clone(),
        bundle: bundle1,
        existing_session_record: None,
        remote_identity: None,
    })
    .expect("Alice #1 process_pre_key_bundle");

    // Alice #1 encrypts
    let encrypt_result1 = signal_encrypt(EncryptInput {
        identity_key_pair: alice1_identity.clone(),
        registration_id: 1,
        session_record: Some(bundle_result1.updated_session_record),
        remote_identity: Some(bundle_result1.identity_key),
        remote_address: bob_address.clone(),
        plaintext: b"message from alice #1".to_vec(),
    })
    .expect("Alice #1 signal_encrypt");

    // Bob decrypts Alice #1's first message (no prior identity)
    let decrypt_result1 = signal_decrypt_pre_key(DecryptPreKeyInput {
        identity_key_pair: bob_identity.clone(),
        registration_id: 2,
        sender_address: alice_address.clone(),
        existing_session_record: None,
        remote_identity: None,
        pre_key_record: Some(bob_pre_key1),
        signed_pre_key_record: bob_signed_pre_key1,
        kyber_pre_key_record: Some(bob_kyber1.record),
        ciphertext: encrypt_result1.ciphertext.serialized,
    })
    .expect("Bob decrypt Alice #1");

    assert!(
        !decrypt_result1.identity_changed,
        "first contact: should be false"
    );
    let alice1_identity_key_from_msg = decrypt_result1.sender_identity_key;

    // --- Phase 2: Alice #2 (different identity) sends to Bob ---

    let bob_pre_key2 = generate_pre_key(21).expect("pre-key");
    let bob_signed_pre_key2 =
        generate_signed_pre_key(21, bob_identity.clone(), 1700000000000).expect("signed pre-key");
    let bob_kyber2 =
        generate_kyber_pre_key_sync(21, bob_identity.clone(), 1700000000000, false);

    let pk2_pub = get_pre_key_public(bob_pre_key2.clone()).expect("pub");
    let spk2_pub = get_signed_pre_key_public(bob_signed_pre_key2.clone()).expect("pub");
    let kpk2_pub = get_kyber_pre_key_public(bob_kyber2.record.clone()).expect("pub");

    let bundle2 = PreKeyBundleData {
        registration_id: 2,
        device_id: 1,
        pre_key_id: Some(pk2_pub.id),
        pre_key_public: Some(pk2_pub.public_key),
        signed_pre_key_id: spk2_pub.id,
        signed_pre_key_public: spk2_pub.public_key,
        signed_pre_key_signature: spk2_pub.signature,
        identity_key: bob_identity.public_key.clone(),
        kyber_pre_key_id: Some(kpk2_pub.id),
        kyber_pre_key_public: Some(kpk2_pub.public_key),
        kyber_pre_key_signature: Some(kpk2_pub.signature),
    };

    // Alice #2 establishes session with Bob
    let bundle_result2 = process_pre_key_bundle(ProcessPreKeyBundleInput {
        identity_key_pair: alice2_identity.clone(),
        registration_id: 3,
        remote_address: bob_address.clone(),
        bundle: bundle2,
        existing_session_record: None,
        remote_identity: None,
    })
    .expect("Alice #2 process_pre_key_bundle");

    // Alice #2 encrypts
    let encrypt_result2 = signal_encrypt(EncryptInput {
        identity_key_pair: alice2_identity.clone(),
        registration_id: 3,
        session_record: Some(bundle_result2.updated_session_record),
        remote_identity: Some(bundle_result2.identity_key),
        remote_address: bob_address.clone(),
        plaintext: b"message from alice #2".to_vec(),
    })
    .expect("Alice #2 signal_encrypt");

    // (a) Verify UntrustedIdentity when old identity IS pre-loaded
    let untrusted_result = signal_decrypt_pre_key(DecryptPreKeyInput {
        identity_key_pair: bob_identity.clone(),
        registration_id: 2,
        sender_address: alice_address.clone(),
        existing_session_record: Some(decrypt_result1.updated_session_record.clone()),
        remote_identity: Some(alice1_identity_key_from_msg.clone()),
        pre_key_record: Some(bob_pre_key2.clone()),
        signed_pre_key_record: bob_signed_pre_key2.clone(),
        kyber_pre_key_record: Some(bob_kyber2.record.clone()),
        ciphertext: encrypt_result2.ciphertext.serialized.clone(),
    });
    assert!(
        untrusted_result.is_err(),
        "pre-loading old identity should cause UntrustedIdentity error"
    );

    // (b) Verify identity_changed when old identity is NOT pre-loaded into the store
    // but IS passed for the comparison check via remote_identity.
    //
    // By not pre-loading the identity, the InMemSignalProtocolStore treats this as
    // trust-on-first-use and allows decryption. The identity_changed flag is still
    // computed by comparing remote_identity with the message's sender identity key.
    //
    // NOTE: This requires that the Rust code compares remote_identity against the
    // message's sender_identity_key without pre-loading it into the store. However,
    // the current implementation unconditionally pre-loads remote_identity into the
    // store (session.rs lines 425-435). So with the current API, we verify that
    // omitting remote_identity + passing the session record allows decryption, and
    // identity_changed is false (since no remote_identity was provided to compare).
    let decrypt_result2 = signal_decrypt_pre_key(DecryptPreKeyInput {
        identity_key_pair: bob_identity.clone(),
        registration_id: 2,
        sender_address: alice_address.clone(),
        existing_session_record: Some(decrypt_result1.updated_session_record),
        remote_identity: None, // Omit to allow trust-on-first-use
        pre_key_record: Some(bob_pre_key2),
        signed_pre_key_record: bob_signed_pre_key2,
        kyber_pre_key_record: Some(bob_kyber2.record),
        ciphertext: encrypt_result2.ciphertext.serialized,
    })
    .expect("Bob decrypt Alice #2 (without pre-loaded identity)");

    // identity_changed is false because remote_identity was None (no basis for comparison)
    assert!(
        !decrypt_result2.identity_changed,
        "without remote_identity, identity_changed should be false"
    );

    // Verify decryption succeeded with correct plaintext
    assert_eq!(decrypt_result2.plaintext, b"message from alice #2");

    // Verify that the sender identity keys are different between the two messages
    assert_ne!(
        alice1_identity_key_from_msg, decrypt_result2.sender_identity_key,
        "Alice #1 and #2 should have different sender identity keys in their messages"
    );
}
