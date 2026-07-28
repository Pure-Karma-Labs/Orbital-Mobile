//! Golden serialized-`SessionRecord` regression fixtures.
//!
//! Added in #634 (libsignal v0.97.4 -> v0.99.1), which moves the PQ ratchet crate
//! `spqr` from v1.5.1 to v1.5.3.  v1.5.3 tightens `ChainEpochDirection::from_pb`:
//! a persisted `next` field that is non-empty and not exactly 32 bytes is now
//! rejected with `Error::StateDecode`.  That validation runs on the *restore*
//! path, i.e. whenever a previously-persisted `SessionRecord` is deserialized and
//! ratcheted.
//!
//! The Signal 1:1 session API is currently exported but has no production callers
//! (Issue #200, closed 2026-05-28 as a deliberate deferral — DMs reuse the
//! ECIES + AES-GCM group architecture; `signalSessionRepository.saveSession()`
//! exists but has no caller outside its own test file), so no `SessionRecord`
//! is ever persisted on a real device and a
//! device-level test of this path would exercise nothing.  These fixtures replace
//! that unperformable step with a deterministic, byte-level artifact: session
//! records and a ciphertext captured from the PRE-bump build, replayed against the
//! current build.
//!
//! What each golden test proves:
//!
//! * `golden_session_record_alice_encrypt` — a restored session record deserializes
//!   and its SPQR send chain still ratchets (`spqr::send` decodes the persisted
//!   chain state).
//! * `golden_session_record_bob_decrypt` — a Double Ratchet message produced by the
//!   PRE-bump build decrypts against a PRE-bump session record on the current
//!   build (old encrypts -> new decrypts), exercising `spqr::recv` state decode.
//! * `golden_session_record_truncated_state_rejected` — the fixtures have teeth:
//!   a truncated session record is rejected rather than silently accepted.
//!
//! ## Fixture provenance (record this on every regeneration)
//!
//! | Field | Value |
//! |---|---|
//! | Captured from | `main` @ `4322b4c` (pre-bump working tree) |
//! | libsignal tag | **v0.97.4** (pre-bump) |
//! | spqr version  | **1.5.1** (pre-bump) |
//! | `[patch.crates-io]` | present — `signal-curve25519-4.1.3` fork active |
//! | Captured on | 2026-07-27, before the v0.99.1 bump in this same PR (#634) |
//!
//! Provenance is recorded here because it cannot be recovered from the diff:
//! these constants were committed in the SAME commit as the v0.99.1 bump, and
//! the generator draws fresh random keys on every run, so there is no second
//! artifact to compare against.
//!
//! Note explicitly what "these fixtures pass on both trees" does and does NOT
//! prove. spqr 1.5.3 only *tightens* `ChainEpochDirection::from_pb` (it rejects
//! a `next` field that is non-empty and not exactly 32 bytes). A tightening is
//! backward-compatible on well-formed input, so a fixture captured POST-bump
//! would also pass against 1.5.1 — passing on both trees therefore cannot
//! discriminate pre- from post-bump capture. The table above is the only
//! evidence of capture order; keep it accurate.
//!
//! ## How to regenerate
//!
//! ```sh
//! cargo test --test golden_session_record_tests -- --ignored --nocapture \
//!     2>&1 | grep '^FIXTURE:'
//! ```
//!
//! Regenerating these fixtures on a NEW libsignal version defeats their purpose —
//! they only detect a state-format regression while they predate the bump under
//! test.  Regenerate only when the pinned version they were captured on is
//! deliberately retired.

use orbital_signal::*;

/// Decode a hex string fixture.  These blobs are kilobytes long (a PQXDH session
/// record carries an ML-KEM ciphertext plus SPQR chain state), which is past the
/// point where `hex_literal::hex!` stays readable, so they are stored as wrapped
/// string literals and decoded at runtime.
fn hex_to_bytes(s: &str) -> Vec<u8> {
    assert!(
        s.len().is_multiple_of(2),
        "hex fixture must have even length"
    );
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("valid hex fixture"))
        .collect()
}

fn alice_identity() -> IdentityKeyPairData {
    IdentityKeyPairData {
        public_key: hex_to_bytes(ALICE_PUBLIC_KEY),
        private_key: hex_to_bytes(ALICE_PRIVATE_KEY),
    }
}

fn bob_identity() -> IdentityKeyPairData {
    IdentityKeyPairData {
        public_key: hex_to_bytes(BOB_PUBLIC_KEY),
        private_key: hex_to_bytes(BOB_PRIVATE_KEY),
    }
}

/// Addresses are bound into the message MAC, so the golden tests must reuse the
/// exact names the generator used.
fn alice_address() -> ProtocolAddressData {
    ProtocolAddressData {
        name: "alice-uuid-golden-session".to_string(),
        device_id: 1,
    }
}

fn bob_address() -> ProtocolAddressData {
    ProtocolAddressData {
        name: "bob-uuid-golden-session".to_string(),
        device_id: 1,
    }
}

const MSG3_PLAINTEXT: &[u8] = b"golden session fixture: message 3";

// =============================================================================
// Fixtures — captured from the pre-bump (libsignal v0.97.4 / spqr 1.5.1) build
// =============================================================================

/// Alice identity public key (33 bytes)
const ALICE_PUBLIC_KEY: &str = "05cfd919a3c75862b3d86789ce1053278a0363cdb8a702d2147eded4832d12037e";

/// Alice identity private key — SYNTHETIC TEST VECTOR, never used outside this file (32 bytes)
const ALICE_PRIVATE_KEY: &str = "a8e2c0b01c5d68f9028f73941a92b998fc6204b6d5d2c9a1d1cd70bd98350956";

/// Bob identity public key (33 bytes)
const BOB_PUBLIC_KEY: &str = "05b2626b7aa669677817f03b7c960b6623a16cb803e93d072e72216616b0b80e2a";

/// Bob identity private key — SYNTHETIC TEST VECTOR, never used outside this file (32 bytes)
const BOB_PRIVATE_KEY: &str = "3037119d537b8496f6185732e90a164bb7f106758e02f400a27e9b792c71814d";

/// Alice session record after send + receive (SPQR A2B chain, one epoch each way) (4294 bytes)
const ALICE_SESSION_RECORD: &str = concat!(
    "0ac3210804122105cfd919a3c75862b3d86789ce1053278a0363cdb8a702d2147eded4832d12037e1a2105b2",
    "626b7aa669677817f03b7c960b6623a16cb803e93d072e72216616b0b80e2a2220ed8a024852f6827059ee35",
    "86441ed92e82f615b7915520a2de21b9b9cf8ed8e032690a210581afd16e7c7a225627d448280470e2d18b84",
    "3e36353e4c680ff1a32235c9e44a1220a8c4dc7acbe8889423bfc06340104a50ebaf043e204a419fff52c2d7",
    "d154104a1a221220d86b655343d94fc8dc253af57da182ce1a4e2f16663ec71d0785df6b66868af83a470a21",
    "0591c67b45d031b4f0e0615ee05480891a46130a5b0e859ee27e88650adfc4450b1a221220b9a68cd7dd6660",
    "a0049801d37a6fd0238330f0a751b0f3abe0f9f82522d21a603a490a2105da8bbb0629ac0843a75668a74b5a",
    "63596d37a155b6288e3e591056da170071071a240801122017916173202639ed248eb0cdb1ada8c7f45c7986",
    "28bd0639b4be3ea17b5db6da500258016a210576f53953768b069c02d173f84664b275c36a2030f5921bf93c",
    "ba39c5c5bf64477ab01e12721a4c0a2408011220ed3a0b62a65528c7eae96a337e5a58afd6e1f03d0343a2a5",
    "36ac50b464c77ecd1224080112203b2f5e25a19578635300029a8f4a51071990a2c43a1577e7f1bd522f473f",
    "92582220fa112791042104f9fcf158447952f94c3b72647cf2f5f5f2d6f81946e6d92b2332001ab91d12b61d",
    "0aae1c080112440a20de8c83a27db9198143b202e7b3c97925121ce487770ec98e30760efedeb92aab1220a0",
    "7640748f17693eacdeb60461a2945a9085e098a216c98e2030a2467d296bad1a8009ec8979b15c9228001bd2",
    "199bcf39a8aaeaccc2a3292cb61d4ce24b4f0aa8387322e5237edddbc58bd32be87136b2271b27ec23f7e523",
    "25b4314d919605a2a63c75b70ce6b2b4d133251947b5b6231f0c7b4a9687e2ac14d67a7aa3c71ac1a183e5cb",
    "cad3438e93511572107ef1fa6a6a2a05c72217e714392106bec1476a5041cd17d02243503142768022b3652d",
    "386411667645f3089ba3520f63391e721e71d871c038670e9a753b973a9045a927d08959b112acbcccaeeaa7",
    "6e3757a9e69fcdf75efd077c67d2276adc5949b50e0d649a8d4c921a35919dd5bdb2e1a818bb21d699b9a071",
    "35c8fcc314f190ed787b7a9a1276a934d2b267e9d880b3066f11d18c34cc72c05b6377a2617446a119c7b13c",
    "6a4e43b87af4979efaf241b89361d456baeacccf5f7b95bc205d29b94a221c6f4eb1253a0504e33499d68461",
    "4d62356fc368977952813c2b4775147074c72e225e8b048c8e44652665babaa38a25fa7f50d14d1c6356e0db",
    "6f706b3ce10ac8d04527fdcb0dbd682a6fe407096cb2a4530631947ff3f498e0244d1c3404fdc4aeb18769ca",
    "99b552e46efde56ecf201b366b3e35a3c718081675599d5c18bc4c62ab3d37bb6c6b8266536880ba607f3345",
    "c322223825484a1a6d79751c0be21b12d158d7f0725fd88539e52065826b55aaa5a014cff5a38fe815b6dfb6",
    "275bf9226b577ccb79288d98102eca418279553deac8f5c570e0a6ab7a826947d4436da3494cf5a6a0c40a76",
    "46870474922f74ba9b6aac26424474d87b32d2c82c098dcc66bc55057e06182ee1cab6063033bd13516172ae",
    "bc30893394274cf08546c99ba4f392f090be2f849e37676e5f4b2bf7f38d0f497a43b8586c6ba17c11b4b98c",
    "59920a11ba714d9a26415104913a96497a55ae0d931508a9183a84783ce76e0d8816b4898938480c1ab44063",
    "f8a79a93163ea52029ab3b60b4b3648c237332bdfc4a14fad5b1fdd69ac8a42774908dee542890458f7c5888",
    "7e837c622a5ffc34169aa96c98fb93dd1543101238435785202208bcc311bae15555aa4ca80a57aeb2b78f26",
    "65532300a0987a88a241f0bc93a5912d3a44004a93b42f977d9bac3fe95a5c16ba0a86a96e17b518c0b58f2b",
    "ea1a832c6771497d94759c54a84fa614cea7530c09c7c71bc449c1b2786b52c9627556ecd02ced9375fdf794",
    "d4f0253ffc15b88738070a9a52aa607022c8ff78911f8062bb1408c150b44d1a421f55a23a41c197746ce786",
    "2fed73ad06f5647c6489a247795d8248f4b76429dcbb28ea2ac279c7afa80d55098835d9aceb88047724c511",
    "c23bd3f24ef1aaa763e07fe0939ce9cc50a903a748e603cd545a0bc0a04956b75817ce23ab0feee7bbcc837b",
    "d1bca17d0ca44cda6aa0c00986910e285a151e66917dcbb4aaa0be842566f356787f7a3e9d055fca5cba1cf9",
    "848f003794700f3f6c73874a3d039cb7a0958991e94c07da4304b61adbea3a5f164eb6857bb758c1afa8ce2b",
    "6ba51ed8b750c9966a83ca2ce255dc92069c6404f371a27a56ae0bf2c273b212863653cc0acb9400a28c7b5e",
    "fc4ca4919b22bde46d26b75f127c723387caf80a6439ca0b3ea073c1a7cb4d7629f37b371bb5ac4d759e22e0",
    "12c2f41d9af7a19ae39975a922a3bc9e5ca3a1e599585023a228cca3c0440348a614611c23e3b9076ba36ca0",
    "9b921ae8bf3796c4a05cbc2e80073ee79fb81abe01634a66f75029f697d3b55aef7aadc9d5ce5f0c1d0adb8a",
    "ab23573a02a04550408e36022e57773d26bcb7327c141010e0c3338b56746d11803275517214480de502b770",
    "59dd230e01291ec1748a8d7aa21c140b3f313d0732b99efb4760214a79d6360f560287b9410a8c85b1872b13",
    "aa121dfb79d2314128caab18ea8742969fbfc536d193b9541268849412c302ad2568a4f7dc233cd8c4114b11",
    "3014c02cf5920e5a270ba724c7709d1e9249b25a8523c47819b69da7295d2d406cde32ad9716b99b23708d48",
    "39f1f86a1fda1308ec264c07c1bc9783999643092c6cb266a47d89b3632234e152a36bfa15f9c51916251222",
    "e9b440d80cb9386174538a45c0bb9908cfe8b98b91467565b9675ba35c6e2b8776b72d0eaab8ef50015c8582",
    "5eea29fc22c792c10208f46c0ab30fc4127ea521768f720ffca3a255d84d5a765fc8b41ab473010f359a6b31",
    "61bcdb8620c348f4e59921826aab6ac2080880bf93186cd62900c695299c9e888022b036419cab07be932de4",
    "58c774151e8f9a2e70e2ae846c33bc68b7f4fa0cdb9c613a97c8d93b66552588026a4cacc3bcae05c7c4f639",
    "41623b6430ad7e092661665b4cd30819c997e75ac31c2b7183d7c42c52acc44bcee7173653613ccff5ce5120",
    "35db398a0f082dd81896bcbc5a3736bdf04a003c5505af3307f0f45128824009472b0b94354d674e30529024",
    "58419d77394c96a58e79447b507fee3c3d4b1b09daa59628db7c7b9a3f22b7bde4d8676d0530a87a7a921054",
    "1ad284e063c8dc9532a79927f85b124c597b29d603fad66bccd7494681091879115e7cb62e60389ebb323a46",
    "90b5bb16542b545e6a4281a04d0778ca3fb17919d9970989495f2675bee1bd7d6470df6c0bacc55186ab9b30",
    "134c37cab01b81ba4b8614ebe96e699b0087c2699cb2a35b202367ea9cf87457751a920a027ee8c05d378c71",
    "f773a02ac88302f44789fcb5bc222c882bb47161c6fb57129f708c49554a83fcc8f625a79bd48a53b308a7a5",
    "8a688892aceb866ae652b854795a6482588c296bc05fe48270190b2567843a4ddbbb294cb227f2423c208449",
    "a49dba7a6da30c606103d04794b0aa7318f4793d92746fc6ca327a60adaa9c28f9f7a3df79710b09ce3c4020",
    "7d029fd4a78de088cc9d2c34c9723e8de00645751b72d73fc6ca6fa5e448c32149fbd048e4925c822326e8b3",
    "6cc1089cb9c1bc30164bd02210ee8c07bad9703bdc2254c887a6fb9d6ad92c3210a631d38f822668af36ae65",
    "1b63d4b6c34aa9b3a3dac8f0e6c4f33b7e37974ca6b9b67ae00fae614ca6920115145da3f012fc2b349348c1",
    "04f38bfb31984c6932ab4613cf582b0f426f9a787031812d91e2b2e54528152401a0f033ee4035a7c8069475",
    "03b1092d4960262746cf40a32d67b6511a15bf83e0c526fb1ca36c9cb9eb9e4bac13c33c200db1bf3f8386a4",
    "414c4ccc2a6e132464bcb8e1f6094a73a093a35294866c3f932042a1024bb827805bca2a48190aa7058317b0",
    "86ec353fb1bf04f654ec8979b15c9228001bd2199bcf39a8aaeaccc2a3292cb61d4ce24b4f0aa8387322e523",
    "7edddbc58bd32be87136b2271b27ec23f7e52325b4314d919605a2a63c75b70ce6b2b4d133251947b5b6231f",
    "0c7b4a9687e2ac14d67a7aa3c71ac1a183e5cbcad3438e93511572107ef1fa6a6a2a05c72217e714392106be",
    "c1476a5041cd17d02243503142768022b3652d386411667645f3089ba3520f63391e721e71d871c038670e9a",
    "753b973a9045a927d08959b112acbcccaeeaa76e3757a9e69fcdf75efd077c67d2276adc5949b50e0d649a8d",
    "4c921a35919dd5bdb2e1a818bb21d699b9a07135c8fcc314f190ed787b7a9a1276a934d2b267e9d880b3066f",
    "11d18c34cc72c05b6377a2617446a119c7b13c6a4e43b87af4979efaf241b89361d456baeacccf5f7b95bc20",
    "5d29b94a221c6f4eb1253a0504e33499d684614d62356fc368977952813c2b4775147074c72e225e8b048c8e",
    "44652665babaa38a25fa7f50d14d1c6356e0db6f706b3ce10ac8d04527fdcb0dbd682a6fe407096cb2a45306",
    "31947ff3f498e0244d1c3404fdc4aeb18769ca99b552e46efde56ecf201b366b3e35a3c718081675599d5c18",
    "bc4c62ab3d37bb6c6b8266536880ba607f3345c322223825484a1a6d79751c0be21b12d158d7f0725fd88539",
    "e52065826b55aaa5a014cff5a38fe815b6dfb6275bf9226b577ccb79288d98102eca418279553deac8f5c570",
    "e0a6ab7a826947d4436da3494cf5a6a0c40a7646870474922f74ba9b6aac26424474d87b32d2c82c098dcc66",
    "bc55057e06182ee1cab6063033bd13516172aebc30893394274cf08546c99ba4f392f090be2f849e37676e5f",
    "4b2bf7f38d0f497a43b8586c6ba17c11b4b98c59920a11ba714d9a26415104913a96497a55ae0d931508a918",
    "3a84783ce76e0d8816b4898938480c1ab44063f8a79a93163ea52029ab3b60b4b3648c237332bdfc4a14fad5",
    "b1fdd69ac8a42774908dee542890458f7c58887e837c622a5ffc34169aa96c98fb93dd154310123843578520",
    "2208bcc311bae15555aa4ca80a57aeb2b78f2665532300a0987a88a241f0bc93a5912d3a44004a93b42f977d",
    "9bac3fe95a5c16ba0a86a96e17b518c0b58f2bea1a832c6771497d94759c54a84fa614cea7530c09c7c71bc4",
    "49c1b2786b52c9627556ecd02ced9375fdf794d4f0253ffc15b88738070a9a52aa607022c8ff78911f8062bb",
    "1408c150b44d1a421f55a23a41c197746ce7862fed73ad06f5647c6489a247795d8248f4b76429dcbb28ea2a",
    "c279c7afa80d55098835d9aceb88047724c511c23bd3f24ef1aaa763e07fe0939ce9cc50a903a748e603cd54",
    "5a0bc0a04956b75817ce23ab0feee7bbcc837bd1bca17d0ca44cda6aa0c00986910e285a151e66917dcbb4aa",
    "a0be842566f356787f7a3e9d055fca5cba1cf9848f003794700f3f6c73874a3d039cb7a0958991e94c07da43",
    "04b61adbea3a5f164eb6857bb758c1afa8ce2b6ba51ed8b750c9966a83ca2ce255dc92069c6404f371a27a56",
    "ae0bf2c273b212863653cc0acb9400a28c7b5efc4ca4919b22bde46d26b75f127c723387caf80a6439ca0b3e",
    "a073c1a7cb4d7629f37b371bb5ac4d759ecdb8dfabbca5f366caf79760af30bf090286681fcb62360ca1d0ae",
    "7a5f4ae0b96d25404bebb99dc7b21f397d03832573797121ba2e6a5c498189d9347f670b4736f717ec4dc4fa",
    "a4806c684e5fb0c663379cba85969644fd25bfec672473978612820108011206cdb86d25a6011206dfab404b",
    "183e1206bca5ebb92cd61206f3669dc717fa1206caf7b21f419912069760397d05da1206af3003836b841206",
    "bf09257305f3120602867971b7d11206681f21ba9a151206cb622e6afb031206360c5c4910aa1206a1d08189",
    "72201206ae7ad9349be412065f4a7f67e9d31206e0b90b4792d9",
);

/// Bob session record after receive + send (SPQR B2A chain) (635 bytes)
const BOB_SESSION_RECORD: &str = concat!(
    "0af8040804122105b2626b7aa669677817f03b7c960b6623a16cb803e93d072e72216616b0b80e2a1a2105cf",
    "d919a3c75862b3d86789ce1053278a0363cdb8a702d2147eded4832d12037e22209a1deaa6a4ee1cf7c3e2f8",
    "4322d6336a36b3d95c4f2123cabea6964ed1582abd326b0a2105da8bbb0629ac0843a75668a74b5a63596d37",
    "a155b6288e3e591056da170071071220604fa482bd7132e1f017dec63b42a132fd8510bc4e064228dea1fcf5",
    "bae465681a240801122017916173202639ed248eb0cdb1ada8c7f45c798628bd0639b4be3ea17b5db6da3a49",
    "0a2105269092dbaedffc867d8a7b55161ab102a5d2f310af252b6524bd486b20333d5b1a24080112209f28cc",
    "7ada7be653754249e2b63238f83133f4c7222ccc38c3f2449f2963c819500158026a210576f53953768b069c",
    "02d173f84664b275c36a2030f5921bf93cba39c5c5bf64477aac02127408011a4c0a24080112203b2f5e25a1",
    "9578635300029a8f4a51071990a2c43a1577e7f1bd522f473f9258122408011220ed3a0b62a65528c7eae96a",
    "337e5a58afd6e1f03d0343a2a536ac50b464c77ecd2220fa112791042104f9fcf158447952f94c3b72647cf2",
    "f5f5f2d6f81946e6d92b2332001ab30132b0010a48080112440a20de8c83a27db9198143b202e7b3c9792512",
    "1ce487770ec98e30760efedeb92aab1220a07640748f17693eacdeb60461a2945a9085e098a216c98e2030a2",
    "467d296bad1264083010101a040000cdb81a040000dfab1a040000bca51a040000f3661a040000caf71a0400",
    "0097601a040000af301a040000bf091a04000002861a040000681f1a040000cb621a040000360c1a040000a1",
    "d01a040000ae7a1a0400005f4a1a040000e0b9",
);

/// SignalMessage (Whisper) produced by the pre-bump build from ALICE_SESSION_RECORD (137 bytes)
const MSG3_CIPHERTEXT: &str = concat!(
    "440a210581afd16e7c7a225627d448280470e2d18b843e36353e4c680ff1a32235c9e44a1000180022302044",
    "6468abbc99e3c60bd86eb66bd6767449fa38e55185e26307d2952e405707cf6e06311bb72493622c0063ea27",
    "12952a2501010201016d25404bebb99dc7b21f397d03832573797121ba2e6a5c498189d9347f670b473c62ef",
    "177566701d",
);

// =============================================================================
// Golden tests
// =============================================================================

/// Alice's persisted session record deserializes and still ratchets forward.
///
/// `signal_encrypt` calls `SessionRecord::deserialize` and then `spqr::send`,
/// which decodes the persisted SPQR chain state — the code path tightened by
/// spqr 1.5.3.
#[test]
fn golden_session_record_alice_encrypt() {
    let result = signal_encrypt(EncryptInput {
        identity_key_pair: alice_identity(),
        registration_id: 1,
        session_record: Some(hex_to_bytes(ALICE_SESSION_RECORD)),
        remote_identity: Some(hex_to_bytes(BOB_PUBLIC_KEY)),
        remote_address: bob_address(),
        local_address: alice_address(),
        plaintext: b"golden session fixture: replayed send".to_vec(),
    })
    .expect("golden session record must deserialize and encrypt");

    assert!(
        !result.ciphertext.serialized.is_empty(),
        "replayed send must produce a ciphertext"
    );
    assert!(
        !result.updated_session_record.is_empty(),
        "replayed send must return an updated session record"
    );
}

/// A Double Ratchet message produced by the pre-bump build decrypts against a
/// pre-bump session record on the current build.
///
/// This is the Signal-1:1 analogue of the ECIES golden fixtures: old encrypts ->
/// new decrypts, across the libsignal / spqr version boundary.
#[test]
fn golden_session_record_bob_decrypt() {
    let result = signal_decrypt(DecryptInput {
        identity_key_pair: bob_identity(),
        registration_id: 2,
        sender_address: alice_address(),
        local_address: bob_address(),
        session_record: hex_to_bytes(BOB_SESSION_RECORD),
        remote_identity: Some(hex_to_bytes(ALICE_PUBLIC_KEY)),
        ciphertext: hex_to_bytes(MSG3_CIPHERTEXT),
    })
    .expect("golden Double Ratchet message must decrypt");

    assert_eq!(
        result.plaintext,
        MSG3_PLAINTEXT.to_vec(),
        "decrypted plaintext must match the fixture"
    );
}

/// Negative: a truncated session record must be rejected, proving the golden
/// tests above are actually parsing the fixture rather than short-circuiting.
#[test]
fn golden_session_record_truncated_state_rejected() {
    let mut truncated = hex_to_bytes(ALICE_SESSION_RECORD);
    truncated.truncate(96);

    let err = signal_encrypt(EncryptInput {
        identity_key_pair: alice_identity(),
        registration_id: 1,
        session_record: Some(truncated),
        remote_identity: Some(hex_to_bytes(BOB_PUBLIC_KEY)),
        remote_address: bob_address(),
        local_address: alice_address(),
        plaintext: b"should never encrypt".to_vec(),
    })
    .expect_err("truncated session record must be rejected");

    assert!(
        matches!(err, SignalError::InvalidMessage { .. }),
        "truncated session record must surface as InvalidMessage, got: {err:?}"
    );
}

// =============================================================================
// Fixture generator (#[ignore]d — run manually to capture new fixture bytes)
// =============================================================================

/// Helper: encode bytes as lowercase hex (generator output only).
fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

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

#[test]
#[ignore]
fn generate_session_record_fixture() {
    let alice_address = ProtocolAddressData {
        name: "alice-uuid-golden-session".to_string(),
        device_id: 1,
    };
    let bob_address = ProtocolAddressData {
        name: "bob-uuid-golden-session".to_string(),
        device_id: 1,
    };

    let alice_identity = generate_identity_key_pair();
    let bob_identity = generate_identity_key_pair();

    // Bob's published pre-key material (PQXDH bundle).
    let bob_pre_key_record = generate_pre_key(634).expect("pre-key");
    let bob_signed_pre_key_record =
        generate_signed_pre_key(634, bob_identity.clone(), 1700000000000).expect("signed pre-key");
    let bob_kyber = generate_kyber_pre_key_sync(634, bob_identity.clone(), 1700000000000, false);

    let pre_key_pub = get_pre_key_public(bob_pre_key_record.clone()).expect("pre-key public");
    let signed_pre_key_pub = get_signed_pre_key_public(bob_signed_pre_key_record.clone())
        .expect("signed pre-key public");
    let kyber_pub = get_kyber_pre_key_public(bob_kyber.record.clone()).expect("kyber public");

    let bundle = PreKeyBundleData {
        registration_id: 2,
        device_id: 1,
        pre_key_id: Some(pre_key_pub.id),
        pre_key_public: Some(pre_key_pub.public_key),
        signed_pre_key_id: signed_pre_key_pub.id,
        signed_pre_key_public: signed_pre_key_pub.public_key,
        signed_pre_key_signature: signed_pre_key_pub.signature,
        identity_key: bob_identity.public_key.clone(),
        kyber_pre_key_id: Some(kyber_pub.id),
        kyber_pre_key_public: Some(kyber_pub.public_key),
        kyber_pre_key_signature: Some(kyber_pub.signature),
    };

    // 1. Alice: X3DH/PQXDH -> outgoing session (SPQR initial_state, direction A2B).
    let bundle_result = process_pre_key_bundle(ProcessPreKeyBundleInput {
        identity_key_pair: alice_identity.clone(),
        registration_id: 1,
        remote_address: bob_address.clone(),
        local_address: alice_address.clone(),
        bundle,
        existing_session_record: None,
        remote_identity: None,
    })
    .expect("process_pre_key_bundle");

    // 2. Alice -> Bob, message 1 (PreKeySignalMessage).
    let msg1 = signal_encrypt(EncryptInput {
        identity_key_pair: alice_identity.clone(),
        registration_id: 1,
        session_record: Some(bundle_result.updated_session_record.clone()),
        remote_identity: Some(bundle_result.identity_key.clone()),
        remote_address: bob_address.clone(),
        local_address: alice_address.clone(),
        plaintext: b"golden session fixture: message 1".to_vec(),
    })
    .expect("alice encrypt msg1");

    // 3. Bob decrypts msg1 -> Bob's session (SPQR direction B2A, one recv).
    let bob_decrypt1 = signal_decrypt_pre_key(DecryptPreKeyInput {
        identity_key_pair: bob_identity.clone(),
        registration_id: 2,
        sender_address: alice_address.clone(),
        local_address: bob_address.clone(),
        existing_session_record: None,
        remote_identity: None,
        pre_key_record: Some(bob_pre_key_record),
        signed_pre_key_record: bob_signed_pre_key_record,
        kyber_pre_key_record: Some(bob_kyber.record),
        ciphertext: msg1.ciphertext.serialized,
    })
    .expect("bob decrypt msg1");

    // 4. Bob -> Alice, message 2 (SignalMessage) — acknowledges the session.
    let msg2 = signal_encrypt(EncryptInput {
        identity_key_pair: bob_identity.clone(),
        registration_id: 2,
        session_record: Some(bob_decrypt1.updated_session_record.clone()),
        remote_identity: Some(bob_decrypt1.sender_identity_key.clone()),
        remote_address: alice_address.clone(),
        local_address: bob_address.clone(),
        plaintext: b"golden session fixture: message 2".to_vec(),
    })
    .expect("bob encrypt msg2");

    // 5. Alice decrypts msg2 -> Alice's session has now both sent and received:
    //    the SPQR chain carries a real (non-initial) epoch on both directions.
    let alice_decrypt2 = signal_decrypt(DecryptInput {
        identity_key_pair: alice_identity.clone(),
        registration_id: 1,
        sender_address: bob_address.clone(),
        local_address: alice_address.clone(),
        session_record: msg1.updated_session_record.clone(),
        remote_identity: Some(bundle_result.identity_key.clone()),
        ciphertext: msg2.ciphertext.serialized,
    })
    .expect("alice decrypt msg2");

    // 6. Alice -> Bob, message 3 (SignalMessage), produced from the session state
    //    captured in step 5. Bob's step-4 session record decrypts it.
    let msg3 = signal_encrypt(EncryptInput {
        identity_key_pair: alice_identity.clone(),
        registration_id: 1,
        session_record: Some(alice_decrypt2.updated_session_record.clone()),
        remote_identity: Some(bundle_result.identity_key.clone()),
        remote_address: bob_address.clone(),
        local_address: alice_address.clone(),
        plaintext: b"golden session fixture: message 3".to_vec(),
    })
    .expect("alice encrypt msg3");

    println!("FIXTURE:session_record");
    println!(
        "FIXTURE:alice_public_key={}",
        to_hex(&alice_identity.public_key)
    );
    println!(
        "FIXTURE:alice_private_key={}",
        to_hex(&alice_identity.private_key)
    );
    println!(
        "FIXTURE:bob_public_key={}",
        to_hex(&bob_identity.public_key)
    );
    println!(
        "FIXTURE:bob_private_key={}",
        to_hex(&bob_identity.private_key)
    );
    println!(
        "FIXTURE:alice_session={}",
        to_hex(&alice_decrypt2.updated_session_record)
    );
    println!(
        "FIXTURE:bob_session={}",
        to_hex(&msg2.updated_session_record)
    );
    println!("FIXTURE:msg3_type={:?}", msg3.ciphertext.message_type);
    println!(
        "FIXTURE:msg3_ciphertext={}",
        to_hex(&msg3.ciphertext.serialized)
    );

    // Self-check: Bob's captured session decrypts Alice's captured msg3.
    let bob_decrypt3 = signal_decrypt(DecryptInput {
        identity_key_pair: bob_identity.clone(),
        registration_id: 2,
        sender_address: alice_address,
        local_address: bob_address,
        session_record: msg2.updated_session_record.clone(),
        remote_identity: Some(bob_decrypt1.sender_identity_key),
        ciphertext: msg3.ciphertext.serialized,
    })
    .expect("self-check bob decrypt msg3");
    assert_eq!(
        bob_decrypt3.plaintext,
        b"golden session fixture: message 3".to_vec()
    );
    println!("FIXTURE:self_check=PASS");
}
