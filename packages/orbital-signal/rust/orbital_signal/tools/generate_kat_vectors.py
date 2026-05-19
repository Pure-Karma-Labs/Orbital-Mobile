#!/usr/bin/env python3
"""
Generate Known-Answer Test (KAT) vectors for Signal attachment encryption.

Signal attachment encryption format:
  1. AES-256-CBC encrypt plaintext with PKCS7 padding using key[0:32] and iv
  2. Concatenate: iv || encrypted_data
  3. HMAC-SHA256 over (iv || encrypted_data) using key[32:64]
  4. Append HMAC: iv || encrypted_data || hmac
  5. SHA-256 digest of the full blob (iv || encrypted_data || hmac)

Usage:
  pip3 install pycryptodome
  python3 tools/generate_kat_vectors.py
"""

import hashlib
import hmac
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad


def generate_vector(name: str, plaintext: bytes, key: bytes, iv: bytes) -> None:
    """Generate and print a single KAT vector."""
    assert len(key) == 64, f"key must be 64 bytes, got {len(key)}"
    assert len(iv) == 16, f"iv must be 16 bytes, got {len(iv)}"

    aes_key = key[:32]
    hmac_key = key[32:]

    # AES-256-CBC encrypt with PKCS7 padding
    cipher = AES.new(aes_key, AES.MODE_CBC, iv)
    encrypted_data = cipher.encrypt(pad(plaintext, AES.block_size))

    # Build blob: IV || encrypted_data
    blob = iv + encrypted_data

    # HMAC-SHA256 over IV || encrypted_data
    mac = hmac.new(hmac_key, blob, hashlib.sha256).digest()

    # Full ciphertext: IV || encrypted_data || HMAC
    ciphertext = blob + mac

    # SHA-256 digest of full ciphertext
    digest = hashlib.sha256(ciphertext).digest()

    # SHA-256 of original plaintext
    plaintext_hash = hashlib.sha256(plaintext).digest()

    print(f"// --- {name} ---")
    print(f"// plaintext ({len(plaintext)} bytes): {plaintext.hex() if plaintext else '(empty)'}")
    print(f"// key: {key.hex()}")
    print(f"// iv:  {iv.hex()}")
    print(f"// ciphertext ({len(ciphertext)} bytes):")
    print(f'//   hex!("{ciphertext.hex()}")')
    print(f"// digest (32 bytes):")
    print(f'//   hex!("{digest.hex()}")')
    print(f"// plaintext_hash (32 bytes):")
    print(f'//   hex!("{plaintext_hash.hex()}")')
    print()


if __name__ == "__main__":
    # Vector 1: Short plaintext
    generate_vector(
        "Vector 1: short plaintext",
        plaintext=b"Hello Signal",
        key=bytes([0x01] * 32 + [0x02] * 32),
        iv=bytes([0x03] * 16),
    )

    # Vector 2: Empty plaintext
    generate_vector(
        "Vector 2: empty plaintext",
        plaintext=b"",
        key=bytes([0x10] * 32 + [0x20] * 32),
        iv=bytes([0x30] * 16),
    )

    # Vector 3: Block-aligned 16-byte plaintext
    generate_vector(
        "Vector 3: block-aligned 16 bytes",
        plaintext=b"0123456789abcdef",
        key=bytes([0xAA] * 32 + [0xBB] * 32),
        iv=bytes([0xCC] * 16),
    )
