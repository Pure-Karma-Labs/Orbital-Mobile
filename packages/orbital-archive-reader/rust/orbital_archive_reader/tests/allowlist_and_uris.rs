//! Hostile matrix groups 7 and 8, plus folds F1 and F17.
//!
//! Group 8 is the load-bearing one: it proves with a recording source that no
//! read range ever touches a `messages/` local header or its data. Everything
//! else about the allowlist is a string decision; this is the behavioural
//! proof.

mod support;

use orbital_archive_reader::testing::{DENIED_ROOTS, HEAD_PEEK_BYTES};
use orbital_archive_reader::{EntryKind, EntrySkipCode, PeekOutcome, UriResolution, UriSkipCode};
use support::zipgen::{EntrySpec, ZipBuilder};
use support::{UUID_A, open};

const JPG: &[u8] = b"\xFF\xD8\xFF\xE0jpeg-bytes";
/// ISO-BMFF with an `ftyp` box claiming MP4: what a video wearing a .jpg name
/// looks like to a sniffer.
const MP4_HEAD: &[u8] = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isomMOREBYTES";

fn resolved_id(r: &UriResolution) -> Option<&str> {
    match r {
        UriResolution::Resolved { entry_id } => Some(entry_id),
        UriResolution::Skipped { .. } => None,
    }
}

fn skip_of(r: &UriResolution) -> Option<UriSkipCode> {
    match r {
        UriResolution::Skipped { skip } => Some(*skip),
        UriResolution::Resolved { .. } => None,
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

// ---------------------------------------------------------------- group 8

/// `messages/` is never opened. The recording source proves no read range
/// overlaps the `messages/` local header or its data, which is the real
/// guarantee behind the issue's Jest acceptance criterion.
#[test]
fn messages_local_header_and_data_are_never_read() {
    let secret = vec![0x5Au8; 4096];
    // The archive must be larger than the 64 KiB EOCD scan window, otherwise
    // the tail scan legitimately covers the whole file and the assertion would
    // be vacuous.
    let filler = vec![0x11u8; 200_000];
    let name = "messages/inbox/someone/photos/secret.jpg";
    let zip = ZipBuilder::new()
        .stored(name, &secret)
        .stored("media/posts/a.jpg", &filler)
        .stored(
            "your_instagram_activity/media/posts_1.json",
            br#"{"media":[{"uri":"media/posts/a.jpg"}]}"#,
        )
        .build();
    assert!(zip.len() > 70_000, "archive must exceed the EOCD window");

    let lh_name_at = find(&zip, name.as_bytes()).expect("local header name");
    let lh_start = lh_name_at as u64 - 30;
    let data_end = (lh_name_at + name.len() + secret.len()) as u64;

    let h = open("never-messages", vec![zip]);
    assert!(
        !h.paths().iter().any(|p| p.starts_with("messages/")),
        "messages/ must never be listed"
    );
    assert!(h.rejected(EntrySkipCode::EntryNotAllowlisted) >= 1);

    // Exercise everything a consumer would do.
    let _ = h.read_json("your_instagram_activity/media/posts_1.json");
    let _ = h.extract("media/posts/a.jpg", EntryKind::Image);
    let _ = h.peek("media/posts/a.jpg");
    let _ = h.session.resolve_media_uris(vec![
        "media/posts/a.jpg".to_owned(),
        "messages/inbox/someone/photos/secret.jpg".to_owned(),
    ]);

    assert!(
        !h.sources[0].touched(lh_start, data_end),
        "a read touched the messages/ region: {:?}",
        h.sources[0]
            .reads()
            .iter()
            .filter(|&&(o, n)| o < data_end && o + n > lh_start)
            .collect::<Vec<_>>()
    );
}

/// Every denied root is counted and never listed.
#[test]
fn every_denied_root_is_refused() {
    for root in DENIED_ROOTS {
        let zip = ZipBuilder::new()
            .stored(&format!("{root}/a.jpg"), JPG)
            .stored(&format!("{root}/nested/b.json"), b"{}")
            .build();
        let h = open("denied", vec![zip]);
        assert!(h.paths().is_empty(), "{root} must list nothing");
    }
}

// ---------------------------------------------------------------- F17

/// A wrapper directory whose name equals a known root key is never stripped.
/// Without this, an archive wrapped in a directory called `messages` would
/// have its contents promoted into allowlisted positions.
#[test]
fn a_wrapper_named_like_a_denied_root_is_never_stripped() {
    for root in DENIED_ROOTS {
        let zip = ZipBuilder::new()
            .stored(&format!("{root}/media/posts/a.jpg"), JPG)
            .stored(
                &format!("{root}/your_instagram_activity/media/posts_1.json"),
                b"{}",
            )
            .build();
        let h = open("f17", vec![zip]);
        assert!(
            h.paths().is_empty(),
            "wrapper {root} was stripped; listed {:?}",
            h.paths()
        );
    }
}

/// A genuine wrapper directory IS stripped, once, when every file shares it.
#[test]
fn a_real_wrapper_is_stripped_exactly_once() {
    let zip = ZipBuilder::new()
        .stored("facebook-jane-2026-01-01/media/posts/a.jpg", JPG)
        .stored(
            "facebook-jane-2026-01-01/your_instagram_activity/media/posts_1.json",
            b"{}",
        )
        .build();
    let h = open("wrap", vec![zip]);
    let mut paths = h.paths();
    paths.sort();
    assert_eq!(
        paths,
        vec![
            "media/posts/a.jpg".to_owned(),
            "your_instagram_activity/media/posts_1.json".to_owned()
        ]
    );
}

/// A file at the archive root disqualifies the strip: stripping would destroy
/// that file's identity.
#[test]
fn a_root_level_file_disqualifies_the_strip() {
    let zip = ZipBuilder::new()
        .stored("wrapper/media/posts/a.jpg", JPG)
        .stored("README.txt", b"hi")
        .build();
    let h = open("nowrap", vec![zip]);
    assert!(h.paths().is_empty(), "nothing is allowlisted un-stripped");
}

/// Directory entries do not count toward the unanimity test, and are not
/// listed themselves.
#[test]
fn directory_entries_are_ignored_by_the_strip_and_the_listing() {
    let zip = ZipBuilder::new()
        .with(EntrySpec::dir("wrapper/"))
        .with(EntrySpec::dir("wrapper/media/"))
        .stored("wrapper/media/posts/a.jpg", JPG)
        .build();
    let h = open("dirs", vec![zip]);
    assert_eq!(h.paths(), vec!["media/posts/a.jpg".to_owned()]);
}

// ---------------------------------------------------------------- group 7

/// Allowlist rows that the local Meta samples confirm, end to end through a
/// session rather than through the string matcher alone.
#[test]
fn confirmed_allowlist_rows_are_listed_through_a_session() {
    let zip = ZipBuilder::new()
        .stored(
            "your_facebook_activity/posts/your_posts__check_ins__photos_and_videos_1.json",
            b"{}",
        )
        .stored("your_facebook_activity/posts/media/Album_1/x.jpg", JPG)
        .stored("your_instagram_activity/media/posts_1.json", b"{}")
        .stored("your_instagram_activity/media/posts.json", b"{}")
        .stored("media/posts/a.jpg", JPG)
        .stored("media/posts/a.webp", JPG)
        // near-miss negatives
        .stored("media/stories/s.jpg", JPG)
        .stored("your_instagram_activity/media/reels.json", b"{}")
        .stored("your_facebook_activity/posts/album/0.json", b"{}")
        .stored("media/posts/notes.txt", b"x")
        .build();
    let h = open("rows", vec![zip]);
    let mut paths = h.paths();
    paths.sort();
    assert_eq!(
        paths,
        vec![
            "media/posts/a.jpg".to_owned(),
            "media/posts/a.webp".to_owned(),
            "your_facebook_activity/posts/media/Album_1/x.jpg".to_owned(),
            "your_facebook_activity/posts/your_posts__check_ins__photos_and_videos_1.json"
                .to_owned(),
            "your_instagram_activity/media/posts.json".to_owned(),
            "your_instagram_activity/media/posts_1.json".to_owned(),
        ]
    );
}

/// URI resolution: exact, suffix, ambiguous, outside the allowlist,
/// unresolved, unsupported kind and invalid.
#[test]
fn uri_resolution_covers_every_outcome() {
    let p1 = ZipBuilder::new()
        .stored("media/posts/a.jpg", JPG)
        .stored("media/posts/only.jpg", JPG)
        .build();
    let p2 = ZipBuilder::new()
        .stored("your_facebook_activity/posts/media/Album/a.jpg", JPG)
        .build();
    let h = open("uris", vec![p1, p2]);

    let out = h.session.resolve_media_uris(vec![
        // exact
        "media/posts/a.jpg".to_owned(),
        // suffix-only: a relative URI naming a unique basename
        "Album/a.jpg".to_owned(),
        // ambiguous: "a.jpg" is a suffix of two listed entries
        "a.jpg".to_owned(),
        // denied root, refused from the string alone
        "messages/inbox/x.jpg".to_owned(),
        // allowlisted-looking but absent
        "media/posts/missing.jpg".to_owned(),
        // not a media extension
        "media/posts/notes.txt".to_owned(),
        // not a path at all
        "https://example.com/a.jpg".to_owned(),
        // traversal
        "../a.jpg".to_owned(),
    ]);

    assert_eq!(
        resolved_id(&out[0]),
        Some(h.id_of("media/posts/a.jpg")).as_deref()
    );
    assert_eq!(
        resolved_id(&out[1]),
        Some(h.id_of("your_facebook_activity/posts/media/Album/a.jpg")).as_deref()
    );
    assert_eq!(skip_of(&out[2]), Some(UriSkipCode::UriAmbiguous));
    assert_eq!(skip_of(&out[3]), Some(UriSkipCode::UriOutsideAllowlist));
    assert_eq!(skip_of(&out[4]), Some(UriSkipCode::UriUnresolved));
    assert_eq!(skip_of(&out[5]), Some(UriSkipCode::UriUnsupportedKind));
    assert_eq!(skip_of(&out[6]), Some(UriSkipCode::UriInvalid));
    assert_eq!(skip_of(&out[7]), Some(UriSkipCode::UriInvalid));
}

/// Resolution performs no I/O at all: the indexes are built at listing time.
#[test]
fn resolution_reads_nothing() {
    let h = open("uris-io", vec![support::zipgen::instagram_like().build()]);
    let before = h.sources[0].read_count();
    let out = h.session.resolve_media_uris(vec![
        "media/posts/a.jpg".to_owned(),
        "messages/x.jpg".to_owned(),
        "media/posts/nope.jpg".to_owned(),
    ]);
    assert!(resolved_id(&out[0]).is_some());
    assert_eq!(
        h.sources[0].read_count(),
        before,
        "resolution must not read"
    );
}

/// A skipped entry is never resolvable: a duplicate or corrupt entry must not
/// be handed to a caller as if it were usable.
#[test]
fn skipped_entries_are_not_in_the_index() {
    let zip = ZipBuilder::new()
        .stored("media/posts/a.jpg", JPG)
        .stored("media/posts/a.jpg", b"\xFF\xD8\xFF\xE0different")
        .build();
    let h = open("skip-index", vec![zip]);
    let out = h
        .session
        .resolve_media_uris(vec!["media/posts/a.jpg".to_owned()]);
    assert_eq!(skip_of(&out[0]), Some(UriSkipCode::UriUnresolved));
}

// ---------------------------------------------------------------- F1

/// MP4 bytes wearing a `.jpg` name: `peek_head` returns at most 128 bytes,
/// writes no staging file and charges nothing to the byte budget, so the
/// service can refuse the entry before any extraction happens. Rust cannot
/// make the refusal decision (the sniffer lives in TypeScript), but it must
/// make the decision possible without extracting.
#[test]
fn peek_head_exposes_a_video_header_without_extracting() {
    let mut body = MP4_HEAD.to_vec();
    body.extend_from_slice(&vec![0x42u8; 50_000]);
    let zip = ZipBuilder::new()
        .deflated("media/posts/fake.jpg", &body)
        .build();
    let h = open("f1-peek", vec![zip]);

    let head = match h.peek("media/posts/fake.jpg").expect("no throw") {
        PeekOutcome::Head { head } => head,
        other => panic!("expected a head, got {other:?}"),
    };
    assert_eq!(head.len(), HEAD_PEEK_BYTES);
    assert_eq!(&head[4..12], b"ftypmp42");

    // No staging file was created by the peek, and no file was written.
    assert!(
        h.staging_residue().is_empty(),
        "peek_head must not create files: {:?}",
        h.staging_residue()
    );

    // The whole entry was never inflated: the peek stopped at 128 bytes.
    assert!(
        h.sources[0].bytes_read() < 50_000,
        "peek read {} bytes",
        h.sources[0].bytes_read()
    );

    // And the budget was untouched: a 1-byte session budget still permits an
    // extraction afterwards, which it would not if the peek had been charged.
    let h2 = support::try_open(
        "f1-budget",
        vec![ZipBuilder::new().stored("media/posts/s.jpg", JPG).build()],
    )
    .expect("opens");
    let _ = h2.peek("media/posts/s.jpg").expect("peek");
    assert!(matches!(
        h2.extract("media/posts/s.jpg", EntryKind::Image),
        Ok(orbital_archive_reader::ExtractOutcome::Extracted { .. })
    ));
}

/// A peek on a json entry is allowed (F1 permits json and image kinds).
#[test]
fn peek_head_is_allowed_for_json() {
    let h = open(
        "f1-json",
        vec![
            ZipBuilder::new()
                .stored(
                    "your_instagram_activity/media/posts_1.json",
                    br#"{"media":[]}"#,
                )
                .build(),
        ],
    );
    match h
        .peek("your_instagram_activity/media/posts_1.json")
        .expect("no throw")
    {
        PeekOutcome::Head { head } => assert_eq!(&head[..1], b"{"),
        other => panic!("expected a head, got {other:?}"),
    }
}

/// The extract head is the same 128-byte prefix, so the service can re-check
/// after extraction without a second read.
#[test]
fn extract_returns_the_same_head_prefix() {
    let mut body = MP4_HEAD.to_vec();
    body.extend_from_slice(&vec![7u8; 500]);
    let zip = ZipBuilder::new()
        .stored("media/posts/fake.jpg", &body)
        .build();
    let h = open("f1-head", vec![zip]);
    let peeked = match h.peek("media/posts/fake.jpg").expect("peek") {
        PeekOutcome::Head { head } => head,
        other => panic!("{other:?}"),
    };
    match h
        .extract("media/posts/fake.jpg", EntryKind::Image)
        .expect("x")
    {
        orbital_archive_reader::ExtractOutcome::Extracted { head, path, .. } => {
            assert_eq!(head, peeked);
            assert_eq!(support::read_file(&path).len(), body.len());
            assert_eq!(path, h.dir.staging(UUID_A));
        }
        other => panic!("{other:?}"),
    }
}
