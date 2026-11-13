#!/usr/bin/env python3
"""
Generate Known-Answer Test (KAT) vectors for the HKDF-SHA256 / HMAC-SHA256
uniffi exports in src/kdf.rs (issue #917).

STDLIB ONLY — `hashlib`, `hmac`, `base64`. Deliberately NOT an extension of
tools/generate_kat_vectors.py, which is attachment-specific and needs
pycryptodome: a reviewer must be able to re-derive every vector in
tests/kdf_kat_tests.rs with nothing but a stock Python 3.

HKDF-SHA256 is written out below from RFC 5869 rather than imported, so these
vectors share no code with the Rust implementation under test.

SELF-CHECK FIRST (issue #917 risk 7). Hand-transcribed RFC values are the most
likely defect in this change set, and a wrong fixture would be adopted
downstream (#924) as the contract. So this script reproduces every RFC 5869
Appendix A (SHA-256) and RFC 4231 section 4 expected value from its own HKDF /
HMAC code BEFORE it mints a single Orbital vector. Any mismatch aborts with a
non-zero exit and prints nothing usable. That makes the RFC tables in
tests/kdf_kat_tests.rs independently checked transcriptions rather than trusted
ones.

Usage (from the crate root, packages/orbital-signal/rust/orbital_signal):
  python3 -I tools/generate_kdf_kat_vectors.py
  python3 -I tools/generate_kdf_kat_vectors.py | grep '^FIXTURE:'
"""

import base64
import hashlib
import hmac
import sys

HASH_LEN = 32  # SHA-256


# --- HKDF-SHA256, straight from RFC 5869 sections 2.2 and 2.3 ---------------


def hkdf_extract(salt: bytes, ikm: bytes) -> bytes:
    """PRK = HMAC-Hash(salt, IKM). A zero-length salt becomes HashLen zeros."""
    if len(salt) == 0:
        salt = b"\x00" * HASH_LEN
    return hmac.new(salt, ikm, hashlib.sha256).digest()


def hkdf_expand(prk: bytes, info: bytes, length: int) -> bytes:
    """OKM = T(1) | T(2) | ... where T(i) = HMAC(PRK, T(i-1) | info | i)."""
    if length > 255 * HASH_LEN:
        raise ValueError(f"length {length} exceeds 255*HashLen")
    okm = b""
    t = b""
    counter = 1
    while len(okm) < length:
        t = hmac.new(prk, t + info + bytes([counter]), hashlib.sha256).digest()
        okm += t
        counter += 1
    return okm[:length]


def hkdf_sha256(ikm: bytes, salt: bytes, info: bytes, length: int) -> bytes:
    """Argument order matches the Rust export: (ikm, salt, info, output_len)."""
    return hkdf_expand(hkdf_extract(salt, ikm), info, length)


def hmac_sha256(key: bytes, data: bytes) -> bytes:
    return hmac.new(key, data, hashlib.sha256).digest()


# --- Transcribed RFC expected values (the self-check inputs) ----------------
#
# RFC 5869 Appendix A.1 / A.2 / A.3 — the three SHA-256 test cases.
# Byte patterns are built programmatically where the RFC describes them as a
# range or a repeat, so only the expected PRK/OKM hex is hand-typed.

RFC5869 = [
    {
        "name": "RFC 5869 A.1 (Test Case 1) — basic, SHA-256",
        "ikm": bytes([0x0B] * 22),
        "salt": bytes(range(0x00, 0x0D)),  # 000102...0c, 13 octets
        "info": bytes(range(0xF0, 0xFA)),  # f0f1...f9, 10 octets
        "length": 42,
        "prk": "077709362c2e32df0ddc3f0dc47bba63"
        "90b6c73bb50f9c3122ec844ad7c2b3e5",
        "okm": "3cb25f25faacd57a90434f64d0362f2a"
        "2d2d0a90cf1a5a4c5db02d56ecc4c5bf"
        "34007208d5b887185865",
    },
    {
        "name": "RFC 5869 A.2 (Test Case 2) — longer inputs/outputs, SHA-256",
        "ikm": bytes(range(0x00, 0x50)),  # 80 octets
        "salt": bytes(range(0x60, 0xB0)),  # 80 octets
        "info": bytes(range(0xB0, 0x100)),  # 80 octets
        "length": 82,
        "prk": "06a6b88c5853361a06104c9ceb35b45c"
        "ef760014904671014a193f40c15fc244",
        "okm": "b11e398dc80327a1c8e7f78c596a4934"
        "4f012eda2d4efad8a050cc4c19afa97c"
        "59045a99cac7827271cb41c65e590e09"
        "da3275600c2f09b8367793a9aca3db71"
        "cc30c58179ec3e87c14c01d5c1f3434f"
        "1d87",
    },
    {
        "name": "RFC 5869 A.3 (Test Case 3) — zero-length salt and info, SHA-256",
        "ikm": bytes([0x0B] * 22),
        "salt": b"",
        "info": b"",
        "length": 42,
        "prk": "19ef24a32c717b167f33a91d6f648bdf"
        "96596776afdb6377ac434c1c293ccb04",
        "okm": "8da4e775a563c18f715f802a063c5a31"
        "b8a11f5c5ee1879ec3454e5f3c738d2d"
        "9d201395faa4b61a96c8",
    },
]

# RFC 4231 section 4 — the seven HMAC-SHA-256 test cases. `tag` is the full
# 32-byte expected value; case 5 publishes only the 128-bit truncation, so its
# expected value is recorded as `tag128` and compared against tag[:16].
RFC4231 = [
    {
        "name": "RFC 4231 4.2 (Test Case 1)",
        "key": bytes([0x0B] * 20),
        "data": b"Hi There",
        "tag": "b0344c61d8db38535ca8afceaf0bf12b"
        "881dc200c9833da726e9376c2e32cff7",
    },
    {
        "name": "RFC 4231 4.3 (Test Case 2) — short key",
        "key": b"Jefe",
        "data": b"what do ya want for nothing?",
        "tag": "5bdcc146bf60754e6a042426089575c7"
        "5a003f089d2739839dec58b964ec3843",
    },
    {
        "name": "RFC 4231 4.4 (Test Case 3)",
        "key": bytes([0xAA] * 20),
        "data": bytes([0xDD] * 50),
        "tag": "773ea91e36800e46854db8ebd09181a7"
        "2959098b3ef8c122d9635514ced565fe",
    },
    {
        "name": "RFC 4231 4.5 (Test Case 4)",
        "key": bytes(range(0x01, 0x1A)),  # 0102...19, 25 octets
        "data": bytes([0xCD] * 50),
        "tag": "82558a389a443c0ea4cc819899f2083a"
        "85f0faa3e578f8077a2e3ff46729665b",
    },
    {
        "name": "RFC 4231 4.6 (Test Case 5) — 128-bit truncation",
        "key": bytes([0x0C] * 20),
        "data": b"Test With Truncation",
        "tag128": "a3b6167473100ee06e0c796c2955552b",
    },
    {
        "name": "RFC 4231 4.7 (Test Case 6) — key larger than one block",
        "key": bytes([0xAA] * 131),
        "data": b"Test Using Larger Than Block-Size Key - Hash Key First",
        "tag": "60e431591ee0b67f0d8a26aacbf5b77f"
        "8e0bc6213728c5140546040f0ee37f54",
    },
    {
        "name": "RFC 4231 4.8 (Test Case 7) — key and data larger than one block",
        "key": bytes([0xAA] * 131),
        "data": b"This is a test using a larger than block-size key and a "
        b"larger than block-size data. The key needs to be hashed "
        b"before being used by the HMAC algorithm.",
        "tag": "9b09ffa71b942fcb27635fbcd5b0e944"
        "bfdc63644f0713938a7f51535c3a35e2",
    },
]


# --- The #925 `source_item_id` v1 framer, written out independently --------
#
# #924 treats `source_item_id` as OPAQUE bytes; #925 owns what is inside it.
# This framer exists anyway, for one reason: without it the cross-layer vector
# below could only be minted by copying a hex string out of the TypeScript
# tests, and a copied golden proves nothing about either side. Written from
# `src/services/metaImport/sourceItemId.ts`'s LAYOUT SECTION rather than from
# its code, and checked against two goldens that file's test already pins.
#
# Layout, big-endian throughout:
#   u8 version = 0x01
#   u8 kind
#   kind 0x01 — content-derived
#     i64 timestamp        epoch SECONDS, two's complement. Deliberately NOT
#                          the epoch MILLISECONDS of ImportMetaV1.
#     u32 textLen, bytes   UTF-8 of the repaired, PRE-NFC text
#     u32 urlLen,  bytes   UTF-8 of the link url; 0 when none
#     u32 mediaCount
#     mediaCount x (u32 len, bytes)   UTF-8 of each media BASENAME, sorted by
#                                     UTF-8 BYTE order, duplicates kept, video
#                                     included
#   kind 0x02 — platform id (Instagram fbid)
#     u32 idLen, bytes     UTF-8 of the fbid string

SOURCE_ITEM_ID_VERSION = 0x01
KIND_CONTENT = 0x01
KIND_PLATFORM = 0x02


def _u32(value: int) -> bytes:
    return value.to_bytes(4, "big", signed=False)


def _basename(uri: str) -> str:
    """Everything after the last '/'. 'a/b/c.jpg' -> 'c.jpg'."""
    return uri.rsplit("/", 1)[-1]


def frame_content(
    timestamp_seconds: int, text: str, link_url: str | None, media_uris: list[str]
) -> bytes:
    text_bytes = text.encode("utf-8")
    url_bytes = b"" if link_url is None else link_url.encode("utf-8")
    # sorted() on bytes IS UTF-8 byte order — the property the TS side has to
    # hand-roll, because JS's default sort compares UTF-16 code units and
    # disagrees for every astral character.
    media = sorted(_basename(uri).encode("utf-8") for uri in media_uris)

    out = bytearray([SOURCE_ITEM_ID_VERSION, KIND_CONTENT])
    out += timestamp_seconds.to_bytes(8, "big", signed=True)
    out += _u32(len(text_bytes)) + text_bytes
    out += _u32(len(url_bytes)) + url_bytes
    out += _u32(len(media))
    for name in media:
        out += _u32(len(name)) + name
    return bytes(out)


def frame_platform(platform_id: str) -> bytes:
    id_bytes = platform_id.encode("utf-8")
    return bytes([SOURCE_ITEM_ID_VERSION, KIND_PLATFORM]) + _u32(len(id_bytes)) + id_bytes


# Goldens already pinned in
# src/services/metaImport/__tests__/sourceItemId.test.ts. If this framer and
# that table ever disagree, the cross-layer vector below is minted from the
# wrong bytes and the mismatch has to be resolved BEFORE anything is published.
FRAME_GOLDENS = [
    {
        "name": "sourceItemId.test.ts — astral emoji, mixed media, unsorted uris",
        "frame": lambda: frame_content(
            1600000000,
            # U+1F3D6 plus the U+FE0F variation selector: the selector is part
            # of the member's text and must be framed, not stripped.
            "Beach day \U0001F3D6\uFE0F with the kids",
            None,
            [
                "your_facebook_activity/posts/media/b.jpg",
                "your_facebook_activity/posts/media/a.jpg",
                "posts/media/c.mp4",
            ],
        ),
        "hex": "0101000000005f5e10000000001f42656163682064617920f09f8f96efb88f20"
        "7769746820746865206b696473000000000000000300000005612e6a70670000"
        "0005622e6a706700000005632e6d7034",
    },
    {
        "name": "sourceItemId.test.ts — instagram fbid, kind 0x02",
        "frame": lambda: frame_platform("17912345678901234"),
        "hex": "0102000000113137393132333435363738393031323334",
    },
    {
        # The one golden where the two sort orders DISAGREE, and therefore the
        # only one that actually checks the media sort rather than the layout.
        # U+FFFD encodes as EF BF BD and U+10000 as F0 90 80 80, so UTF-8 byte
        # order puts U+FFFD first; UTF-16 code-unit order compares the lead
        # surrogate D800 against FFFD and puts U+10000 first. Python's
        # sorted() over bytes IS byte order; the TS side hand-rolls it
        # (sortBasenamesUtf8), because JS's default sort is the UTF-16 one.
        # Without this entry both framers could agree on UTF-16 order and the
        # cross-layer vector would still mint cleanly.
        "name": "sourceItemId.test.ts — UTF-8 byte order, not UTF-16 order",
        "frame": lambda: frame_content(
            1600000004,
            "",
            None,
            ["\U00010000.jpg", "�.jpg"],
        ),
        "hex": "0101000000005f5e10040000000000000000000000020000000"
        "7efbfbd2e6a706700000008f09080802e6a7067",
    },
]


def self_check() -> None:
    """Reproduce every RFC value above, or abort."""
    failures = []

    for case in RFC5869:
        prk = hkdf_extract(case["salt"], case["ikm"])
        if prk.hex() != case["prk"]:
            failures.append(f"{case['name']}: PRK {prk.hex()} != {case['prk']}")
        okm = hkdf_sha256(case["ikm"], case["salt"], case["info"], case["length"])
        if okm.hex() != case["okm"]:
            failures.append(f"{case['name']}: OKM {okm.hex()} != {case['okm']}")
        else:
            print(f"SELFCHECK ok  {case['name']} (L={case['length']})")

    for case in RFC4231:
        tag = hmac_sha256(case["key"], case["data"])
        if "tag128" in case:
            got, want = tag[:16].hex(), case["tag128"]
        else:
            got, want = tag.hex(), case["tag"]
        if got != want:
            failures.append(f"{case['name']}: tag {got} != {want}")
        else:
            print(f"SELFCHECK ok  {case['name']}")

    for golden in FRAME_GOLDENS:
        got = golden["frame"]().hex()
        if got != golden["hex"]:
            failures.append(f"{golden['name']}: frame {got} != {golden['hex']}")
        else:
            print(f"SELFCHECK ok  {golden['name']}")

    if failures:
        print("\nSELF-CHECK FAILED — no vectors minted:", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        sys.exit(1)

    print(
        f"SELFCHECK PASS {len(RFC5869)} HKDF + {len(RFC4231)} HMAC published "
        f"values and {len(FRAME_GOLDENS)} TypeScript frame goldens reproduced; "
        "minting Orbital vectors below.\n"
    )


# --- Vectors this script actually mints -------------------------------------
#
# Item 11 of the #917 test list: three HKDF vectors that vary only `info`, and
# three HMAC vectors that vary only `input`, across widening UTF-8 ranges. The
# point is encoder fidelity: a latin1-truncating encoder (#373) and a
# surrogate-mangling one both produce different bytes and so fail these.

UTF8_IKM = bytes([0x11] * 32)
UTF8_SALT = b"orbital-kdf-kat-v1"
UTF8_HMAC_KEY = bytes([0x22] * 32)

UTF8_CASES = [
    ("kat_utf8_ascii", "orbital-import-2026-11-04"),
    # Every codepoint here is above U+00FF, so a latin1 encoder cannot represent
    # any of it: Cyrillic, CJK, Greek.
    ("kat_utf8_non_latin1", "Пост-日本語-Ω"),
    # Non-BMP (each person is U+1F46x, a surrogate pair in UTF-16) joined by
    # U+200D ZWJ, plus a regional-indicator flag pair.
    ("kat_utf8_emoji", "👩‍👩‍👧‍👦 family 🇺🇸 flag"),
]

# Item 12: the end-to-end #924 derivation as one fixture.
#   K_import   = hkdf_sha256(group_key, "orbital-meta-import-v1", user_id, 32)
#   import_key = hmac_sha256(K_import, source || 0x00 || source_item_id)[..16]
IMPORT_GROUP_KEY = bytes([0x42] * 32)
IMPORT_SALT = b"orbital-meta-import-v1"
IMPORT_USER_ID = b"3f2a1c6e-8b4d-4f1a-9c7e-5d0a2b6f8e14"  # lowercase, hyphenated
IMPORT_SOURCE = b"facebook"
IMPORT_ITEM_ID = "pfbid0Qx7m9Lz2👩‍👩‍👧‍👦-post"


# Item: the #924 derivation over REAL #925 frames, one per `kind`. Same group
# key and member as `orbital_import_kat` above, so `K_import` is identical and
# any difference in the result localises to the frame.
#
# kind 0x01 deliberately stacks everything a naive encoder gets wrong into one
# vector: Cyrillic and CJK (above U+00FF, so a latin1 truncation changes the
# bytes), a ZWJ family sequence (non-BMP, surrogate pairs in UTF-16), a URL,
# and three basenames whose SORTED order differs from their file order — with a
# video among them, because a post's identity includes media #925 holds.
FRAME_V1_TIMESTAMP = 1700000000  # epoch SECONDS
FRAME_V1_TEXT = "Привет 日本語 👩‍👩‍👧‍👦 family"
FRAME_V1_URL = "https://example.org/post/42"
FRAME_V1_MEDIA = [
    "your_facebook_activity/posts/media/clip.mp4",
    "posts/media/b.jpg",
    "your_facebook_activity/posts/media/a.jpg",
]
FRAME_V2_FBID = "17998877665544332"
FRAME_V2_SOURCE = b"instagram"


def mint_frame_vectors() -> None:
    k_import = hkdf_sha256(IMPORT_GROUP_KEY, IMPORT_SALT, IMPORT_USER_ID, 32)

    for label, source, frame in (
        (
            "orbital_import_v1_frame",
            IMPORT_SOURCE,
            frame_content(FRAME_V1_TIMESTAMP, FRAME_V1_TEXT, FRAME_V1_URL, FRAME_V1_MEDIA),
        ),
        ("orbital_import_v2_fbid", FRAME_V2_SOURCE, frame_platform(FRAME_V2_FBID)),
    ):
        framed = source + b"\x00" + frame
        tag = hmac_sha256(k_import, framed)
        import_key = tag[:16]

        print(f"// --- {label}: the #924 derivation over a real #925 frame ---")
        print(f"FIXTURE:{label}:source_text={source.decode()}")
        print(f"FIXTURE:{label}:frame_hex={frame.hex()}")
        print(f"FIXTURE:{label}:k_import={k_import.hex()}")
        print(f"FIXTURE:{label}:hmac_input_hex={framed.hex()}")
        print(f"FIXTURE:{label}:hmac_tag_full={tag.hex()}")
        print(f"FIXTURE:{label}:import_key_16={import_key.hex()}")
        print(f"FIXTURE:{label}:import_key_b64={base64.b64encode(import_key).decode()}")
        print()


def mint_utf8_vectors() -> None:
    print("// --- UTF-8 encoder-fidelity vectors (HKDF: info varies) ---")
    print(f"// ikm  = {UTF8_IKM.hex()}")
    print(f"// salt = {UTF8_SALT.decode()!r} = {UTF8_SALT.hex()}")
    print("// output_len = 32")
    for name, text in UTF8_CASES:
        info = text.encode("utf-8")
        okm = hkdf_sha256(UTF8_IKM, UTF8_SALT, info, 32)
        print(f"FIXTURE:{name}:hkdf_info_text={text}")
        print(f"FIXTURE:{name}:hkdf_info_hex={info.hex()}")
        print(f"FIXTURE:{name}:hkdf_okm={okm.hex()}")
    print()

    print("// --- UTF-8 encoder-fidelity vectors (HMAC: input varies) ---")
    print(f"// key = {UTF8_HMAC_KEY.hex()}")
    for name, text in UTF8_CASES:
        data = text.encode("utf-8")
        tag = hmac_sha256(UTF8_HMAC_KEY, data)
        print(f"FIXTURE:{name}:hmac_input_hex={data.hex()}")
        print(f"FIXTURE:{name}:hmac_tag={tag.hex()}")
    print()


def mint_import_vector() -> None:
    item_id = IMPORT_ITEM_ID.encode("utf-8")
    framed = IMPORT_SOURCE + b"\x00" + item_id
    k_import = hkdf_sha256(IMPORT_GROUP_KEY, IMPORT_SALT, IMPORT_USER_ID, 32)
    tag = hmac_sha256(k_import, framed)
    import_key = tag[:16]

    print("// --- orbital_import_kat: the end-to-end #924 derivation ---")
    print(f"FIXTURE:orbital_import:group_key={IMPORT_GROUP_KEY.hex()}")
    print(f"FIXTURE:orbital_import:salt_text={IMPORT_SALT.decode()}")
    print(f"FIXTURE:orbital_import:user_id_text={IMPORT_USER_ID.decode()}")
    print(f"FIXTURE:orbital_import:k_import={k_import.hex()}")
    print(f"FIXTURE:orbital_import:source_text={IMPORT_SOURCE.decode()}")
    print(f"FIXTURE:orbital_import:source_item_id_text={IMPORT_ITEM_ID}")
    print(f"FIXTURE:orbital_import:source_item_id_hex={item_id.hex()}")
    print(f"FIXTURE:orbital_import:hmac_input_hex={framed.hex()}")
    print(f"FIXTURE:orbital_import:hmac_tag_full={tag.hex()}")
    print(f"FIXTURE:orbital_import:import_key_16={import_key.hex()}")
    # Standard padded base64 (RFC 4648 section 4), NOT base64url — this is the
    # wire form the backend validates with IMPORT_KEY_B64_RE.
    print(
        "FIXTURE:orbital_import:import_key_b64="
        f"{base64.b64encode(import_key).decode()}"
    )
    print()


if __name__ == "__main__":
    self_check()
    mint_utf8_vectors()
    mint_import_vector()
    mint_frame_vectors()
