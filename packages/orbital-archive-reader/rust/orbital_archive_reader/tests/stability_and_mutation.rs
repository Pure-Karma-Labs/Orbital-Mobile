//! Hostile matrix group 11 (mutation sweep), fold F6 (entry-id stability) and
//! fold F7 (URI-resolution bench), plus the three synthetic interop fixtures.

mod support;

use std::time::Instant;

use orbital_archive_reader::testing::{
    Budgets, CancelFlag, MAX_LISTED_ENTRIES_PER_SESSION, Source,
};
use orbital_archive_reader::{
    ArchiveError, EntryKind, ExtractOutcome, JsonOutcome, PeekOutcome, UriResolution,
};
use support::zipgen::{EntrySpec, ZipBuilder, instagram_like};
use support::{UUID_A, open, try_open};

const JPG: &[u8] = b"\xFF\xD8\xFF\xE0jpeg";

// ------------------------------------------------------------------- F6

/// An archive with denied and allowlisted records interleaved. The entry id's
/// ordinal is the RAW central-directory ordinal, so widening the allowlist
/// later cannot renumber ids that #925 has already persisted.
fn interleaved() -> Vec<u8> {
    ZipBuilder::new()
        .stored("messages/inbox/a/photos/0.jpg", JPG) // ordinal 0, denied
        .stored("media/posts/one.jpg", JPG) // ordinal 1, listed
        .stored("stories/2.jpg", JPG) // ordinal 2, denied
        .stored("media/posts/two.jpg", JPG) // ordinal 3, listed
        .stored("ads_information/4.json", b"{}") // ordinal 4, denied
        .stored("your_instagram_activity/media/posts_1.json", b"{}") // ordinal 5
        .build()
}

#[test]
fn entry_ids_use_the_raw_central_directory_ordinal() {
    let h = open("f6-ordinal", vec![interleaved()]);
    let ids: Vec<String> = h
        .session
        .entries()
        .into_iter()
        .map(|e| e.entry_id)
        .collect();
    let ordinals: Vec<&str> = ids
        .iter()
        .map(|id| id.split(':').nth(1).expect("ordinal"))
        .collect();
    assert_eq!(
        ordinals,
        vec!["1", "3", "5"],
        "ids must be raw CD ordinals, not listing positions"
    );
    // The prefix is the part's FULL fingerprint — CD CRC-32, central-directory
    // offset, central-directory size and file length — not just the CRC-32. An
    // 8-hex-digit prefix let two near-duplicate parts (one extra comment byte,
    // or padding before the central directory) mint identical ids while passing
    // both duplicate-part guards, and the colliding id then resolved to
    // whichever twin dedup had marked skipped.
    let fps: Vec<String> = h.session.parts().into_iter().map(|p| p.fp).collect();
    for id in &ids {
        let prefix = id.split(':').next().expect("fp prefix");
        assert_eq!(prefix, fps[0], "{id}");
        assert_eq!(prefix.split('-').count(), 4, "{id}");
    }
    // No colon can appear inside a fingerprint, so (fp, ordinal) maps to the id
    // string injectively.
    assert!(!fps[0].contains(':'));
}

/// Two parts that differ only in geometry the old 8-hex-digit prefix ignored.
/// Both shapes passed the `file_id` and full-fingerprint duplicate-part guards,
/// so they used to land in the session with identical entry ids.
#[test]
fn near_duplicate_parts_get_distinct_entry_ids() {
    let base = ZipBuilder::new().stored("media/posts/a.jpg", JPG);

    // (a) one extra EOCD comment byte: same central directory, file one byte
    //     longer.
    let mut commented = base.clone();
    commented.comment = vec![0x20];
    // (b) 16 bytes of padding before the central directory: same central
    //     directory bytes, different cd_offset and file length.
    let mut padded = base.clone();
    padded.pad_before_cd = vec![0u8; 16];

    for (label, twin) in [("comment", commented), ("padding", padded)] {
        let h = open(
            &format!("near-dup-{label}"),
            vec![base.build(), twin.build()],
        );
        let ids = h.ids();
        assert_eq!(ids.len(), 2, "{label}");
        assert_ne!(ids[0], ids[1], "{label}: ids collided");

        // The surviving entry is reachable through its own id, and the
        // duplicate is the one marked skipped — not the other way round.
        let entries = h.session.entries();
        assert_eq!(entries[0].skip, None, "{label}");
        assert_eq!(
            entries[1].skip,
            Some(orbital_archive_reader::EntrySkipCode::EntryDuplicate),
            "{label}"
        );
        match h.extract("media/posts/a.jpg", EntryKind::Image) {
            Ok(ExtractOutcome::Extracted { byte_length, .. }) => {
                assert_eq!(byte_length, JPG.len() as u64, "{label}");
            }
            other => panic!("{label}: expected the original to extract, got {other:?}"),
        }
    }
}

/// Byte-identical parts are still refused outright: the fingerprints match, so
/// the duplicate-part guard fires before ids are ever minted.
#[test]
fn byte_identical_parts_are_refused() {
    let zip = ZipBuilder::new().stored("media/posts/a.jpg", JPG).build();
    assert_eq!(
        try_open("ident-parts", vec![zip.clone(), zip]).err(),
        Some(orbital_archive_reader::ArchiveError::DuplicatePart)
    );
}

/// Re-opening the same bytes yields identical ids. This is what makes resume
/// work: #926 stores ids across a cold start.
#[test]
fn entry_ids_are_stable_across_re_open() {
    let zip = interleaved();
    let a = open("f6-a", vec![zip.clone()]);
    let b = open("f6-b", vec![zip]);
    assert_eq!(
        a.session
            .entries()
            .into_iter()
            .map(|e| e.entry_id)
            .collect::<Vec<_>>(),
        b.session
            .entries()
            .into_iter()
            .map(|e| e.entry_id)
            .collect::<Vec<_>>()
    );
}

/// Part order is a property of the pick, not of the archive, so reversing it
/// must not change a single id.
#[test]
fn entry_ids_are_stable_under_reversed_part_order() {
    let p1 = ZipBuilder::new().stored("media/posts/p1.jpg", JPG).build();
    let p2 = ZipBuilder::new().stored("media/posts/p2.jpg", JPG).build();

    let forward = open("f6-fwd", vec![p1.clone(), p2.clone()]);
    let reversed = open("f6-rev", vec![p2, p1]);

    let mut a: Vec<(String, String)> = forward
        .session
        .entries()
        .into_iter()
        .map(|e| (e.path, e.entry_id))
        .collect();
    let mut b: Vec<(String, String)> = reversed
        .session
        .entries()
        .into_iter()
        .map(|e| (e.path, e.entry_id))
        .collect();
    a.sort();
    b.sort();
    assert_eq!(a, b, "part order must not affect entry ids");
    // And the fingerprints themselves differ per part, so ids cannot collide.
    let fps: Vec<String> = forward.session.parts().into_iter().map(|p| p.fp).collect();
    assert_ne!(fps[0], fps[1]);
}

/// A part fingerprint changes when the archive content changes, and not
/// otherwise. It is a change detector, not an authenticator (plan Q5).
#[test]
fn the_part_fingerprint_tracks_content_only() {
    let base = open("fp-base", vec![instagram_like().build()]);
    let same = open("fp-same", vec![instagram_like().build()]);
    let more = open(
        "fp-more",
        vec![instagram_like().stored("media/posts/c.jpg", JPG).build()],
    );
    let base_fp = base.session.parts()[0].fp.clone();
    assert_eq!(base_fp, same.session.parts()[0].fp);
    assert_ne!(base_fp, more.session.parts()[0].fp);
}

/// A u64 size above `Number.MAX_SAFE_INTEGER` saturates and marks that ONE
/// entry corrupt. It never fails the archive (F6).
#[test]
fn an_oversized_declared_size_corrupts_only_that_entry() {
    let mut huge = EntrySpec::stored("media/posts/huge.jpg", JPG);
    huge.zip64_record = true;
    huge.cd_uncomp = Some(u64::MAX - 1);
    huge.cd_comp = Some(16);
    let mut b = ZipBuilder::new()
        .with(huge)
        .stored("media/posts/fine.jpg", JPG);
    b.zip64 = true;
    let h = open("saturate", vec![b.build()]);

    assert_eq!(
        h.skip_of("media/posts/huge.jpg"),
        Some(orbital_archive_reader::EntrySkipCode::EntryCorrupt)
    );
    assert!(
        h.session
            .entries()
            .iter()
            .find(|e| e.path == "media/posts/huge.jpg")
            .expect("entry")
            .declared_size
            <= 9_007_199_254_740_991,
        "the declared size must be clamped to MAX_SAFE_INTEGER"
    );
    assert_eq!(h.skip_of("media/posts/fine.jpg"), None);
    assert!(matches!(
        h.extract("media/posts/fine.jpg", EntryKind::Image),
        Ok(ExtractOutcome::Extracted { .. })
    ));
}

// ------------------------------------------------------- interop fixtures

/// Three archives written by three independent writers (Info-ZIP, CPython
/// `zipfile` with a data descriptor, CPython `zipfile` with a forced ZIP64
/// extra). A self-generated archive cannot show that the reader agrees with
/// writers it did not author.
#[test]
fn synthetic_interop_fixtures_open_and_extract() {
    for name in [
        "infozip_deflate.zip",
        "python_datadescriptor.zip",
        "python_zip64.zip",
    ] {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/interop")
            .join(name);
        let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {name}: {e}"));
        assert!(bytes.len() < 4096, "{name} must stay tiny");

        let h = open("interop", vec![bytes]);
        let mut paths = h.paths();
        paths.sort();
        assert_eq!(
            paths,
            vec![
                "media/posts/a.jpg".to_owned(),
                "your_instagram_activity/media/posts_1.json".to_owned()
            ],
            "{name}"
        );

        match h
            .read_json("your_instagram_activity/media/posts_1.json")
            .unwrap_or_else(|e| panic!("{name}: {e}"))
        {
            JsonOutcome::Text { text } => {
                assert!(text.contains("media/posts/a.jpg"), "{name}");
            }
            other => panic!("{name}: expected json text, got {other:?}"),
        }

        match h
            .extract("media/posts/a.jpg", EntryKind::Image)
            .unwrap_or_else(|e| panic!("{name}: {e}"))
        {
            ExtractOutcome::Extracted {
                byte_length, head, ..
            } => {
                assert_eq!(byte_length, 48, "{name}");
                assert_eq!(&head[..4], b"\xFF\xD8\xFF\xE0", "{name}");
            }
            other => panic!("{name}: expected extraction, got {other:?}"),
        }

        let resolved = h
            .session
            .resolve_media_uris(vec!["media/posts/a.jpg".to_owned()]);
        assert!(
            matches!(resolved.first(), Some(UriResolution::Resolved { .. })),
            "{name}: {resolved:?}"
        );
    }
}

/// Overwrites every occurrence of `from` with `to`, which must be the same
/// length, and returns the number of replacements.
fn replace_in_place(data: &mut [u8], from: &[u8], to: &[u8]) -> usize {
    assert_eq!(from.len(), to.len());
    let mut hits = 0usize;
    let mut i = 0usize;
    while i + from.len() <= data.len() {
        if &data[i..i + from.len()] == from {
            data[i..i + from.len()].copy_from_slice(to);
            hits += 1;
            i += from.len();
        } else {
            i += 1;
        }
    }
    hits
}

/// A `Source` that serves one buffer for its first `flip_after` reads and a
/// different buffer afterwards: a file edited underneath an open descriptor.
/// The two buffers must be the same length, so `len()` stays honest and only
/// the content moves.
struct FlipAfter {
    first: Vec<u8>,
    second: Vec<u8>,
    flip_after: usize,
    reads: std::sync::atomic::AtomicUsize,
}

impl Source for FlipAfter {
    fn read_exact_at(&self, buf: &mut [u8], offset: u64) -> Result<(), ArchiveError> {
        let n = self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let bytes = if n < self.flip_after {
            &self.first
        } else {
            &self.second
        };
        let start = usize::try_from(offset).map_err(|_| ArchiveError::ReadFailed)?;
        let end = start
            .checked_add(buf.len())
            .ok_or(ArchiveError::ReadFailed)?;
        let src = bytes.get(start..end).ok_or(ArchiveError::ReadFailed)?;
        buf.copy_from_slice(src);
        Ok(())
    }

    fn len(&self) -> u64 {
        u64::try_from(self.first.len()).unwrap_or(u64::MAX)
    }
}

/// The two central-directory passes are cross-checked. A file edited between
/// them would leave the pass-1 local-header offsets describing records that are
/// no longer there, and every data-span bound derived from them would be
/// checking the wrong geometry.
#[test]
fn a_file_edited_between_the_two_passes_is_detected() {
    let first = ZipBuilder::new()
        .stored("media/posts/a.jpg", JPG)
        .stored("media/posts/b.jpg", JPG)
        .build();
    // Same length, different central-directory bytes: rename one entry in
    // place, at the byte level (a lossy UTF-8 round trip would resize the
    // archive). The name appears in both the local header and the central
    // directory; overwriting both keeps every offset identical.
    let mut second = first.clone();
    let hits = replace_in_place(&mut second, b"media/posts/b.jpg", b"media/posts/c.jpg");
    assert_eq!(hits, 2, "expected the name in the local header and the CD");
    assert_eq!(
        first.len(),
        second.len(),
        "the edit must not resize the file"
    );
    assert_ne!(first, second);

    let dir = support::TempDir::new("pass-flip");
    let flag = CancelFlag::new();
    // Pass 1 is one EOCD read plus one central-directory fill; flip right
    // after it so pass 2 reads the edited bytes.
    let src = FlipAfter {
        first,
        second,
        flip_after: 2,
        reads: std::sync::atomic::AtomicUsize::new(0),
    };
    let err = orbital_archive_reader::ArchiveSession::open_with_sources(
        vec![orbital_archive_reader::testing::PartSourceInput {
            src: Box::new(src),
            file_id: "1:0".to_owned(),
            expected_fp: None,
        }],
        dir.as_str(),
        &flag,
    )
    .err();
    assert_eq!(
        err,
        Some(orbital_archive_reader::ArchiveError::Changed { part_index: 0 }),
        "a mid-listing edit must be reported as a changed part"
    );
}

// --------------------------------------------------------------- group 11

/// Deterministic xorshift64*. A fixed seed means a CI failure is reproducible
/// from the printed iteration number alone.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            return 0;
        }
        usize::try_from(self.next() % n as u64).unwrap_or(0)
    }
}

/// A deterministic sweep of mutated archives. The assertion is not about any
/// particular outcome: it is that **every** outcome is a typed result. A panic,
/// an abort from an arithmetic overflow, or a hang fails this test — and those
/// are exactly the failure modes a hostile archive is built to cause.
#[test]
fn mutation_sweep_produces_only_typed_outcomes() {
    let base = ZipBuilder::new()
        .stored(
            "your_instagram_activity/media/posts_1.json",
            br#"{"media":[{"uri":"media/posts/a.jpg"}]}"#,
        )
        .deflated("media/posts/a.jpg", &vec![0x41u8; 4096])
        .stored("media/posts/b.png", b"\x89PNG\r\n\x1a\nsynthetic")
        .stored("media/posts/c.mp4", b"\x00\x00\x00\x18ftypmp42")
        .stored("messages/inbox/x/photos/d.jpg", JPG)
        .build();

    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let mut opened = 0usize;
    let mut extracted = 0usize;
    const ITERATIONS: usize = 5_000;

    for i in 0..ITERATIONS {
        let mut mutant = base.clone();
        match rng.next() % 4 {
            // A single byte flip.
            0 => {
                let at = rng.below(mutant.len());
                mutant[at] ^= 1u8 << (rng.below(8));
            }
            // A burst of byte flips.
            1 => {
                for _ in 0..1 + rng.below(8) {
                    let at = rng.below(mutant.len());
                    mutant[at] = u8::try_from(rng.next() % 256).unwrap_or(0);
                }
            }
            // Truncation.
            2 => {
                let keep = rng.below(mutant.len());
                mutant.truncate(keep);
            }
            // A 16-bit or 32-bit field overwritten with a saturated value,
            // which is how length and offset confusion is usually reached.
            _ => {
                let at = rng.below(mutant.len().saturating_sub(4).max(1));
                for k in 0..4usize.min(mutant.len().saturating_sub(at)) {
                    mutant[at + k] = 0xFF;
                }
            }
        }

        let Ok(h) = try_open(&format!("mut-{i}"), vec![mutant]) else {
            continue;
        };
        opened += 1;

        // The listing must be self-consistent whatever the mutation did.
        let entries = h.session.entries();
        assert!(
            entries.len() <= MAX_LISTED_ENTRIES_PER_SESSION,
            "iteration {i}"
        );
        // Entry ids are the persisted resume key, so a mutation must never be
        // able to mint two entries with the same one. `build_core` also fails
        // closed on a collision, which means a session that opened at all
        // already has a bijection between ids and entries.
        let unique: std::collections::HashSet<&String> =
            entries.iter().map(|e| &e.entry_id).collect();
        assert_eq!(unique.len(), entries.len(), "iteration {i}: id collision");
        for e in &entries {
            assert!(!e.entry_id.is_empty(), "iteration {i}");
            assert!(!e.path.contains(".."), "iteration {i}: {}", e.path);
            assert!(!e.path.starts_with('/'), "iteration {i}: {}", e.path);
            assert!(
                !e.path.starts_with("messages/"),
                "iteration {i}: {} escaped the allowlist",
                e.path
            );
            assert!(e.declared_size <= 9_007_199_254_740_991, "iteration {i}");
        }

        let _ = h.session.resolve_media_uris(vec![
            "media/posts/a.jpg".to_owned(),
            "messages/inbox/x/photos/d.jpg".to_owned(),
            "../../etc/passwd".to_owned(),
        ]);

        for e in &entries {
            let _ = h.session.peek_head_blocking(&e.entry_id, &h.cancel);
            if e.kind == EntryKind::Json {
                let _ = h.session.read_json_blocking(&e.entry_id, &h.cancel);
            } else {
                let staging = h.dir.staging(UUID_A);
                if let Ok(ExtractOutcome::Extracted {
                    byte_length, head, ..
                }) = h
                    .session
                    .extract_blocking(&e.entry_id, e.kind, &staging, &h.cancel)
                {
                    extracted += 1;
                    assert!(head.len() <= 128, "iteration {i}");
                    assert_eq!(
                        support::read_file(&staging).len() as u64,
                        byte_length,
                        "iteration {i}: reported length must match the file"
                    );
                    h.session.release_staging(staging.clone());
                }
            }
        }
    }

    // Non-vacuity: the sweep has to actually reach the parser and the copy
    // loop, not just bounce off the EOCD check.
    assert!(
        opened > ITERATIONS / 20,
        "only {opened}/{ITERATIONS} mutants opened; the sweep is too shallow"
    );
    assert!(extracted > 100, "only {extracted} extractions were reached");
}

// ------------------------------------------------------------------- F7

/// F7 ceiling: 100,000 listed entries resolved against 50,000 URIs.
///
/// Ignored by default because it allocates ~15 MB and takes a couple of
/// seconds. Run with `cargo test --release -- --ignored --nocapture
/// resolve_media_uris_scales` and read the printed timings; the stated ceiling
/// is that resolution itself stays under a second at this size, because it is
/// two hash lookups per URI against indexes built during the listing.
///
/// Measured on 2026-11-09 (M-series, `--release`): archive build 27 ms,
/// open + two central-directory passes over 100,000 records 75 ms, and
/// 50,000 URI resolutions 16 ms (all 50,000 resolved). That is the stated
/// ceiling: ~0.3 us per URI, which is why the API is documented as batch-only
/// rather than paged.
#[test]
#[ignore = "bench: allocates ~15 MB; run explicitly with --ignored --nocapture"]
fn resolve_media_uris_scales_to_100k_entries() {
    const ENTRIES: usize = MAX_LISTED_ENTRIES_PER_SESSION;
    const URIS: usize = 50_000;

    let build_start = Instant::now();
    let mut b = ZipBuilder::new();
    for i in 0..ENTRIES {
        b = b.stored(&format!("media/posts/{i:08}.jpg"), JPG);
    }
    let zip = b.build();
    let build_ms = build_start.elapsed().as_millis();

    let open_start = Instant::now();
    let h = open("bench", vec![zip]);
    let open_ms = open_start.elapsed().as_millis();
    assert_eq!(h.session.entries().len(), ENTRIES);

    let uris: Vec<String> = (0..URIS)
        .map(|i| format!("media/posts/{:08}.jpg", i * 2))
        .collect();

    let resolve_start = Instant::now();
    let out = h.session.resolve_media_uris(uris);
    let resolve_ms = resolve_start.elapsed().as_millis();

    let hits = out
        .iter()
        .filter(|r| matches!(r, UriResolution::Resolved { .. }))
        .count();
    assert_eq!(hits, URIS);

    println!(
        "F7 bench: build {build_ms} ms, open+list {open_ms} ms ({ENTRIES} entries), \
         resolve {resolve_ms} ms ({URIS} URIs, {hits} hits)"
    );
    assert!(
        resolve_ms < 5_000,
        "resolution took {resolve_ms} ms for {URIS} URIs"
    );
}

/// More than 65,535 records without a ZIP64 record: the 32-bit EOCD count
/// saturates at 0xFFFF, which must not be read as corruption. Both Info-ZIP
/// and CPython write exactly this shape.
#[test]
fn a_saturated_32_bit_entry_count_is_not_corruption() {
    const N: usize = 70_000;
    let mut b = ZipBuilder::new();
    for i in 0..N {
        b = b.stored(&format!("media/posts/{i:08}.jpg"), JPG);
    }
    let h = open("sat-count", vec![b.build()]);
    assert_eq!(h.session.entries().len(), N);
    // The ordinals still run over the full range, so nothing was hidden behind
    // the saturated count.
    let last = h.session.entries().last().expect("last").entry_id.clone();
    assert!(last.ends_with(&format!(":{}", N - 1)), "{last}");
}

/// The listed-entry ceiling is really reached: 64 DISTINCT parts of 1,600
/// allowlisted entries each is 102,400, just over the 100,000 bound.
#[test]
fn the_listed_entry_ceiling_is_enforced() {
    let parts: Vec<Vec<u8>> = (0..64u32)
        .map(|p| {
            let mut b = ZipBuilder::new();
            for i in 0..1600u32 {
                // Part-unique names, so the parts are not duplicates of each
                // other and nothing is deduplicated away before the count.
                b = b.stored(&format!("media/posts/{p:02}_{i:05}.jpg"), JPG);
            }
            b.build()
        })
        .collect();
    assert_eq!(
        try_open("listed-ceiling", parts).err(),
        Some(orbital_archive_reader::ArchiveError::TooManyEntries)
    );
}

/// Just under the ceiling still opens, so the bound above is a bound and not a
/// blanket refusal.
#[test]
fn just_under_the_listed_entry_ceiling_opens() {
    let parts: Vec<Vec<u8>> = (0..4u32)
        .map(|p| {
            let mut b = ZipBuilder::new();
            for i in 0..2000u32 {
                b = b.stored(&format!("media/posts/{p:02}_{i:05}.jpg"), JPG);
            }
            b.build()
        })
        .collect();
    let h = open("listed-under", parts);
    assert_eq!(h.session.entries().len(), 8_000);
}

/// The session-wide central-directory record budget bounds the retained
/// local-header offset vectors, which are what 64 x 1M records would blow up.
#[test]
fn the_session_cd_record_budget_is_enforced() {
    let mut b = ZipBuilder::new();
    for i in 0..10u32 {
        b = b.stored(&format!("media/posts/{i}.jpg"), JPG);
    }
    let zip = b.build();
    assert_eq!(
        support::try_open_with_budgets(
            "cd-records",
            vec![zip.clone()],
            Budgets {
                cd_records: 5,
                ..support::unbounded()
            },
        )
        .err(),
        Some(orbital_archive_reader::ArchiveError::TooManyEntries)
    );
    // Non-vacuity: the same archive opens when the budget allows it, and it
    // counts EVERY central-directory record, not just the allowlisted ones.
    let h = support::try_open_with_budgets(
        "cd-records-ok",
        vec![zip],
        Budgets {
            cd_records: 10,
            ..support::unbounded()
        },
    )
    .expect("opens at exactly the budget");
    assert_eq!(h.session.entries().len(), 10);
}

/// A malformed central extra field costs one entry, not the archive.
#[test]
fn a_malformed_central_extra_field_is_a_per_entry_skip() {
    let mut bad = EntrySpec::stored("media/posts/bad.jpg", JPG);
    // A ZIP64 extra header claiming 0xFFFF bytes of payload, with none.
    bad.cd_extra = Some(vec![0x01, 0x00, 0xFF, 0xFF]);
    let zip = ZipBuilder::new()
        .with(bad)
        .stored("media/posts/good.jpg", JPG)
        .build();

    let h = open("bad-extra", vec![zip]);
    assert_eq!(h.session.entries().len(), 2);
    assert_eq!(
        h.skip_of("media/posts/bad.jpg"),
        Some(orbital_archive_reader::EntrySkipCode::EntryCorrupt)
    );
    assert_eq!(h.skip_of("media/posts/good.jpg"), None);
    assert!(matches!(
        h.extract("media/posts/good.jpg", EntryKind::Image),
        Ok(ExtractOutcome::Extracted { .. })
    ));
}

/// `close()` releases this crate's descriptor dups, so a session the app has
/// finished with stops reading before uniffi gets round to destroying it.
#[test]
fn close_releases_the_sources() {
    let h = open("close-src", vec![instagram_like().build()]);
    let json = h.id_of("media/posts/a.jpg");
    let _ = json;
    let json_id = h.id_of("your_instagram_activity/media/posts_1.json");

    // Baseline: the source answers reads while the session is open.
    assert!(h.session.read_json_blocking(&json_id, &h.cancel).is_ok());
    let reads_before = h.sources[0].read_count();

    h.session.close();

    // read_json takes no staging reservation, so this reaches the source layer
    // rather than stopping at the `closed` flag.
    assert_eq!(
        h.session.read_json_blocking(&json_id, &h.cancel).err(),
        Some(orbital_archive_reader::ArchiveError::SessionClosed)
    );
    assert_eq!(
        h.sources[0].read_count(),
        reads_before,
        "a released source must not forward the read at all"
    );
    // Idempotent.
    h.session.close();
}

/// A peek on a skipped entry reports the skip rather than reading anything.
#[test]
fn peek_on_a_skipped_entry_reports_the_skip() {
    let mut e = EntrySpec::stored("media/posts/enc.jpg", JPG);
    e.flags = support::zipgen::FLAG_UTF8 | support::zipgen::FLAG_ENCRYPTED;
    let h = open("peek-skip", vec![ZipBuilder::new().with(e).build()]);
    assert!(matches!(
        h.peek("media/posts/enc.jpg"),
        Ok(PeekOutcome::Skipped {
            skip: orbital_archive_reader::EntrySkipCode::EntryEncrypted
        })
    ));
}
