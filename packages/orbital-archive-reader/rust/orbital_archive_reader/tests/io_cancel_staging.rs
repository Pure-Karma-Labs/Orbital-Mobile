//! Hostile matrix groups 9 and 10, plus folds F4 and F8.
//!
//! These tests go through the real FFI entry point (`open_archive`, driven by
//! the hand-rolled executor in `support`) wherever a real file descriptor is
//! part of what is being tested: fd adoption, `dev:ino` verification and
//! seekability cannot be proven over an in-memory source.

mod support;

use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use orbital_archive_reader::testing::CancelFlag;
use orbital_archive_reader::{
    ArchiveError, ArchivePartInput, CancelToken, EntryKind, ExtractOutcome, JsonOutcome,
    PeekOutcome,
};
use support::zipgen::{EntrySpec, ZipBuilder, instagram_like};
use support::{MemSource, TempDir, UUID_A, UUID_B, UUID_C, block_on, open, try_open_sources};

const JPG: &[u8] = b"\xFF\xD8\xFF\xE0jpeg";
const IMG: &str = "media/posts/a.jpg";
const JSON: &str = "your_instagram_activity/media/posts_1.json";

/// A big allowlisted archive: large enough that a full listing costs several
/// central-directory refills.
fn big_archive(entries: usize) -> Vec<u8> {
    let mut b = ZipBuilder::new();
    for i in 0..entries {
        b = b.stored(&format!("media/posts/{i:08}.jpg"), JPG);
    }
    b.build()
}

// ------------------------------------------------- group 9: real descriptors

/// A real file descriptor is adopted, verified against its `dev:ino`, and the
/// archive opens and extracts through the async FFI entry point. This is the
/// only test that proves `fd.rs` and `blocking.rs` work together with no
/// runtime.
#[test]
fn a_real_descriptor_opens_through_the_ffi_entry_point() {
    let dir = TempDir::new("fd-ok");
    let zip_path = dir.path.join("part.zip");
    std::fs::write(&zip_path, instagram_like().build()).expect("write zip");
    let file = std::fs::File::open(&zip_path).expect("open zip");
    let meta = file.metadata().expect("stat");
    let part = ArchivePartInput {
        fd: file.as_raw_fd(),
        byte_length: meta.len(),
        file_id: format!("{}:{}", meta.dev(), meta.ino()),
        expected_fp: None,
    };

    let session = block_on(orbital_archive_reader::open_archive(
        vec![part],
        dir.as_str().to_owned(),
        CancelToken::new(),
    ))
    .expect("open");

    assert_eq!(session.entries().len(), 3);
    let id = session
        .entries()
        .into_iter()
        .find(|e| e.path == IMG)
        .expect("image")
        .entry_id;
    let staging = dir.staging(UUID_A);
    let out =
        block_on(session.extract_entry(id, EntryKind::Image, staging.clone(), "job-1".to_owned()))
            .expect("extract");
    match out {
        ExtractOutcome::Extracted { byte_length, .. } => assert!(byte_length > 0),
        other => panic!("expected extraction, got {other:?}"),
    }
    // The glue still owns the original fd: the session only dropped its dup.
    session.close();
    assert!(file.metadata().is_ok(), "the caller's fd must stay valid");
}

/// A pipe is not seekable. On Android an MTP provider hands back exactly this,
/// and the UX answer is "copy the file to your device first".
#[test]
fn a_pipe_descriptor_is_not_seekable() {
    let dir = TempDir::new("fd-pipe");
    let mut child = Command::new("/bin/sh")
        .arg("-c")
        .arg("sleep 2")
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn");
    let fd = child.stdout.as_ref().expect("stdout").as_raw_fd();
    let err = block_on(orbital_archive_reader::open_archive(
        vec![ArchivePartInput {
            fd,
            byte_length: 1024,
            file_id: "1:1".to_owned(),
            expected_fp: None,
        }],
        dir.as_str().to_owned(),
        CancelToken::new(),
    ))
    .err();
    let _ = child.kill();
    let _ = child.wait();
    assert_eq!(err, Some(ArchiveError::NotSeekable));
}

/// A `fileId` that does not match the descriptor means the fd number was
/// reused between the glue's `fstat` and this call.
#[test]
fn a_file_id_mismatch_is_refused() {
    let dir = TempDir::new("fd-id");
    let zip_path = dir.path.join("part.zip");
    std::fs::write(&zip_path, instagram_like().build()).expect("write");
    let file = std::fs::File::open(&zip_path).expect("open");
    let len = file.metadata().expect("stat").len();
    for bad_id in ["1:1", ""] {
        let err = block_on(orbital_archive_reader::open_archive(
            vec![ArchivePartInput {
                fd: file.as_raw_fd(),
                byte_length: len,
                file_id: bad_id.to_owned(),
                expected_fp: None,
            }],
            dir.as_str().to_owned(),
            CancelToken::new(),
        ))
        .err();
        assert_eq!(err, Some(ArchiveError::ReadFailed), "file_id {bad_id:?}");
    }
}

/// A declared length that disagrees with the descriptor is also refused: the
/// glue measured a different file.
#[test]
fn a_length_mismatch_is_refused() {
    let dir = TempDir::new("fd-len");
    let zip_path = dir.path.join("part.zip");
    std::fs::write(&zip_path, instagram_like().build()).expect("write");
    let file = std::fs::File::open(&zip_path).expect("open");
    let meta = file.metadata().expect("stat");
    let err = block_on(orbital_archive_reader::open_archive(
        vec![ArchivePartInput {
            fd: file.as_raw_fd(),
            byte_length: meta.len() + 1,
            file_id: format!("{}:{}", meta.dev(), meta.ino()),
            expected_fp: None,
        }],
        dir.as_str().to_owned(),
        CancelToken::new(),
    ))
    .err();
    assert_eq!(err, Some(ArchiveError::ReadFailed));
}

/// A closed / negative descriptor is access lost, not a panic.
#[test]
fn a_bad_descriptor_is_access_lost() {
    let dir = TempDir::new("fd-bad");
    let err = block_on(orbital_archive_reader::open_archive(
        vec![ArchivePartInput {
            fd: -1,
            byte_length: 100,
            file_id: "1:1".to_owned(),
            expected_fp: None,
        }],
        dir.as_str().to_owned(),
        CancelToken::new(),
    ))
    .err();
    assert_eq!(err, Some(ArchiveError::AccessLost { part_index: 0 }));
}

/// A source that fails from a given offset gives `ReadFailed`, whether the
/// failure lands in the EOCD scan, the central directory, or entry data.
#[test]
fn an_io_failure_at_any_offset_is_read_failed() {
    let zip = instagram_like().build();
    let len = zip.len() as u64;

    // Failing inside the EOCD window.
    let tail_fail = MemSource::failing_from(zip.clone(), len - 10);
    assert_eq!(
        try_open_sources("io-tail", vec![tail_fail]).err(),
        Some(ArchiveError::ReadFailed)
    );

    // Failing from byte 0: the central directory read cannot complete either.
    let all_fail = MemSource::failing_from(zip.clone(), 0);
    assert_eq!(
        try_open_sources("io-all", vec![all_fail]).err(),
        Some(ArchiveError::ReadFailed)
    );

    // Failing only in the entry-data region: the listing succeeds, the
    // extraction does not.
    let data_fail = MemSource::failing_from(zip, 40);
    let h = try_open_sources("io-data", vec![data_fail]);
    // The local header of the first entry sits in the failing region, so this
    // either fails at open or at extract; both are ReadFailed, never a panic.
    match h {
        Err(e) => assert_eq!(e, ArchiveError::ReadFailed),
        Ok(h) => assert_eq!(
            h.extract(IMG, EntryKind::Image).err(),
            Some(ArchiveError::ReadFailed)
        ),
    }
}

// ------------------------------------------------- group 10 / F4: cancel

/// Cancelling during a listing returns promptly, with a bounded read cost.
/// Without the per-refill and per-10k-record checks in `cdir.rs`, a cancelled
/// open would still read the whole central directory twice.
#[test]
fn cancel_during_listing_is_bounded() {
    let zip = big_archive(20_000);
    let full = MemSource::new(zip.clone());
    let baseline = try_open_sources("cancel-base", vec![Arc::clone(&full)]).expect("opens");
    let full_cost = baseline.sources[0].bytes_read();
    drop(baseline);

    let src = MemSource::new(zip);
    let dir = TempDir::new("cancel-listing");
    let flag = CancelFlag::new();
    // Trip the flag after the EOCD scan plus one central-directory refill.
    src.cancel_after(2, &flag);
    let err = orbital_archive_reader::ArchiveSession::open_with_sources(
        vec![orbital_archive_reader::testing::PartSourceInput {
            src: Box::new(support::SharedSource(Arc::clone(&src))),
            file_id: "1:0".to_owned(),
            expected_fp: None,
        }],
        dir.as_str(),
        &flag,
    )
    .err();
    assert_eq!(err, Some(ArchiveError::Cancelled));
    assert!(
        src.bytes_read() < full_cost,
        "cancelled listing read {} bytes, a full listing costs {full_cost}",
        src.bytes_read()
    );
}

/// An already-cancelled flag stops an open before any read.
#[test]
fn an_already_cancelled_open_reads_nothing() {
    let src = MemSource::new(instagram_like().build());
    let dir = TempDir::new("cancel-pre");
    let flag = CancelFlag::new();
    flag.cancel();
    let err = orbital_archive_reader::ArchiveSession::open_with_sources(
        vec![orbital_archive_reader::testing::PartSourceInput {
            src: Box::new(support::SharedSource(Arc::clone(&src))),
            file_id: "1:0".to_owned(),
            expected_fp: None,
        }],
        dir.as_str(),
        &flag,
    )
    .err();
    assert_eq!(err, Some(ArchiveError::Cancelled));
    assert_eq!(src.read_count(), 0);
}

/// Cancelling mid-extract unlinks the partial staging file. A half-written
/// image must never survive to be mistaken for a complete one.
#[test]
fn cancel_mid_extract_unlinks_the_partial_file() {
    // Several copy-loop iterations: 300 KiB at 64 KiB per chunk.
    let body = vec![0xABu8; 300 * 1024];
    let zip = ZipBuilder::new().stored(IMG, &body).build();
    let h = open("cancel-extract", vec![zip]);
    let staging = h.dir.staging(UUID_A);
    h.sources[0].reset_reads();
    h.sources[0].cancel_after(1, &h.cancel);

    let id = h.id_of(IMG);
    let err = h
        .session
        .extract_blocking(&id, EntryKind::Image, &staging, &h.cancel)
        .err();
    assert_eq!(err, Some(ArchiveError::Cancelled));
    assert!(
        !std::path::Path::new(&staging).exists(),
        "the partial staging file must be unlinked"
    );
    assert!(h.staging_residue().is_empty());
}

/// F4: `read_json` checks the cancel flag between the read and the decode, so
/// an aborted 12 MiB JSON never pays for a UTF-8 validation pass.
#[test]
fn cancel_between_read_and_decode_of_read_json() {
    let zip = ZipBuilder::new()
        .stored(JSON, br#"{"media":[{"uri":"media/posts/a.jpg"}]}"#)
        .stored(IMG, JPG)
        .build();
    let h = open("cancel-json", vec![zip]);
    h.sources[0].reset_reads();
    // The local-header name read, then the data read: trip the flag on the
    // last one, so every read succeeds and only the decode is skipped.
    h.sources[0].cancel_after(3, &h.cancel);
    let id = h.id_of(JSON);
    assert_eq!(
        h.session.read_json_blocking(&id, &h.cancel).err(),
        Some(ArchiveError::Cancelled)
    );
}

/// `close()` cancels in flight work and refuses new jobs.
#[test]
fn close_refuses_further_jobs() {
    let h = open("closed", vec![instagram_like().build()]);
    let id = h.id_of(IMG);
    h.session.close();
    assert_eq!(
        block_on(h.session.peek_head(id.clone(), "j".to_owned())).err(),
        Some(ArchiveError::SessionClosed)
    );
    assert_eq!(
        block_on(h.session.read_json(id.clone(), "j".to_owned())).err(),
        Some(ArchiveError::SessionClosed)
    );
    assert_eq!(
        block_on(h.session.extract_entry(
            id,
            EntryKind::Image,
            h.dir.staging(UUID_B),
            "j".to_owned()
        ))
        .err(),
        Some(ArchiveError::SessionClosed)
    );
    // Idempotent.
    h.session.close();
}

/// A fifth concurrent job is refused with `Busy`: `MAX_JOBS` is 4.
#[test]
fn a_fifth_concurrent_job_is_busy() {
    let body = vec![3u8; 128 * 1024];
    let mut b = ZipBuilder::new();
    for i in 0..5 {
        b = b.stored(&format!("media/posts/{i}.jpg"), &body);
    }
    let h = open("jobs", vec![b.build()]);
    let gate = h.sources[0].install_gate();
    h.sources[0].reset_reads();

    let session = Arc::clone(&h.session);
    let mut handles = Vec::new();
    for i in 0..4u32 {
        let s = Arc::clone(&session);
        let id = h.id_of(&format!("media/posts/{i}.jpg"));
        let staging = h.dir.staging(match i {
            0 => UUID_A,
            1 => UUID_B,
            2 => UUID_C,
            _ => "ffffffff-ffff-ffff-ffff-ffffffffffff",
        });
        handles.push(std::thread::spawn(move || {
            block_on(s.extract_entry(id, EntryKind::Image, staging, format!("job-{i}")))
        }));
    }

    // Wait until all four jobs are blocked inside a read.
    let deadline = Instant::now() + Duration::from_secs(5);
    while h.sources[0].read_count() < 4 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        h.sources[0].read_count() >= 4,
        "four jobs should be in flight, saw {}",
        h.sources[0].read_count()
    );

    let fifth = block_on(
        h.session
            .peek_head(h.id_of("media/posts/4.jpg"), "job-5".to_owned()),
    );
    assert_eq!(fifth.err(), Some(ArchiveError::Busy));

    gate.open();
    for handle in handles {
        let out = handle.join().expect("join");
        assert!(
            matches!(out, Ok(ExtractOutcome::Extracted { .. })),
            "{out:?}"
        );
    }

    // With the jobs finished, the registry is empty again.
    assert!(matches!(
        block_on(
            h.session
                .peek_head(h.id_of("media/posts/4.jpg"), "job-6".to_owned())
        ),
        Ok(PeekOutcome::Head { .. })
    ));
}

/// The same job id twice is `Busy`, so a wrapper bug cannot silently share a
/// cancel flag between two calls.
#[test]
fn a_duplicate_job_id_is_busy() {
    let body = vec![3u8; 128 * 1024];
    let zip = ZipBuilder::new()
        .stored(IMG, &body)
        .stored("media/posts/b.jpg", &body)
        .build();
    let h = open("dup-job", vec![zip]);
    let gate = h.sources[0].install_gate();
    h.sources[0].reset_reads();

    let s = Arc::clone(&h.session);
    let id = h.id_of(IMG);
    let staging = h.dir.staging(UUID_A);
    let handle = std::thread::spawn(move || {
        block_on(s.extract_entry(id, EntryKind::Image, staging, "same".to_owned()))
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    while h.sources[0].read_count() < 1 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        block_on(
            h.session
                .peek_head(h.id_of("media/posts/b.jpg"), "same".to_owned())
        )
        .err(),
        Some(ArchiveError::Busy)
    );
    gate.open();
    assert!(handle.join().expect("join").is_ok());
}

// ------------------------------------------------- group 10 / F8: staging

/// The staging path must sit directly in the session's staging directory and
/// carry a `<uuid>-archive-staging.bin` name.
#[test]
fn staging_name_and_parent_are_enforced() {
    let h = open("staging-name", vec![instagram_like().build()]);
    let id = h.id_of(IMG);

    // Wrong name, right directory.
    let wrong_name = h.dir.path.join("payload.bin");
    std::fs::write(&wrong_name, b"").expect("write");
    assert_eq!(
        h.session
            .extract_blocking(
                &id,
                EntryKind::Image,
                wrong_name.to_str().expect("utf8"),
                &h.cancel
            )
            .err(),
        Some(ArchiveError::StagingUnavailable)
    );

    // Right name, wrong directory.
    let other = TempDir::new("staging-other");
    let elsewhere = other.staging(UUID_A);
    assert_eq!(
        h.session
            .extract_blocking(&id, EntryKind::Image, &elsewhere, &h.cancel)
            .err(),
        Some(ArchiveError::StagingUnavailable)
    );

    // Right name, right directory, but nested one level deeper.
    let nested = h.dir.path.join("sub");
    std::fs::create_dir_all(&nested).expect("mkdir");
    let nested_file = nested.join(format!("{UUID_A}-archive-staging.bin"));
    std::fs::write(&nested_file, b"").expect("write");
    assert_eq!(
        h.session
            .extract_blocking(
                &id,
                EntryKind::Image,
                nested_file.to_str().expect("utf8"),
                &h.cancel
            )
            .err(),
        Some(ArchiveError::StagingUnavailable)
    );
}

/// `create(false)`: Rust never creates the staging file, so a wipe that swept
/// it away mid-job is never undone.
#[test]
fn a_missing_staging_file_is_refused() {
    let h = open("staging-missing", vec![instagram_like().build()]);
    let id = h.id_of(IMG);
    let missing = h.dir.missing_staging(UUID_C);
    assert_eq!(
        h.session
            .extract_blocking(&id, EntryKind::Image, &missing, &h.cancel)
            .err(),
        Some(ArchiveError::StagingUnavailable)
    );
    assert!(
        !std::path::Path::new(&missing).exists(),
        "a refused staging path must not be created"
    );
}

/// F8: a symlink planted at the staging path is refused by `O_NOFOLLOW`. This
/// test also proves the hard-coded `O_NOFOLLOW` value is right for this
/// platform — without it, the open would succeed and write through the link.
#[test]
fn a_symlinked_staging_path_is_refused() {
    let h = open("staging-symlink", vec![instagram_like().build()]);
    let id = h.id_of(IMG);
    let victim = h.dir.path.join("victim.txt");
    std::fs::write(&victim, b"do not overwrite me").expect("write victim");
    let link = h.dir.path.join(format!("{UUID_B}-archive-staging.bin"));
    std::os::unix::fs::symlink(&victim, &link).expect("symlink");

    assert_eq!(
        h.session
            .extract_blocking(
                &id,
                EntryKind::Image,
                link.to_str().expect("utf8"),
                &h.cancel
            )
            .err(),
        Some(ArchiveError::StagingUnavailable)
    );
    assert_eq!(
        std::fs::read(&victim).expect("read victim"),
        b"do not overwrite me",
        "the symlink target must be untouched"
    );
}

/// F8: a hard link at the staging path is refused (`nlink != 1`), so another
/// process cannot keep a readable alias to the extracted bytes.
#[test]
fn a_hard_linked_staging_path_is_refused() {
    let h = open("staging-hardlink", vec![instagram_like().build()]);
    let id = h.id_of(IMG);
    let original = h.dir.path.join("alias.bin");
    std::fs::write(&original, b"").expect("write");
    let link = h.dir.path.join(format!("{UUID_C}-archive-staging.bin"));
    std::fs::hard_link(&original, &link).expect("hard link");

    assert_eq!(
        h.session
            .extract_blocking(
                &id,
                EntryKind::Image,
                link.to_str().expect("utf8"),
                &h.cancel
            )
            .err(),
        Some(ArchiveError::StagingUnavailable)
    );
}

/// F8: the live-staging reservation is taken under the same lock as the ceiling
/// check. A check-then-add would let both jobs below pass on the same headroom
/// and overshoot the ceiling by a whole kind cap per concurrent job.
#[test]
fn a_concurrent_reservation_cannot_overshoot_the_ceiling() {
    let body = vec![5u8; 4096];
    let zip = ZipBuilder::new()
        .stored("media/posts/a.jpg", &body)
        .stored("media/posts/b.jpg", &body)
        .build();
    // Room for one 4,096-byte extract, not two.
    let h = support::try_open_with_budgets(
        "reserve-race",
        vec![zip],
        orbital_archive_reader::testing::Budgets {
            live_staging: 6000,
            ..support::unbounded()
        },
    )
    .expect("opens");

    let gate = h.sources[0].install_gate();
    h.sources[0].reset_reads();

    let session = Arc::clone(&h.session);
    let first_id = h.id_of("media/posts/a.jpg");
    let first_path = h.dir.staging(UUID_A);
    let worker = std::thread::spawn(move || {
        block_on(session.extract_entry(first_id, EntryKind::Image, first_path, "job-a".to_owned()))
    });

    // Wait until the first job is inside a read, holding its reservation.
    let deadline = Instant::now() + Duration::from_secs(5);
    while h.sources[0].read_count() < 1 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        h.sources[0].read_count() >= 1,
        "the first job never started"
    );
    assert_eq!(h.session.live_staging_bytes(), 4096);

    let second = h.session.extract_blocking(
        &h.id_of("media/posts/b.jpg"),
        EntryKind::Image,
        &h.dir.staging(UUID_B),
        &h.cancel,
    );
    assert_eq!(second.err(), Some(ArchiveError::NoSpace));

    gate.open();
    assert!(matches!(
        worker.join().expect("join"),
        Ok(ExtractOutcome::Extracted { .. })
    ));

    // Releasing the first path makes exactly its bytes available again.
    h.session.release_staging(h.dir.staging_path(UUID_A));
    assert_eq!(h.session.live_staging_bytes(), 0);
    assert!(matches!(
        h.session.extract_blocking(
            &h.id_of("media/posts/b.jpg"),
            EntryKind::Image,
            &h.dir.staging(UUID_B),
            &h.cancel,
        ),
        Ok(ExtractOutcome::Extracted { .. })
    ));
}

/// `close()` must not wait for an in-flight `pread`. On iOS the descriptor can
/// be File-Provider-backed, so one read can stall for seconds, and `close()`
/// runs in `localWipe` phase 1.
#[test]
fn close_does_not_wait_for_a_parked_read() {
    let body = vec![7u8; 300 * 1024];
    let zip = ZipBuilder::new().stored(IMG, &body).build();
    let h = open("close-parked", vec![zip]);

    // Let the two local-header reads through and park the first DATA read, by
    // which point the staging file is open and the reservation is held.
    let gate = h.sources[0].install_gate_after(2);
    h.sources[0].reset_reads();

    let session = Arc::clone(&h.session);
    let id = h.id_of(IMG);
    let staging = h.dir.staging(UUID_A);
    let staging_path = staging.clone();
    let worker = std::thread::spawn(move || {
        block_on(session.extract_entry(id, EntryKind::Image, staging, "job-park".to_owned()))
    });

    let deadline = Instant::now() + Duration::from_secs(5);
    while h.sources[0].read_count() < 3 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        h.sources[0].read_count() >= 3,
        "the job never reached its data read"
    );
    assert_eq!(h.session.live_staging_bytes(), 300 * 1024);

    let started = Instant::now();
    h.session.close();
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_millis(250),
        "close() blocked for {elapsed:?} behind a parked read"
    );

    gate.open();
    let out = worker.join().expect("join");
    assert_eq!(
        out.err(),
        Some(ArchiveError::SessionClosed),
        "the parked job must unwind, not finish"
    );
    assert!(
        !std::path::Path::new(&staging_path).exists(),
        "the partial staging file must be unlinked"
    );
    assert!(h.staging_residue().is_empty());
    assert_eq!(h.session.live_staging_bytes(), 0);
}

/// A changed part is detected by its fingerprint on resume, and names the part
/// index (a count, not a name).
#[test]
fn a_changed_part_is_detected_on_resume() {
    let original = instagram_like().build();
    let changed = instagram_like()
        .stored("media/posts/extra.jpg", JPG)
        .build();

    let h = open("fp", vec![original]);
    let fp = h.session.parts().first().expect("part").fp.clone();

    let dir = TempDir::new("fp-resume");
    let src = MemSource::new(changed);
    let flag = CancelFlag::new();
    let err = orbital_archive_reader::ArchiveSession::open_with_sources(
        vec![orbital_archive_reader::testing::PartSourceInput {
            src: Box::new(support::SharedSource(src)),
            file_id: "1:0".to_owned(),
            expected_fp: Some(fp.clone()),
        }],
        dir.as_str(),
        &flag,
    )
    .err();
    assert_eq!(err, Some(ArchiveError::Changed { part_index: 0 }));

    // The unchanged file still resumes.
    let same = MemSource::new(instagram_like().build());
    assert!(
        orbital_archive_reader::ArchiveSession::open_with_sources(
            vec![orbital_archive_reader::testing::PartSourceInput {
                src: Box::new(support::SharedSource(same)),
                file_id: "1:0".to_owned(),
                expected_fp: Some(fp),
            }],
            dir.as_str(),
            &flag,
        )
        .is_ok()
    );
}

/// A non-UTF-8 JSON body is a skip, not a lossy decode.
#[test]
fn non_utf8_json_is_skipped() {
    let zip = ZipBuilder::new()
        .with(EntrySpec::stored(JSON, b"{\"a\":\"\xFF\xFE\"}"))
        .build();
    let h = open("json-utf8", vec![zip]);
    assert!(matches!(
        h.read_json(JSON),
        Ok(JsonOutcome::Skipped {
            skip: orbital_archive_reader::EntrySkipCode::EntryNotUtf8
        })
    ));
}
