//! Shared harness for the hostile matrix.

#![allow(dead_code)]

pub mod zipgen;

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Wake, Waker};

use orbital_archive_reader::testing::{CancelFlag, PartSourceInput, Source};
use orbital_archive_reader::{ArchiveError, ArchiveSession, EntryKind, EntrySkipCode};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Self-cleaning temporary directory (no `tempfile` dev-dependency: the crate's
/// dependency set is invariant-pinned and kept to four crates).
pub struct TempDir {
    pub path: PathBuf,
}

impl TempDir {
    #[must_use]
    pub fn new(tag: &str) -> Self {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "oar-{tag}-{}-{n}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&path).expect("create temp dir");
        Self {
            path: path.canonicalize().expect("canonicalize temp dir"),
        }
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        self.path.to_str().expect("utf8 temp dir")
    }

    /// Creates a staging file the way the native glue would, and returns its
    /// path. Rust opens it with `create(false)`.
    #[must_use]
    pub fn staging(&self, uuid: &str) -> String {
        let p = self.path.join(format!("{uuid}-archive-staging.bin"));
        std::fs::write(&p, b"").expect("create staging file");
        p.to_str().expect("utf8 staging path").to_owned()
    }

    /// A staging path that was never created (exercises `create(false)`).
    #[must_use]
    pub fn missing_staging(&self, uuid: &str) -> String {
        self.path
            .join(format!("{uuid}-archive-staging.bin"))
            .to_str()
            .expect("utf8")
            .to_owned()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

pub const UUID_A: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
pub const UUID_B: &str = "11111111-2222-3333-4444-555555555555";
pub const UUID_C: &str = "0a0a0a0a-0b0b-0c0c-0d0d-0e0e0e0e0e0e";

/// In-memory `Source` that records every read range and can fail from a given
/// offset onwards.
pub struct MemSource {
    bytes: Vec<u8>,
    reads: Mutex<Vec<(u64, u64)>>,
    fail_from: Option<u64>,
    /// Trips a cancel flag once this many reads have been served. Makes
    /// cancellation deterministic instead of time-dependent.
    cancel_after: Mutex<Option<(usize, CancelFlag)>>,
    /// When present, every read blocks until the gate is opened, so a job can
    /// be held mid-read while another call is made.
    gate: Mutex<Option<Arc<Gate>>>,
}

/// A one-shot open/closed gate.
#[derive(Default)]
pub struct Gate {
    open: Mutex<bool>,
    cv: std::sync::Condvar,
}

impl Gate {
    #[must_use]
    pub fn closed() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn open(&self) {
        *self.open.lock().expect("gate lock") = true;
        self.cv.notify_all();
    }

    fn wait(&self) {
        let mut g = self.open.lock().expect("gate lock");
        while !*g {
            g = self.cv.wait(g).expect("gate wait");
        }
    }
}

impl MemSource {
    #[must_use]
    pub fn new(bytes: Vec<u8>) -> Arc<Self> {
        Arc::new(Self {
            bytes,
            reads: Mutex::new(Vec::new()),
            fail_from: None,
            cancel_after: Mutex::new(None),
            gate: Mutex::new(None),
        })
    }

    #[must_use]
    pub fn failing_from(bytes: Vec<u8>, offset: u64) -> Arc<Self> {
        Arc::new(Self {
            bytes,
            reads: Mutex::new(Vec::new()),
            fail_from: Some(offset),
            cancel_after: Mutex::new(None),
            gate: Mutex::new(None),
        })
    }

    /// Cancels `flag` once `n` further reads have been served.
    pub fn cancel_after(&self, n: usize, flag: &CancelFlag) {
        *self.cancel_after.lock().expect("lock") = Some((n, flag.clone()));
    }

    /// Blocks every subsequent read until the returned gate is opened.
    #[must_use]
    pub fn install_gate(&self) -> Arc<Gate> {
        let gate = Gate::closed();
        *self.gate.lock().expect("lock") = Some(Arc::clone(&gate));
        gate
    }

    pub fn reset_reads(&self) {
        self.reads.lock().expect("reads lock").clear();
    }

    /// Reads performed so far, as `(offset, len)` pairs.
    #[must_use]
    pub fn reads(&self) -> Vec<(u64, u64)> {
        self.reads.lock().expect("reads lock").clone()
    }

    #[must_use]
    pub fn read_count(&self) -> usize {
        self.reads.lock().expect("reads lock").len()
    }

    /// Total bytes read so far.
    #[must_use]
    pub fn bytes_read(&self) -> u64 {
        self.reads().iter().map(|&(_, n)| n).sum()
    }

    /// `true` when some read overlapped `[start, end)`.
    #[must_use]
    pub fn touched(&self, start: u64, end: u64) -> bool {
        self.reads()
            .iter()
            .any(|&(off, len)| off < end && off.saturating_add(len) > start)
    }
}

impl Source for MemSource {
    fn read_exact_at(&self, buf: &mut [u8], offset: u64) -> Result<(), ArchiveError> {
        let len = u64::try_from(buf.len()).unwrap_or(u64::MAX);
        let served = {
            let mut r = self.reads.lock().expect("reads lock");
            r.push((offset, len));
            r.len()
        };
        let gate = self.gate.lock().expect("lock").clone();
        if let Some(g) = gate {
            g.wait();
        }
        if let Some((n, flag)) = self.cancel_after.lock().expect("lock").as_ref()
            && served >= *n
        {
            flag.cancel();
        }
        if let Some(fail) = self.fail_from
            && offset.saturating_add(len) > fail
        {
            return Err(ArchiveError::ReadFailed);
        }
        let start = usize::try_from(offset).map_err(|_| ArchiveError::ReadFailed)?;
        let end = start
            .checked_add(buf.len())
            .ok_or(ArchiveError::ReadFailed)?;
        let src = self
            .bytes
            .get(start..end)
            .ok_or(ArchiveError::ReadFailed)?;
        buf.copy_from_slice(src);
        Ok(())
    }

    fn len(&self) -> u64 {
        u64::try_from(self.bytes.len()).unwrap_or(u64::MAX)
    }
}

/// Newtype so a shared `MemSource` can be handed to the session (the orphan
/// rule forbids `impl Source for Arc<MemSource>`).
pub struct SharedSource(pub Arc<MemSource>);

impl Source for SharedSource {
    fn read_exact_at(&self, buf: &mut [u8], offset: u64) -> Result<(), ArchiveError> {
        self.0.read_exact_at(buf, offset)
    }

    fn len(&self) -> u64 {
        self.0.len()
    }
}

/// One open session plus the sources behind it.
pub struct Harness {
    pub session: Arc<ArchiveSession>,
    pub dir: TempDir,
    pub sources: Vec<Arc<MemSource>>,
    pub cancel: CancelFlag,
}

fn part_inputs(sources: &[Arc<MemSource>]) -> Vec<PartSourceInput> {
    sources
        .iter()
        .enumerate()
        .map(|(i, s)| PartSourceInput {
            src: Box::new(SharedSource(Arc::clone(s))),
            file_id: format!("1:{i}"),
            expected_fp: None,
        })
        .collect()
}

/// Opens a session over in-memory parts.
pub fn try_open(tag: &str, parts: Vec<Vec<u8>>) -> Result<Harness, ArchiveError> {
    try_open_with_budgets(tag, parts, u64::MAX, u64::MAX)
}

pub fn try_open_with_budgets(
    tag: &str,
    parts: Vec<Vec<u8>>,
    max_session_bytes: u64,
    max_live_staging: u64,
) -> Result<Harness, ArchiveError> {
    let dir = TempDir::new(tag);
    let sources: Vec<Arc<MemSource>> = parts.into_iter().map(MemSource::new).collect();
    let cancel = CancelFlag::new();
    let session = ArchiveSession::open_with_sources_and_budgets(
        part_inputs(&sources),
        dir.as_str(),
        &cancel,
        max_session_bytes,
        max_live_staging,
    )?;
    Ok(Harness {
        session,
        dir,
        sources,
        cancel,
    })
}

/// Opens a session and panics on failure.
#[must_use]
pub fn open(tag: &str, parts: Vec<Vec<u8>>) -> Harness {
    try_open(tag, parts).expect("archive should open")
}

/// Opens a session over sources the caller built (failing, recording, ...).
pub fn try_open_sources(
    tag: &str,
    sources: Vec<Arc<MemSource>>,
) -> Result<Harness, ArchiveError> {
    let dir = TempDir::new(tag);
    let cancel = CancelFlag::new();
    let session =
        ArchiveSession::open_with_sources(part_inputs(&sources), dir.as_str(), &cancel)?;
    Ok(Harness {
        session,
        dir,
        sources,
        cancel,
    })
}

impl Harness {
    /// Entry id of the single listed entry whose path equals `path`.
    #[must_use]
    pub fn id_of(&self, path: &str) -> String {
        self.session
            .entries()
            .into_iter()
            .find(|e| e.path == path)
            .unwrap_or_else(|| panic!("no listed entry for {path}"))
            .entry_id
    }

    #[must_use]
    pub fn skip_of(&self, path: &str) -> Option<EntrySkipCode> {
        self.session
            .entries()
            .into_iter()
            .find(|e| e.path == path)
            .unwrap_or_else(|| panic!("no listed entry for {path}"))
            .skip
    }

    #[must_use]
    pub fn paths(&self) -> Vec<String> {
        self.session.entries().into_iter().map(|e| e.path).collect()
    }

    #[must_use]
    pub fn rejected(&self, code: EntrySkipCode) -> u64 {
        self.session
            .rejected_counts()
            .into_iter()
            .find(|r| r.code == code)
            .map_or(0, |r| r.count)
    }

    /// Extracts `path` into a fresh staging file.
    pub fn extract(
        &self,
        path: &str,
        kind: EntryKind,
    ) -> Result<orbital_archive_reader::ExtractOutcome, ArchiveError> {
        let id = self.id_of(path);
        let staging = self.dir.staging(UUID_A);
        self.session
            .extract_blocking(&id, kind, &staging, &self.cancel)
    }

    pub fn read_json(
        &self,
        path: &str,
    ) -> Result<orbital_archive_reader::JsonOutcome, ArchiveError> {
        let id = self.id_of(path);
        self.session.read_json_blocking(&id, &self.cancel)
    }

    pub fn peek(&self, path: &str) -> Result<orbital_archive_reader::PeekOutcome, ArchiveError> {
        let id = self.id_of(path);
        self.session.peek_head_blocking(&id, &self.cancel)
    }

    /// Files left in the staging directory.
    #[must_use]
    pub fn staging_residue(&self) -> Vec<String> {
        let mut out = Vec::new();
        if let Ok(rd) = std::fs::read_dir(&self.dir.path) {
            for e in rd.flatten() {
                out.push(e.file_name().to_string_lossy().into_owned());
            }
        }
        out.sort();
        out
    }
}

/// Reads the whole staging file produced by an extract.
#[must_use]
pub fn read_file(path: &str) -> Vec<u8> {
    std::fs::read(Path::new(path)).unwrap_or_default()
}

struct ThreadWaker(std::thread::Thread);

impl Wake for ThreadWaker {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }
}

/// Minimal executor, standing in for uniffi's foreign poller. Proves the
/// `blocking.rs` futures work with no tokio anywhere.
pub fn block_on<F: Future>(fut: F) -> F::Output {
    let mut fut = Box::pin(fut);
    let waker = Waker::from(Arc::new(ThreadWaker(std::thread::current())));
    let mut cx = Context::from_waker(&waker);
    loop {
        if let Poll::Ready(v) = fut.as_mut().poll(&mut cx) {
            return v;
        }
        std::thread::park_timeout(std::time::Duration::from_millis(20));
    }
}
