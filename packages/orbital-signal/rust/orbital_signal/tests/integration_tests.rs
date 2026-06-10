use orbital_signal::*;

#[test]
fn test_generate_identity_key_pair() {
    let kp = generate_identity_key_pair();
    assert_eq!(kp.public_key.len(), 33, "Curve25519 compressed public key is 33 bytes");
    assert_eq!(kp.private_key.len(), 32, "Curve25519 private key is 32 bytes");
    assert_eq!(kp.public_key[0], 0x05, "Compressed key starts with 0x05 prefix");
}

#[test]
fn test_generate_identity_key_pair_unique() {
    let kp1 = generate_identity_key_pair();
    let kp2 = generate_identity_key_pair();
    assert_ne!(kp1.public_key, kp2.public_key, "Each key pair should be unique");
    assert_ne!(kp1.private_key, kp2.private_key);
}

#[test]
fn test_generate_pre_key() {
    let record = generate_pre_key(1).expect("pre-key generation should succeed");
    assert!(!record.is_empty(), "serialized PreKeyRecord should not be empty");

    let public = get_pre_key_public(record).expect("should extract public data");
    assert_eq!(public.id, 1);
    assert_eq!(public.public_key.len(), 33);
}

#[test]
fn test_generate_signed_pre_key() {
    let identity = generate_identity_key_pair();
    let timestamp = 1700000000000u64; // some epoch millis

    let record = generate_signed_pre_key(1, identity, timestamp)
        .expect("signed pre-key generation should succeed");
    assert!(!record.is_empty());

    let public = get_signed_pre_key_public(record).expect("should extract public data");
    assert_eq!(public.id, 1);
    assert_eq!(public.public_key.len(), 33);
    assert_eq!(public.signature.len(), 64, "Ed25519 signature is 64 bytes");
    assert_eq!(public.timestamp, timestamp);
}

#[tokio::test]
async fn test_generate_kyber_pre_key() {
    let identity = generate_identity_key_pair();
    let timestamp = 1700000000000u64;

    let result = generate_kyber_pre_key(1, identity.clone(), timestamp, false)
        .await
        .expect("kyber pre-key generation should succeed");
    assert!(!result.record.is_empty());
    assert!(!result.is_last_resort, "non-last-resort flag should be preserved");
    // Kyber1024 records are ~3200 bytes
    assert!(result.record.len() > 1000, "Kyber record should be large (~3200 bytes)");

    let public = get_kyber_pre_key_public(result.record).expect("should extract public data");
    assert_eq!(public.id, 1);
    assert!(public.public_key.len() > 1000, "Kyber1024 public key is ~1568 bytes");
    assert!(!public.signature.is_empty());

    // Verify is_last_resort=true is also preserved
    let last_resort_result = generate_kyber_pre_key(2, identity, timestamp, true)
        .await
        .expect("last-resort kyber pre-key generation should succeed");
    assert!(last_resort_result.is_last_resort, "last-resort flag should be preserved");
    assert!(!last_resort_result.record.is_empty());
}

#[test]
fn test_create_protocol_address() {
    let addr = create_protocol_address("abc-123".to_string(), 1);
    assert_eq!(addr.name, "abc-123");
    assert_eq!(addr.device_id, 1);
}

#[test]
fn test_pre_key_round_trip() {
    // Generate -> serialize -> extract public -> verify
    for id in 1..=5 {
        let record = generate_pre_key(id).unwrap();
        let public = get_pre_key_public(record).unwrap();
        assert_eq!(public.id, id);
        assert_eq!(public.public_key.len(), 33);
    }
}

#[test]
fn test_signed_pre_key_round_trip() {
    let identity = generate_identity_key_pair();
    for id in 1..=3 {
        let record = generate_signed_pre_key(id, identity.clone(), 1700000000000).unwrap();
        let public = get_signed_pre_key_public(record).unwrap();
        assert_eq!(public.id, id);
    }
}

#[test]
fn test_invalid_pre_key_deserialization() {
    let result = get_pre_key_public(vec![0, 1, 2, 3]);
    assert!(result.is_err(), "invalid bytes should produce an error");
}

#[test]
fn test_invalid_signed_pre_key_deserialization() {
    let result = get_signed_pre_key_public(vec![0xFF; 10]);
    assert!(result.is_err());
}

#[test]
fn test_invalid_kyber_pre_key_deserialization() {
    let result = get_kyber_pre_key_public(vec![0xFF; 10]);
    assert!(result.is_err());
}

// ---------------------------------------------------------------------------
// Encrypt/decrypt round-trip (Issue #11 PoC)
// ---------------------------------------------------------------------------

#[cfg(feature = "dev-roundtrip")]
#[test]
fn test_encrypt_decrypt_roundtrip_basic() {
    let plaintext = b"Hello Signal Protocol!".to_vec();
    let result = test_encrypt_decrypt_roundtrip(plaintext.clone())
        .expect("roundtrip should succeed");
    assert!(result.success, "decrypted should match plaintext");
    assert_eq!(result.decrypted, plaintext);
    assert!(result.ciphertext_len > 0, "ciphertext should not be empty");
    assert!(result.elapsed_ms < 30_000, "should complete in <30s");
}

#[cfg(feature = "dev-roundtrip")]
#[test]
fn test_encrypt_decrypt_roundtrip_empty() {
    let result = test_encrypt_decrypt_roundtrip(vec![])
        .expect("empty plaintext roundtrip should succeed");
    assert!(result.success);
    assert!(result.decrypted.is_empty());
}

#[cfg(feature = "dev-roundtrip")]
#[test]
fn test_encrypt_decrypt_roundtrip_repeated() {
    let result = test_encrypt_decrypt_roundtrip_n(b"repeat test".to_vec(), 5)
        .expect("batch roundtrip should succeed");
    assert_eq!(result.success_count, 5);
    assert!(result.total_elapsed_ms > 0);
    assert!(result.avg_elapsed_ms > 0);
}
