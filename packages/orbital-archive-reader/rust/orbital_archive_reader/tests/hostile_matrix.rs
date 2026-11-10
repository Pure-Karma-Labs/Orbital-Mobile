//! Hostile matrix groups 1-6: size bombs, path attacks, forbidden entry
//! types, limits and container format, integrity, and caps.
//!
//! Every archive here is generated in code. The invariant each test defends is
//! named in its doc comment, because a test that only asserts an enum value is
//! easy to "fix" in the wrong direction.

mod support;

use orbital_archive_reader::testing::{Budgets, MIB};
use orbital_archive_reader::{ArchiveError, EntryKind, EntrySkipCode, ExtractOutcome, JsonOutcome};
use support::zipgen::{
    EntrySpec, FLAG_DATA_DESCRIPTOR, FLAG_ENCRYPTED, FLAG_STRONG_ENCRYPTION, FLAG_UTF8, MODE_DIR,
    MODE_FIFO, MODE_SYMLINK, ZipBuilder, crc32, deflate, instagram_like,
};
use support::{UUID_A, UUID_B, UUID_C, open, try_open};

const JPG: &[u8] = b"\xFF\xD8\xFF\xE0jpeg";
const JSON_PATH: &str = "your_instagram_activity/media/posts_1.json";
const IMG_PATH: &str = "media/posts/a.jpg";

fn skipped(out: &ExtractOutcome) -> Option<EntrySkipCode> {
    match out {
        ExtractOutcome::Skipped { skip } => Some(*skip),
        ExtractOutcome::Extracted { .. } => None,
    }
}

// ---------------------------------------------------------------- group 1

/// A deflate bomb must be refused from the central directory alone, before a
/// single byte is inflated: the declared ratio is the cheap signal.
#[test]
fn deflate_bomb_declared_ratio_is_refused_up_front() {
    let payload = vec![0u8; 8 * MIB as usize];
    let compressed = deflate(&payload);
    assert!(compressed.len() * 100 < payload.len(), "need a real bomb");

    let mut e = EntrySpec::deflated(IMG_PATH, &payload);
    e.raw_data = Some(compressed.clone());
    let zip = ZipBuilder::new().with(e).build();

    let h = open("bomb-ratio", vec![zip]);
    assert_eq!(
        h.skip_of(IMG_PATH),
        Some(EntrySkipCode::EntryRatioExceeded),
        "a 100:1+ declared ratio must be rejected at listing time"
    );
    let out = h.extract(IMG_PATH, EntryKind::Image).expect("no throw");
    assert_eq!(skipped(&out), Some(EntrySkipCode::EntryRatioExceeded));
    assert_eq!(
        h.staging_residue(),
        vec![format!("{UUID_A}-archive-staging.bin")]
    );
    assert!(
        support::read_file(&h.dir.staging(UUID_A)).is_empty(),
        "nothing may be written for a refused entry"
    );
}

/// A bomb that hides behind a small declared size: the ratio is only visible
/// once bytes come out, so the check has to live inside the copy loop.
#[test]
fn deflate_bomb_lying_about_its_size_is_stopped_mid_loop() {
    let payload = vec![0u8; 8 * MIB as usize];
    let compressed = deflate(&payload);
    let mut e = EntrySpec::deflated(IMG_PATH, &payload);
    e.raw_data = Some(compressed);
    // Declare 2 MiB so the up-front ratio check passes (2 MiB / ~8 KiB is
    // still > 100, so declare a plausible compressed size too).
    e.cd_uncomp = Some(2 * MIB);
    e.cd_comp = Some(2 * MIB / 50);
    let zip = ZipBuilder::new().with(e).build();

    let h = open("bomb-lie", vec![zip]);
    let out = h.extract(IMG_PATH, EntryKind::Image).expect("no throw");
    assert!(
        matches!(
            skipped(&out),
            Some(EntrySkipCode::EntryRatioExceeded | EntrySkipCode::EntryCorrupt)
        ),
        "a declared-size lie must be caught in the loop, got {out:?}"
    );
}

/// An entry whose compressed data region runs over the next entry's local
/// header is the overlapping-entry bomb. `data_end <= next_local_header` is
/// the only thing that stops one stream being claimed by many records.
#[test]
fn overlapping_entry_bomb_is_corrupt() {
    let mut first = EntrySpec::stored(IMG_PATH, JPG);
    // Claim far more compressed data than was written, so the region swallows
    // the following local header.
    first.cd_comp = Some(10_000);
    first.cd_uncomp = Some(10_000);
    let zip = ZipBuilder::new()
        .with(first)
        .stored("media/posts/b.jpg", &vec![7u8; 4096])
        .build();

    let h = open("overlap", vec![zip]);
    let out = h.extract(IMG_PATH, EntryKind::Image).expect("no throw");
    assert_eq!(skipped(&out), Some(EntrySkipCode::EntryCorrupt));
    // The honest neighbour still works.
    assert!(matches!(
        h.extract("media/posts/b.jpg", EntryKind::Image),
        Ok(ExtractOutcome::Extracted { .. })
    ));
}

// ---------------------------------------------------------------- group 2

/// Path attacks are rejected at listing. None of these names may ever appear
/// in `entries`, and each must be counted under a path code.
#[test]
fn path_attacks_never_reach_the_listing() {
    let cases: [(&[u8], EntrySkipCode); 9] = [
        (b"../media/posts/a.jpg", EntrySkipCode::EntryPathTraversal),
        (
            b"media/posts/../../../a.jpg",
            EntrySkipCode::EntryPathTraversal,
        ),
        (b"./media/posts/a.jpg", EntrySkipCode::EntryPathTraversal),
        (b"/media/posts/a.jpg", EntrySkipCode::EntryPathInvalid),
        (b"media\\posts\\a.jpg", EntrySkipCode::EntryPathInvalid),
        (b"C:/media/posts/a.jpg", EntrySkipCode::EntryPathInvalid),
        (b"media/posts/a\x00.jpg", EntrySkipCode::EntryPathInvalid),
        (b"media/posts/a\x1b[2J.jpg", EntrySkipCode::EntryPathInvalid),
        (b"media//posts/a.jpg", EntrySkipCode::EntryPathInvalid),
    ];
    for (name, expected) in cases {
        let mut e = EntrySpec::stored("placeholder", JPG);
        e.name = name.to_vec();
        let zip = ZipBuilder::new().with(e).build();
        let h = open("paths", vec![zip]);
        assert!(
            h.session.entries().is_empty(),
            "{} must not be listed",
            String::from_utf8_lossy(name)
        );
        assert_eq!(
            h.rejected(expected),
            1,
            "{} should count as {expected:?}",
            String::from_utf8_lossy(name)
        );
    }
}

/// An overlong name and a too-deep name are path-invalid, not truncated.
#[test]
fn overlong_and_too_deep_names_are_invalid() {
    for name in [
        format!("media/posts/{}.jpg", "a".repeat(1100)),
        format!("media/posts/{}a.jpg", "d/".repeat(20)),
    ] {
        let mut e = EntrySpec::stored("placeholder", JPG);
        e.name = name.clone().into_bytes();
        let h = open("long", vec![ZipBuilder::new().with(e).build()]);
        assert!(h.session.entries().is_empty(), "{name} must not be listed");
        assert_eq!(h.rejected(EntrySkipCode::EntryPathInvalid), 1);
    }
}

/// A name that is not valid UTF-8 cannot be matched against the allowlist, so
/// it is rejected rather than lossily decoded.
#[test]
fn non_utf8_names_are_invalid() {
    let mut e = EntrySpec::stored("placeholder", JPG);
    e.name = b"media/posts/\xC3\x28.jpg".to_vec();
    let h = open("badutf8", vec![ZipBuilder::new().with(e).build()]);
    assert!(h.session.entries().is_empty());
    assert_eq!(h.rejected(EntrySkipCode::EntryPathInvalid), 1);
}

// ---------------------------------------------------------------- group 3

/// Symlinks, FIFOs and directories under an allowlisted media prefix are
/// listed but never opened.
#[test]
fn forbidden_entry_types_are_skipped() {
    let zip = ZipBuilder::new()
        .with(
            EntrySpec::stored("media/posts/link.jpg", b"../../etc/passwd").with_mode(MODE_SYMLINK),
        )
        .with(EntrySpec::stored("media/posts/fifo.jpg", b"").with_mode(MODE_FIFO))
        .with(EntrySpec::stored("media/posts/dirish.jpg", b"").with_mode(MODE_DIR))
        .build();
    let h = open("types", vec![zip]);
    assert_eq!(
        h.skip_of("media/posts/link.jpg"),
        Some(EntrySkipCode::EntrySymlink)
    );
    assert_eq!(
        h.skip_of("media/posts/fifo.jpg"),
        Some(EntrySkipCode::EntrySpecialFile)
    );
    assert_eq!(
        h.skip_of("media/posts/dirish.jpg"),
        Some(EntrySkipCode::EntrySpecialFile)
    );
    for p in ["media/posts/link.jpg", "media/posts/fifo.jpg"] {
        let out = h.extract(p, EntryKind::Image).expect("no throw");
        assert!(skipped(&out).is_some(), "{p} must not be extracted");
    }
}

/// Every encryption signal is refused: bit 0, bit 6 and method 99 (AE-x).
#[test]
fn encrypted_entries_are_skipped() {
    let cases = [
        (
            "media/posts/e1.jpg",
            EntrySpec::stored("media/posts/e1.jpg", JPG).with_flags(FLAG_UTF8 | FLAG_ENCRYPTED),
        ),
        (
            "media/posts/e2.jpg",
            EntrySpec::stored("media/posts/e2.jpg", JPG)
                .with_flags(FLAG_UTF8 | FLAG_STRONG_ENCRYPTION),
        ),
        (
            "media/posts/e3.jpg",
            EntrySpec::stored("media/posts/e3.jpg", JPG).with_method(99),
        ),
    ];
    for (path, spec) in cases {
        let h = open("enc", vec![ZipBuilder::new().with(spec).build()]);
        assert_eq!(
            h.skip_of(path),
            Some(EntrySkipCode::EntryEncrypted),
            "{path}"
        );
    }
}

/// A nested archive is caught twice: by extension at listing, and by magic
/// bytes inside the copy loop for an archive wearing a .jpg name.
#[test]
fn nested_archives_are_caught_by_extension_and_by_magic() {
    let inner = instagram_like().build();
    let by_ext = ZipBuilder::new()
        .stored("media/posts/inner.zip", &inner)
        .build();
    let h = open("nested-ext", vec![by_ext]);
    assert!(h.session.entries().is_empty());
    assert_eq!(h.rejected(EntrySkipCode::EntryNestedArchive), 1);

    let by_magic = ZipBuilder::new()
        .stored("media/posts/inner.jpg", &inner)
        .build();
    let h2 = open("nested-magic", vec![by_magic]);
    let out = h2
        .extract("media/posts/inner.jpg", EntryKind::Image)
        .expect("no throw");
    assert_eq!(skipped(&out), Some(EntrySkipCode::EntryNestedArchive));
    assert!(
        support::read_file(&h2.dir.staging(UUID_A)).is_empty(),
        "a nested archive must leave no extracted bytes"
    );
}

/// Only STORED and DEFLATE are supported; anything else is skipped rather
/// than guessed at.
#[test]
fn unsupported_methods_are_skipped() {
    for method in [1u16, 9, 12, 14, 93, 95, 98] {
        let spec = EntrySpec::stored(IMG_PATH, JPG).with_method(method);
        let h = open("method", vec![ZipBuilder::new().with(spec).build()]);
        assert_eq!(
            h.skip_of(IMG_PATH),
            Some(EntrySkipCode::EntryUnsupportedMethod),
            "method {method}"
        );
    }
}

// ---------------------------------------------------------------- group 4

/// The JSON cap is 12 MiB, declared and actual.
#[test]
fn json_over_the_cap_is_skipped() {
    let mut declared = EntrySpec::stored(JSON_PATH, b"{}");
    declared.cd_uncomp = Some(13 * MIB);
    declared.cd_comp = Some(13 * MIB);
    let h = open("json-cap", vec![ZipBuilder::new().with(declared).build()]);
    assert_eq!(h.skip_of(JSON_PATH), Some(EntrySkipCode::EntryOverCap));

    // Actual over the cap with an honest declaration is also refused.
    let body = vec![b' '; (12 * MIB + 1) as usize];
    let h2 = open(
        "json-cap2",
        vec![ZipBuilder::new().stored(JSON_PATH, &body).build()],
    );
    assert_eq!(h2.skip_of(JSON_PATH), Some(EntrySkipCode::EntryOverCap));
    assert!(matches!(
        h2.read_json(JSON_PATH),
        Ok(JsonOutcome::Skipped {
            skip: EntrySkipCode::EntryOverCap
        })
    ));
}

/// The image cap is 50 MiB.
#[test]
fn image_over_the_cap_is_skipped() {
    let mut e = EntrySpec::stored(IMG_PATH, JPG);
    e.cd_uncomp = Some(51 * MIB);
    e.cd_comp = Some(51 * MIB);
    let h = open("img-cap", vec![ZipBuilder::new().with(e).build()]);
    assert_eq!(h.skip_of(IMG_PATH), Some(EntrySkipCode::EntryOverCap));
}

/// A video is listed with its declared size and is never opened: there is no
/// `KIND_CAPS` row for it, so no code path can inflate it.
#[test]
fn video_is_listed_and_never_opened() {
    let zip = ZipBuilder::new()
        .stored("media/posts/clip.mp4", b"\x00\x00\x00\x20ftypmp42rest")
        .build();
    let h = open("video", vec![zip]);
    let entries = h.session.entries();
    let e = entries.first().expect("one entry");
    assert_eq!(e.kind, EntryKind::Video);
    assert_eq!(e.skip, None, "a held video is not a rejection");
    assert_eq!(e.declared_size, 16);

    let before = h.sources[0].bytes_read();
    for kind in [EntryKind::Image, EntryKind::Video, EntryKind::Json] {
        let out = h.extract("media/posts/clip.mp4", kind).expect("no throw");
        assert!(
            matches!(
                skipped(&out),
                Some(EntrySkipCode::EntryKindNotEnabled | EntrySkipCode::EntryKindMismatch)
            ),
            "video must never extract, got {out:?}"
        );
    }
    assert!(matches!(
        h.peek("media/posts/clip.mp4"),
        Ok(orbital_archive_reader::PeekOutcome::Skipped {
            skip: EntrySkipCode::EntryKindNotEnabled
        })
    ));
    assert_eq!(
        h.sources[0].bytes_read(),
        before,
        "no byte of a video entry may be read"
    );
}

/// Container-format attacks: multi-disk, prepended data, truncated central
/// directory, missing EOCD, and a lying ZIP64 locator.
#[test]
fn container_format_attacks_are_typed_errors() {
    let mut multi_disk = instagram_like();
    multi_disk.disk_number = 1;
    assert_eq!(
        try_open("disk", vec![multi_disk.build()]).err(),
        Some(ArchiveError::Unsupported)
    );

    let mut prepended = instagram_like();
    prepended.prepend = vec![0x4d, 0x5a, 0x90, 0x00];
    assert_eq!(
        try_open("prepend", vec![prepended.build()]).err(),
        Some(ArchiveError::Corrupt)
    );

    let mut truncated = instagram_like();
    truncated.truncate_cd_bytes = 20;
    assert_eq!(
        try_open("trunc-cd", vec![truncated.build()]).err(),
        Some(ArchiveError::Corrupt)
    );

    let mut no_eocd = instagram_like();
    no_eocd.omit_eocd = true;
    assert_eq!(
        try_open("no-eocd", vec![no_eocd.build()]).err(),
        Some(ArchiveError::NotZip)
    );

    assert_eq!(
        try_open("not-a-zip", vec![vec![0u8; 4096]]).err(),
        Some(ArchiveError::NotZip)
    );

    // Trailing bytes after the EOCD: the comment length no longer ends at EOF,
    // so no candidate wins. This is the "two central directories" shape.
    let mut appended = instagram_like();
    appended.append = vec![0xAA; 32];
    assert_eq!(
        try_open("append", vec![appended.build()]).err(),
        Some(ArchiveError::NotZip)
    );

    let mut lying_locator = instagram_like();
    lying_locator.zip64 = true;
    lying_locator.eocd64_locator_offset = Some(0);
    assert_eq!(
        try_open("z64-lie", vec![lying_locator.build()]).err(),
        Some(ArchiveError::Corrupt)
    );

    let mut too_many_disks = instagram_like();
    too_many_disks.zip64 = true;
    too_many_disks.eocd64_total_disks = Some(4);
    assert_eq!(
        try_open("z64-disks", vec![too_many_disks.build()]).err(),
        Some(ArchiveError::Unsupported)
    );
}

/// A well-formed ZIP64 archive with 64-bit records opens and extracts.
#[test]
fn zip64_archives_are_supported() {
    let mut json = EntrySpec::stored(JSON_PATH, b"{\"media\":[]}");
    json.zip64_record = true;
    let mut img = EntrySpec::stored(IMG_PATH, JPG);
    img.zip64_record = true;
    let mut b = ZipBuilder::new().with(json).with(img);
    b.zip64 = true;
    let h = open("zip64", vec![b.build()]);
    assert_eq!(h.paths().len(), 2);
    assert!(matches!(
        h.extract(IMG_PATH, EntryKind::Image),
        Ok(ExtractOutcome::Extracted { .. })
    ));
}

/// A declared entry count above the per-part bound is refused from the EOCD
/// alone, before a single record is parsed.
#[test]
fn declared_entry_count_is_checked_first() {
    let mut b = instagram_like();
    b.zip64 = true;
    b.eocd64_entries = Some(1_000_001);
    assert_eq!(
        try_open("declared", vec![b.build()]).err(),
        Some(ArchiveError::TooManyEntries)
    );
}

/// A declared count that disagrees with the records present is corruption:
/// tolerating it is how a hidden-record attack gets in.
#[test]
fn declared_count_must_match_the_records() {
    let mut b = instagram_like();
    b.eocd_entries = Some(2);
    assert_eq!(
        try_open("count-lie", vec![b.build()]).err(),
        Some(ArchiveError::Corrupt)
    );
}

// ---------------------------------------------------------------- group 5

/// Local/central disagreement on name, method or sizes is per-entry
/// corruption. The central directory always wins.
#[test]
fn local_header_mismatches_are_corrupt() {
    let mut bad_name = EntrySpec::stored(IMG_PATH, JPG);
    bad_name.lh_name = Some(b"media/posts/other.jpg".to_vec());
    let h = open("lh-name", vec![ZipBuilder::new().with(bad_name).build()]);
    assert_eq!(
        skipped(&h.extract(IMG_PATH, EntryKind::Image).expect("no throw")),
        Some(EntrySkipCode::EntryCorrupt)
    );

    let mut bad_method = EntrySpec::stored(IMG_PATH, JPG);
    bad_method.lh_method = Some(8);
    let h2 = open(
        "lh-method",
        vec![ZipBuilder::new().with(bad_method).build()],
    );
    assert_eq!(
        skipped(&h2.extract(IMG_PATH, EntryKind::Image).expect("no throw")),
        Some(EntrySkipCode::EntryCorrupt)
    );

    let mut bad_size = EntrySpec::stored(IMG_PATH, JPG);
    bad_size.lh_uncomp = Some(999);
    let h3 = open("lh-size", vec![ZipBuilder::new().with(bad_size).build()]);
    assert_eq!(
        skipped(&h3.extract(IMG_PATH, EntryKind::Image).expect("no throw")),
        Some(EntrySkipCode::EntryCorrupt)
    );

    let mut bad_sig = EntrySpec::stored(IMG_PATH, JPG);
    bad_sig.lh_sig = Some(0x1234_5678);
    let h4 = open("lh-sig", vec![ZipBuilder::new().with(bad_sig).build()]);
    assert_eq!(
        skipped(&h4.extract(IMG_PATH, EntryKind::Image).expect("no throw")),
        Some(EntrySkipCode::EntryCorrupt)
    );
}

/// With bit 3 set the local sizes are zero by design; the central directory
/// stays authoritative and the entry extracts normally.
#[test]
fn data_descriptor_entries_use_the_central_directory() {
    let mut e = EntrySpec::stored(IMG_PATH, JPG);
    e.flags = FLAG_UTF8 | FLAG_DATA_DESCRIPTOR;
    e.lh_crc = Some(0);
    e.lh_comp = Some(0);
    e.lh_uncomp = Some(0);
    e.append_data_descriptor = true;
    let h = open("dd", vec![ZipBuilder::new().with(e).build()]);
    match h.extract(IMG_PATH, EntryKind::Image).expect("no throw") {
        ExtractOutcome::Extracted { byte_length, .. } => {
            assert_eq!(byte_length, JPG.len() as u64);
        }
        other => panic!("expected extraction, got {other:?}"),
    }
}

/// A CRC mismatch means the bytes are not what the archive claims.
#[test]
fn crc_mismatch_is_corrupt_and_leaves_no_file() {
    let mut e = EntrySpec::stored(IMG_PATH, JPG);
    e.cd_crc = Some(crc32(JPG) ^ 0xFFFF);
    let h = open("crc", vec![ZipBuilder::new().with(e).build()]);
    assert_eq!(
        skipped(&h.extract(IMG_PATH, EntryKind::Image).expect("no throw")),
        Some(EntrySkipCode::EntryCorrupt)
    );
    assert!(support::read_file(&h.dir.staging(UUID_A)).is_empty());
}

/// Duplicate names, within one part and across parts.
#[test]
fn duplicate_names_are_marked() {
    // Identical copies: the first wins, the second is marked duplicate.
    let same = ZipBuilder::new()
        .stored(IMG_PATH, JPG)
        .stored(IMG_PATH, JPG)
        .build();
    let h = open("dup-same", vec![same]);
    let e = h.session.entries();
    assert_eq!(e.len(), 2);
    assert_eq!(e[0].skip, None);
    assert_eq!(e[1].skip, Some(EntrySkipCode::EntryDuplicate));

    // Differing copies: both are unusable, because nothing says which one the
    // JSON means.
    let differing = ZipBuilder::new()
        .stored(IMG_PATH, JPG)
        .stored(IMG_PATH, b"\xFF\xD8\xFF\xE0different")
        .build();
    let h2 = open("dup-diff", vec![differing]);
    let e2 = h2.session.entries();
    assert_eq!(e2[0].skip, Some(EntrySkipCode::EntryDuplicate));
    assert_eq!(e2[1].skip, Some(EntrySkipCode::EntryDuplicate));

    // Across parts, the same rule applies.
    let p1 = ZipBuilder::new().stored(IMG_PATH, JPG).build();
    let p2 = ZipBuilder::new()
        .stored(IMG_PATH, b"\xFF\xD8\xFF\xE0other")
        .build();
    let h3 = open("dup-parts", vec![p1, p2]);
    assert!(
        h3.session
            .entries()
            .iter()
            .all(|e| e.skip == Some(EntrySkipCode::EntryDuplicate))
    );
}

// ---------------------------------------------------------------- group 6

/// More parts than `MAX_PARTS`.
#[test]
fn too_many_parts_is_refused() {
    let parts: Vec<Vec<u8>> = (0..65)
        .map(|i| {
            ZipBuilder::new()
                .stored(&format!("media/posts/{i}.jpg"), JPG)
                .build()
        })
        .collect();
    assert_eq!(
        try_open("parts", parts).err(),
        Some(ArchiveError::TooManyParts)
    );
}

/// The same file offered twice is a duplicate part, by fileId first.
#[test]
fn duplicate_parts_are_refused() {
    use orbital_archive_reader::testing::{CancelFlag, PartSourceInput};
    let zip = instagram_like().build();
    let dir = support::TempDir::new("dup-part");
    let a = support::MemSource::new(zip.clone());
    let b = support::MemSource::new(zip);
    let same_id = vec![
        PartSourceInput {
            src: Box::new(support::SharedSource(std::sync::Arc::clone(&a))),
            file_id: "1:1".to_owned(),
            expected_fp: None,
        },
        PartSourceInput {
            src: Box::new(support::SharedSource(std::sync::Arc::clone(&b))),
            file_id: "1:1".to_owned(),
            expected_fp: None,
        },
    ];
    let flag = CancelFlag::new();
    assert_eq!(
        orbital_archive_reader::ArchiveSession::open_with_sources(same_id, dir.as_str(), &flag)
            .err(),
        Some(ArchiveError::DuplicatePart)
    );

    // Different fileIds but the same content: the fingerprint catches it.
    let c = support::MemSource::new(instagram_like().build());
    let d = support::MemSource::new(instagram_like().build());
    let same_fp = vec![
        PartSourceInput {
            src: Box::new(support::SharedSource(std::sync::Arc::clone(&c))),
            file_id: "1:1".to_owned(),
            expected_fp: None,
        },
        PartSourceInput {
            src: Box::new(support::SharedSource(std::sync::Arc::clone(&d))),
            file_id: "1:2".to_owned(),
            expected_fp: None,
        },
    ];
    assert_eq!(
        orbital_archive_reader::ArchiveSession::open_with_sources(same_fp, dir.as_str(), &flag)
            .err(),
        Some(ArchiveError::DuplicatePart)
    );
}

/// The session byte budget is archive-wide and throws, because a run that hits
/// it is not recoverable by skipping one entry.
#[test]
fn session_byte_budget_throws() {
    let body = vec![1u8; 4096];
    let zip = ZipBuilder::new()
        .stored("media/posts/a.jpg", &body)
        .stored("media/posts/b.jpg", &body)
        .build();
    let h = support::try_open_with_budgets(
        "budget",
        vec![zip],
        Budgets {
            session_bytes: 5000,
            ..support::unbounded()
        },
    )
    .expect("opens");
    assert!(matches!(
        h.extract_into("media/posts/a.jpg", EntryKind::Image, UUID_A),
        Ok(ExtractOutcome::Extracted { .. })
    ));
    assert_eq!(
        h.extract_into("media/posts/b.jpg", EntryKind::Image, UUID_B)
            .err(),
        Some(ArchiveError::SessionBytesExceeded)
    );
}

/// Bytes written before a CRC skip are charged too. Otherwise a handful of
/// deliberately-corrupt entries can drive unbounded write-then-unlink churn
/// while the session budget never moves.
#[test]
fn bytes_written_before_a_skip_are_charged_to_the_session_budget() {
    let body = vec![9u8; 4096];
    let mut a = EntrySpec::stored("media/posts/a.jpg", &body);
    a.cd_crc = Some(crc32(&body) ^ 0xDEAD);
    let mut b = EntrySpec::stored("media/posts/b.jpg", &body);
    b.cd_crc = Some(crc32(&body) ^ 0xBEEF);
    let zip = ZipBuilder::new().with(a).with(b).build();

    let h = support::try_open_with_budgets(
        "charge-skips",
        vec![zip],
        Budgets {
            session_bytes: 5000,
            ..support::unbounded()
        },
    )
    .expect("opens");

    // The first corrupt entry writes 4096 bytes, then fails its CRC.
    assert_eq!(
        skipped(
            &h.extract_into("media/posts/a.jpg", EntryKind::Image, UUID_A)
                .expect("no throw")
        ),
        Some(EntrySkipCode::EntryCorrupt)
    );
    assert_eq!(h.session.session_bytes_written(), 4096);
    // Its reservation was released, so the ceiling is clear...
    assert_eq!(h.session.live_staging_bytes(), 0);
    // ...but the budget is not, and the second attempt runs out of it.
    assert_eq!(
        h.extract_into("media/posts/b.jpg", EntryKind::Image, UUID_B)
            .err(),
        Some(ArchiveError::SessionBytesExceeded)
    );
}

/// The live-staging ceiling throws `NoSpace`, and releasing makes room again.
#[test]
fn live_staging_ceiling_is_enforced_and_releasable() {
    let body = vec![1u8; 4096];
    let zip = ZipBuilder::new()
        .stored("media/posts/a.jpg", &body)
        .stored("media/posts/b.jpg", &body)
        .build();
    let h = support::try_open_with_budgets(
        "live",
        vec![zip],
        Budgets {
            live_staging: 5000,
            ..support::unbounded()
        },
    )
    .expect("opens");
    assert!(matches!(
        h.extract_into("media/posts/a.jpg", EntryKind::Image, UUID_A),
        Ok(ExtractOutcome::Extracted { .. })
    ));
    assert_eq!(h.session.live_staging_bytes(), 4096);
    assert_eq!(
        h.extract_into("media/posts/b.jpg", EntryKind::Image, UUID_B)
            .err(),
        Some(ArchiveError::NoSpace)
    );

    // Releasing is by path and is exact: the ledger, not the caller, says how
    // many bytes come back.
    h.session.release_staging(h.dir.staging_path(UUID_A));
    assert_eq!(h.session.live_staging_bytes(), 0);
    assert!(matches!(
        h.extract_into("media/posts/b.jpg", EntryKind::Image, UUID_B),
        Ok(ExtractOutcome::Extracted { .. })
    ));

    // Idempotent, and a path this session never extracted is a no-op. A
    // doubled or bogus release must not create headroom.
    h.session.release_staging(h.dir.staging_path(UUID_B));
    h.session.release_staging(h.dir.staging_path(UUID_B));
    h.session.release_staging(h.dir.staging_path(UUID_C));
    h.session
        .release_staging("/not/even/in/this/session.bin".to_owned());
    assert_eq!(h.session.live_staging_bytes(), 0);
}

/// The ledger is keyed on the FILE, not on the caller's string. Three spellings
/// of one path — plain, with a `.` component, and with the UUID case-flipped
/// (iOS `NSUUID.UUIDString` is uppercase) — all name the same file, so they must
/// all be the same ledger entry. Keyed on the raw string, a mismatched release
/// would be a silent no-op leaking a kind cap of headroom per call.
#[test]
fn the_staging_ledger_is_keyed_on_the_file_not_the_string() {
    let body = vec![2u8; 1024];
    let zip = ZipBuilder::new()
        .stored("media/posts/a.jpg", &body)
        .stored("media/posts/b.jpg", &body)
        .build();
    let h = open("ledger-alias", vec![zip]);
    let lower = "0b5f1f3c-6a4e-4d2b-9f1a-123456789abc";

    assert!(matches!(
        h.extract_into("media/posts/a.jpg", EntryKind::Image, lower),
        Ok(ExtractOutcome::Extracted { .. })
    ));
    assert_eq!(h.session.live_staging_bytes(), 1024);

    // A `.`-component alias of the outstanding file is refused, not reserved a
    // second time.
    let dotted = format!("{}/./{lower}-archive-staging.bin", h.dir.as_str());
    assert_eq!(
        h.session
            .extract_blocking(
                &h.id_of("media/posts/b.jpg"),
                EntryKind::Image,
                &dotted,
                &h.cancel
            )
            .err(),
        Some(ArchiveError::StagingInUse)
    );

    // Releasing with the UUID upper-cased still returns exactly those bytes.
    let upper = format!(
        "{}/{}-archive-staging.bin",
        h.dir.as_str(),
        lower.to_uppercase()
    );
    h.session.release_staging(upper);
    assert_eq!(h.session.live_staging_bytes(), 0);

    // And a path that could never have been a staging file is a no-op, not a
    // panic and not a credit.
    h.session.release_staging("/tmp/payload.bin".to_owned());
    assert_eq!(h.session.live_staging_bytes(), 0);
}

/// Re-using a staging path that is still outstanding is refused: two jobs
/// writing one file would race on both the file and the ledger.
#[test]
fn an_outstanding_staging_path_cannot_be_reused() {
    let body = vec![1u8; 512];
    let zip = ZipBuilder::new()
        .stored("media/posts/a.jpg", &body)
        .stored("media/posts/b.jpg", &body)
        .build();
    let h = open("staging-reuse", vec![zip]);
    assert!(matches!(
        h.extract_into("media/posts/a.jpg", EntryKind::Image, UUID_A),
        Ok(ExtractOutcome::Extracted { .. })
    ));
    assert_eq!(
        h.extract_into("media/posts/b.jpg", EntryKind::Image, UUID_A)
            .err(),
        Some(ArchiveError::StagingInUse),
        "a reused staging path is a caller bug, not the transient job-slot Busy"
    );
    h.session.release_staging(h.dir.staging_path(UUID_A));
    assert!(matches!(
        h.extract_into("media/posts/b.jpg", EntryKind::Image, UUID_A),
        Ok(ExtractOutcome::Extracted { .. })
    ));
}
