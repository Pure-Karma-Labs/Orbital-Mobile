//! The session object: listing, indexes, job registry and byte budgets.
//!
//! Everything derived from archive content is computed once at open and then
//! immutable, so concurrent jobs share it without a lock. Only the budgets, the
//! staging ledger and the job registry are mutable, behind one `Mutex`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use crate::allowlist::{self, Verdict};
use crate::cancel::{CancelFlag, CancelToken};
use crate::cdir::{CdReader, CdRecord};
use crate::eocd;
use crate::error::{ArchiveError, ArchiveResult, EntryFault};
use crate::extract::{self, NullSink, StreamLimits};
use crate::fd;
use crate::limits::{
    HEAD_PEEK_BYTES, MAX_CD_RECORDS_PER_SESSION, MAX_JOBS, MAX_JSON_BYTES,
    MAX_LISTED_ENTRIES_PER_SESSION, MAX_LIVE_STAGING_BYTES, MAX_PARTS, MAX_RETAINED_PATH_BYTES,
    MAX_SESSION_BYTES_WRITTEN, MIB, kind_cap,
};
use crate::local::{self, DataSpan};
use crate::num::{to_u64, to_usize};
use crate::path as epath;
use crate::source::{ClosableSource, FileSource, Source};
use crate::staging::{self, StagingFile};
use crate::types::{
    ArchiveEntry, ArchivePartInfo, ArchivePartInput, EntryKind, EntrySkipCode, ExtractOutcome,
    JsonOutcome, PeekOutcome, RejectedCount, UriResolution, UriSkipCode,
};

/// One part, as handed to the listing. Public (with `Source`) so the host-side
/// hostile matrix can inject recording and failing sources without a dev-time
/// path dependency, which the security invariants forbid.
pub struct PartSourceInput {
    pub src: Box<dyn Source>,
    pub file_id: String,
    pub expected_fp: Option<String>,
}

/// Session-wide ceilings.
///
/// Production always uses `Budgets::default()`, which is the `limits.rs` table.
/// The host matrix overrides them so a 8 GiB budget, a 512 MiB ceiling and a
/// 2-million-record bound can be exercised in milliseconds instead of being
/// asserted only by reading the code.
#[derive(Debug, Clone, Copy)]
pub struct Budgets {
    pub session_bytes: u64,
    pub live_staging: u64,
    pub cd_records: u64,
    pub retained_path_bytes: u64,
}

impl Default for Budgets {
    fn default() -> Self {
        Self {
            session_bytes: MAX_SESSION_BYTES_WRITTEN,
            live_staging: MAX_LIVE_STAGING_BYTES,
            cd_records: MAX_CD_RECORDS_PER_SESSION,
            retained_path_bytes: MAX_RETAINED_PATH_BYTES,
        }
    }
}

struct PartState {
    index: u32,
    src: ClosableSource,
    fp: String,
    file_id: String,
    byte_length: u64,
    cd_offset: u64,
    lh_offsets: Vec<u64>,
}

struct EntryState {
    entry_id: String,
    part: usize,
    rec: CdRecord,
    path: String,
    kind: EntryKind,
    skip: Option<EntrySkipCode>,
}

#[derive(Default)]
struct Mutables {
    closed: bool,
    /// Bytes actually written to staging files so far.
    bytes_written: u64,
    /// Bytes promised to in-flight extracts but not yet written. Together with
    /// `bytes_written` this makes the session byte budget a true reservation
    /// rather than a snapshot: four concurrent jobs cannot each read the same
    /// headroom and collectively overshoot it.
    session_reserved: u64,
    /// Sum of `staging`'s values, kept in step with it under the same lock.
    live_staging: u64,
    /// Bytes outstanding per staging LEDGER KEY (the validated, lowercased leaf
    /// name — see `staging::ledger_key`, never the caller's raw path): reserved
    /// before the extract starts, corrected to the real size on success,
    /// dropped on skip, error or `release_staging`. Rust owns this number so a
    /// caller cannot widen the ceiling by releasing a count it made up.
    staging: HashMap<String, u64>,
    jobs: HashMap<String, CancelFlag>,
}

/// Immutable listing plus mutable budgets. Held behind an `Arc` so a blocking
/// job can own a clone without borrowing the uniffi object.
pub struct SessionCore {
    parts: Vec<PartState>,
    entries: Vec<EntryState>,
    by_id: HashMap<String, usize>,
    /// Basename -> entry indices. There is deliberately no second index keyed
    /// on the full path: an exact match is found by filtering this bucket, and
    /// a full-path index would retain one more copy of every path (up to
    /// ~100 MB for a hostile export of long-named entries) to answer a question
    /// the basename bucket already answers.
    basename_index: HashMap<String, Vec<usize>>,
    rejected: Vec<RejectedCount>,
    staging_dir: PathBuf,
    budgets: Budgets,
    state: Mutex<Mutables>,
}

fn guard(m: &Mutex<Mutables>) -> MutexGuard<'_, Mutables> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Removes a job from the registry when the call returns, on every path.
struct JobGuard {
    core: Arc<SessionCore>,
    job_id: String,
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        guard(&self.core.state).jobs.remove(&self.job_id);
    }
}

/// Holds one extract's live-staging and session-byte reservations.
///
/// Dropping without `commit` releases both, so every skip, error, cancel and
/// panic path reconciles the ledgers without a bespoke branch.
struct StagingReservation<'a> {
    core: &'a SessionCore,
    key: String,
    /// Bytes promised to the session budget by this reservation.
    promised: u64,
    /// Session headroom left for this job once every other reservation is
    /// accounted for. Used as the in-loop backstop.
    remaining: u64,
    active: bool,
}

impl StagingReservation<'_> {
    /// Keeps the staging reservation, corrected to the bytes actually written,
    /// and releases the session promise. From here the caller owns the staging
    /// entry until `release_staging(path)`.
    fn commit(mut self, actual: u64) {
        self.core
            .finish_reservation(&self.key, self.promised, actual);
        self.active = false;
    }
}

impl Drop for StagingReservation<'_> {
    fn drop(&mut self) {
        if self.active {
            self.core.cancel_reservation(&self.key, self.promised);
        }
    }
}

/// What kind an entry must be for the operation being attempted.
#[derive(Debug, Clone, Copy)]
enum KindRequest {
    /// F1: a peek is allowed for json and image kinds only.
    PeekJsonOrImage,
    Json,
    Exact(EntryKind),
}

/// Outcome of the shared pre-read checks.
enum Checked<'a> {
    Ready { entry: &'a EntryState, cap: u64 },
    Skipped(EntrySkipCode),
}

/// Outcome of local-header verification.
enum Located<'a> {
    Ready { part: &'a PartState, span: DataSpan },
    Skipped(EntrySkipCode),
}

impl SessionCore {
    fn register_job(core: &Arc<Self>, job_id: &str) -> ArchiveResult<(CancelFlag, JobGuard)> {
        let mut st = guard(&core.state);
        if st.closed {
            return Err(ArchiveError::SessionClosed);
        }
        if st.jobs.contains_key(job_id) {
            return Err(ArchiveError::Busy);
        }
        if st.jobs.len() >= MAX_JOBS {
            return Err(ArchiveError::Busy);
        }
        let flag = CancelFlag::new();
        st.jobs.insert(job_id.to_owned(), flag.clone());
        drop(st);
        Ok((
            flag,
            JobGuard {
                core: Arc::clone(core),
                job_id: job_id.to_owned(),
            },
        ))
    }

    fn entry(&self, entry_id: &str) -> ArchiveResult<&EntryState> {
        self.by_id
            .get(entry_id)
            .and_then(|&i| self.entries.get(i))
            .ok_or(ArchiveError::Internal)
    }

    fn part(&self, index: usize) -> ArchiveResult<&PartState> {
        self.parts.get(index).ok_or(ArchiveError::Internal)
    }

    fn charge_bytes(&self, n: u64) {
        if n == 0 {
            return;
        }
        let mut st = guard(&self.state);
        st.bytes_written = st.bytes_written.saturating_add(n);
    }

    // ---- staging ledger (F8) --------------------------------------------

    /// Reserves `bytes` against BOTH the live-staging ceiling and the session
    /// byte budget, atomically with their checks. Four concurrent jobs each
    /// checking and then adding would let either bound overshoot by up to one
    /// kind cap per job.
    fn reserve_staging(&self, path: &str, bytes: u64) -> ArchiveResult<StagingReservation<'_>> {
        let key = staging::ledger_key(path)?;
        let mut st = guard(&self.state);
        if st.closed {
            return Err(ArchiveError::SessionClosed);
        }
        if st.staging.contains_key(&key) {
            // Two jobs extracting into one staging file would race on the file
            // and on the ledger. That is a caller bug, not a transient
            // condition, so it is not `Busy`: retrying cannot help.
            return Err(ArchiveError::StagingInUse);
        }
        let live = st.live_staging.saturating_add(bytes);
        if live > self.budgets.live_staging {
            return Err(ArchiveError::NoSpace);
        }
        let committed = st.bytes_written.saturating_add(st.session_reserved);
        if committed.saturating_add(bytes) > self.budgets.session_bytes {
            return Err(ArchiveError::SessionBytesExceeded);
        }
        st.live_staging = live;
        st.session_reserved = st.session_reserved.saturating_add(bytes);
        st.staging.insert(key.clone(), bytes);
        let remaining = self.budgets.session_bytes.saturating_sub(committed);
        drop(st);
        Ok(StagingReservation {
            core: self,
            key,
            promised: bytes,
            remaining,
            active: true,
        })
    }

    /// Success: the staging entry stays, corrected to the real size, and the
    /// session promise is released (the bytes are already charged).
    fn finish_reservation(&self, key: &str, promised: u64, actual: u64) {
        let mut st = guard(&self.state);
        st.session_reserved = st.session_reserved.saturating_sub(promised);
        let Some(&reserved) = st.staging.get(key) else {
            return;
        };
        st.staging.insert(key.to_owned(), actual);
        st.live_staging = st
            .live_staging
            .saturating_sub(reserved)
            .saturating_add(actual);
    }

    /// Skip, error, cancel or panic: both reservations go back.
    fn cancel_reservation(&self, key: &str, promised: u64) {
        let mut st = guard(&self.state);
        st.session_reserved = st.session_reserved.saturating_sub(promised);
        if let Some(bytes) = st.staging.remove(key) {
            st.live_staging = st.live_staging.saturating_sub(bytes);
        }
    }

    fn release_path(&self, path: &str) {
        // A path with no valid ledger key was never reserved, so there is
        // nothing to release and nothing to report.
        let Ok(key) = staging::ledger_key(path) else {
            return;
        };
        let mut st = guard(&self.state);
        if let Some(bytes) = st.staging.remove(&key) {
            st.live_staging = st.live_staging.saturating_sub(bytes);
        }
    }

    // ---- shared prologue -------------------------------------------------

    /// Every check that can be made without reading entry data, in one place.
    ///
    /// All three job bodies run this, so the order — listing skip, then kind,
    /// then cap, then the central-directory precheck — cannot drift between
    /// them. A new operation gets the same gauntlet by construction.
    fn check_entry(&self, entry_id: &str, want: KindRequest) -> ArchiveResult<Checked<'_>> {
        let entry = self.entry(entry_id)?;
        if let Some(skip) = entry.skip {
            return Ok(Checked::Skipped(skip));
        }
        let cap = match want {
            KindRequest::PeekJsonOrImage => {
                // Video entries, identified by extension, are never opened.
                match kind_cap(entry.kind) {
                    Some(cap) => cap,
                    None => return Ok(Checked::Skipped(EntrySkipCode::EntryKindNotEnabled)),
                }
            }
            KindRequest::Json => {
                if entry.kind != EntryKind::Json {
                    return Ok(Checked::Skipped(EntrySkipCode::EntryKindMismatch));
                }
                kind_cap(EntryKind::Json)
                    .ok_or(ArchiveError::Internal)?
                    .min(MAX_JSON_BYTES)
            }
            KindRequest::Exact(kind) => {
                if entry.kind != kind {
                    return Ok(Checked::Skipped(EntrySkipCode::EntryKindMismatch));
                }
                match kind_cap(kind) {
                    Some(cap) => cap,
                    None => return Ok(Checked::Skipped(EntrySkipCode::EntryKindNotEnabled)),
                }
            }
        };
        if let Err(skip) = extract::precheck(&entry.rec, cap) {
            return Ok(Checked::Skipped(skip));
        }
        Ok(Checked::Ready { entry, cap })
    }

    /// Verifies the local header and returns where the data is.
    fn locate(&self, entry: &EntryState) -> ArchiveResult<Located<'_>> {
        let part = self.part(entry.part)?;
        match local::verify(&part.src, &entry.rec, &part.lh_offsets, part.cd_offset) {
            Ok(span) => Ok(Located::Ready { part, span }),
            Err(EntryFault::Skip(skip)) => Ok(Located::Skipped(skip)),
            Err(EntryFault::Fatal(e)) => Err(e),
        }
    }

    // ---- job bodies (run on a blocking worker thread) -------------------

    fn do_peek_head(&self, entry_id: &str, cancel: &CancelFlag) -> ArchiveResult<PeekOutcome> {
        let (entry, cap) = match self.check_entry(entry_id, KindRequest::PeekJsonOrImage)? {
            Checked::Ready { entry, cap } => (entry, cap),
            Checked::Skipped(skip) => return Ok(PeekOutcome::Skipped { skip }),
        };
        let (part, span) = match self.locate(entry)? {
            Located::Ready { part, span } => (part, span),
            Located::Skipped(skip) => return Ok(PeekOutcome::Skipped { skip }),
        };
        let limits = StreamLimits {
            declared: entry.rec.uncomp_size,
            cap,
            // Not charged to the session byte budget (F1).
            session_remaining: u64::MAX,
            max_output: Some(to_u64(HEAD_PEEK_BYTES)),
        };
        let mut sink = NullSink;
        let mut written = 0u64;
        match extract::stream_entry(
            &part.src,
            span,
            &entry.rec,
            &limits,
            cancel,
            &mut sink,
            &mut written,
        ) {
            Ok(out) => Ok(PeekOutcome::Head { head: out.head }),
            Err(EntryFault::Skip(skip)) => Ok(PeekOutcome::Skipped { skip }),
            Err(EntryFault::Fatal(e)) => Err(e),
        }
    }

    fn do_read_json(&self, entry_id: &str, cancel: &CancelFlag) -> ArchiveResult<JsonOutcome> {
        let (entry, cap) = match self.check_entry(entry_id, KindRequest::Json)? {
            Checked::Ready { entry, cap } => (entry, cap),
            Checked::Skipped(skip) => return Ok(JsonOutcome::Skipped { skip }),
        };
        let (part, span) = match self.locate(entry)? {
            Located::Ready { part, span } => (part, span),
            Located::Skipped(skip) => return Ok(JsonOutcome::Skipped { skip }),
        };
        let limits = StreamLimits {
            declared: entry.rec.uncomp_size,
            cap,
            session_remaining: u64::MAX,
            max_output: None,
        };
        // Pre-sized to the declared length, but never beyond 1 MiB: a honest
        // 32 MiB JSON reaches that size by doubling a handful of times, while
        // an archive that merely CLAIMS 32 MiB and carries ten bytes cannot
        // make us allocate 32 MiB per attempt.
        let presize = entry.rec.uncomp_size.min(cap).min(MIB);
        let mut buf: Vec<u8> = Vec::with_capacity(to_usize(presize)?);
        let mut written = 0u64;
        match extract::stream_entry(
            &part.src,
            span,
            &entry.rec,
            &limits,
            cancel,
            &mut buf,
            &mut written,
        ) {
            Ok(_) => {}
            Err(EntryFault::Skip(skip)) => return Ok(JsonOutcome::Skipped { skip }),
            Err(EntryFault::Fatal(e)) => return Err(e),
        }
        // F4: cancellation is checked between the read and the decode, so an
        // aborted 32 MiB JSON does not pay for a UTF-8 validation pass.
        cancel.check()?;
        match String::from_utf8(buf) {
            Ok(text) => Ok(JsonOutcome::Text { text }),
            Err(_) => Ok(JsonOutcome::Skipped {
                skip: EntrySkipCode::EntryNotUtf8,
            }),
        }
    }

    fn do_extract(
        &self,
        entry_id: &str,
        kind: EntryKind,
        staging_path: &str,
        cancel: &CancelFlag,
    ) -> ArchiveResult<ExtractOutcome> {
        let (entry, cap) = match self.check_entry(entry_id, KindRequest::Exact(kind))? {
            Checked::Ready { entry, cap } => (entry, cap),
            Checked::Skipped(skip) => return Ok(ExtractOutcome::Skipped { skip }),
        };

        // Reserve before any I/O, so four concurrent jobs cannot each pass the
        // ceiling check on the same headroom.
        let reservation = self.reserve_staging(staging_path, entry.rec.uncomp_size.min(cap))?;

        let (part, span) = match self.locate(entry)? {
            Located::Ready { part, span } => (part, span),
            Located::Skipped(skip) => return Ok(ExtractOutcome::Skipped { skip }),
        };

        let mut file = StagingFile::open(staging_path, &self.staging_dir)?;
        let limits = StreamLimits {
            declared: entry.rec.uncomp_size,
            cap,
            // Exact: the budget minus what is written and what every other
            // in-flight job has promised.
            session_remaining: reservation.remaining,
            max_output: None,
        };
        let mut written = 0u64;
        let streamed = extract::stream_entry(
            &part.src,
            span,
            &entry.rec,
            &limits,
            cancel,
            &mut file,
            &mut written,
        );
        // Charged on EVERY path. Bytes written and then thrown away still cost
        // the device a write, so a CRC skip, a magic skip or a ratio skip has
        // to count against the session budget or a small archive can drive
        // unbounded write-then-unlink churn.
        self.charge_bytes(written);

        let outcome = match streamed {
            Ok(o) => o,
            // `file` is dropped here, which truncates and unlinks the partial
            // output, and `reservation` is dropped, which frees the ceiling.
            Err(EntryFault::Skip(skip)) => return Ok(ExtractOutcome::Skipped { skip }),
            Err(EntryFault::Fatal(e)) => return Err(e),
        };
        let finished = file.finish()?;
        reservation.commit(finished);

        Ok(ExtractOutcome::Extracted {
            path: staging_path.to_owned(),
            byte_length: outcome.byte_length,
            head: outcome.head,
        })
    }
}

/// uniffi handle for one open archive.
#[derive(uniffi::Object)]
pub struct ArchiveSession {
    core: Arc<SessionCore>,
}

#[uniffi::export]
impl ArchiveSession {
    /// Every allowlisted entry, in part order then central-directory order.
    pub fn entries(&self) -> Vec<ArchiveEntry> {
        self.core
            .entries
            .iter()
            .map(|e| ArchiveEntry {
                entry_id: e.entry_id.clone(),
                path: e.path.clone(),
                kind: e.kind,
                declared_size: e.rec.uncomp_size,
                skip: e.skip,
            })
            .collect()
    }

    /// Refreshed part identities. `#926` persists these for resume.
    pub fn parts(&self) -> Vec<ArchivePartInfo> {
        self.core
            .parts
            .iter()
            .map(|p| ArchivePartInfo {
                index: p.index,
                fp: p.fp.clone(),
                byte_length: p.byte_length,
                file_id: p.file_id.clone(),
            })
            .collect()
    }

    /// Aggregated rejection counts: rejected allowlisted entries plus
    /// non-allowlisted records, which are counted and never named (F6).
    pub fn rejected_counts(&self) -> Vec<RejectedCount> {
        self.core.rejected.clone()
    }

    /// Batch URI resolution. O(1) per URI against indexes built at listing
    /// time; call once per parsed JSON file (F7).
    pub fn resolve_media_uris(&self, uris: Vec<String>) -> Vec<UriResolution> {
        uris.iter().map(|u| self.core.resolve_one(u)).collect()
    }

    /// Releases one extracted staging path from the live-staging ceiling (F8).
    ///
    /// Takes the path, not a byte count: Rust knows how many bytes it wrote, and
    /// a caller-supplied number would let a double release (or a padded one)
    /// silently disable the ceiling. Idempotent, and a path this session never
    /// extracted is a no-op. The TS service calls it in the same `finally` that
    /// unlinks the file.
    pub fn release_staging(&self, staging_path: String) {
        self.core.release_path(&staging_path);
    }

    /// Cancels one in-flight job. Synchronous and lock-free enough for
    /// `localWipe` phase 1.
    pub fn cancel(&self, job_id: String) {
        if let Some(flag) = guard(&self.core.state).jobs.get(&job_id) {
            flag.cancel();
        }
    }

    /// Cancels every job, releases this crate's descriptor dups, and refuses
    /// further work. Idempotent.
    ///
    /// The dups are dropped here rather than at uniffi destroy time: a session
    /// the app has finished with must not keep a file open across a `localWipe`
    /// just because the JS object has not been collected yet. The glue still
    /// owns the original fds and closes them at `closeParts` (F2). A job that is
    /// mid-read gets `SessionClosed` on its next read and unwinds normally.
    pub fn close(&self) {
        {
            let mut st = guard(&self.core.state);
            st.closed = true;
            for flag in st.jobs.values() {
                flag.cancel();
            }
        }
        for part in &self.core.parts {
            part.src.release();
        }
    }

    /// At most `HEAD_PEEK_BYTES` inflated bytes. No staging file, not charged
    /// to the session byte budget, json/image kinds only (F1).
    pub async fn peek_head(&self, entry_id: String, job_id: String) -> ArchiveResult<PeekOutcome> {
        let (flag, keep) = SessionCore::register_job(&self.core, &job_id)?;
        let core = Arc::clone(&self.core);
        crate::blocking::spawn_blocking(move || {
            let r = core.do_peek_head(&entry_id, &flag);
            drop(keep);
            r
        })
        .await
    }

    /// Decodes a JSON entry in memory as strict UTF-8. No file is written.
    pub async fn read_json(&self, entry_id: String, job_id: String) -> ArchiveResult<JsonOutcome> {
        let (flag, keep) = SessionCore::register_job(&self.core, &job_id)?;
        let core = Arc::clone(&self.core);
        crate::blocking::spawn_blocking(move || {
            let r = core.do_read_json(&entry_id, &flag);
            drop(keep);
            r
        })
        .await
    }

    /// Extracts one entry into a glue-created staging file. The caller unlinks
    /// `path` after consuming it, and calls `release_staging(path)`.
    pub async fn extract_entry(
        &self,
        entry_id: String,
        kind: EntryKind,
        staging_path: String,
        job_id: String,
    ) -> ArchiveResult<ExtractOutcome> {
        let (flag, keep) = SessionCore::register_job(&self.core, &job_id)?;
        let core = Arc::clone(&self.core);
        crate::blocking::spawn_blocking(move || {
            let r = core.do_extract(&entry_id, kind, &staging_path, &flag);
            drop(keep);
            r
        })
        .await
    }
}

impl ArchiveSession {
    /// Host-test entry point: open over injected sources.
    ///
    /// Not part of the FFI surface. It exists because the hostile matrix lives
    /// in `tests/` (integration targets) and must inject recording and failing
    /// sources, and because a dev-only path dependency on this crate is
    /// forbidden by the security invariants.
    #[doc(hidden)]
    pub fn open_with_sources(
        parts: Vec<PartSourceInput>,
        staging_dir: &str,
        cancel: &CancelFlag,
    ) -> ArchiveResult<Arc<Self>> {
        Self::open_with_sources_and_budgets(parts, staging_dir, cancel, Budgets::default())
    }

    /// Host-test entry point with overridable budgets.
    #[doc(hidden)]
    pub fn open_with_sources_and_budgets(
        parts: Vec<PartSourceInput>,
        staging_dir: &str,
        cancel: &CancelFlag,
        budgets: Budgets,
    ) -> ArchiveResult<Arc<Self>> {
        let core = build_core(parts, staging_dir, cancel, budgets)?;
        Ok(Arc::new(Self {
            core: Arc::new(core),
        }))
    }

    #[doc(hidden)]
    pub fn peek_head_blocking(
        &self,
        entry_id: &str,
        cancel: &CancelFlag,
    ) -> ArchiveResult<PeekOutcome> {
        self.core.do_peek_head(entry_id, cancel)
    }

    #[doc(hidden)]
    pub fn read_json_blocking(
        &self,
        entry_id: &str,
        cancel: &CancelFlag,
    ) -> ArchiveResult<JsonOutcome> {
        self.core.do_read_json(entry_id, cancel)
    }

    #[doc(hidden)]
    pub fn extract_blocking(
        &self,
        entry_id: &str,
        kind: EntryKind,
        staging_path: &str,
        cancel: &CancelFlag,
    ) -> ArchiveResult<ExtractOutcome> {
        self.core.do_extract(entry_id, kind, staging_path, cancel)
    }

    /// Bytes currently counted against the live-staging ceiling.
    #[doc(hidden)]
    #[must_use]
    pub fn live_staging_bytes(&self) -> u64 {
        guard(&self.core.state).live_staging
    }

    /// Bytes charged to the session budget so far.
    #[doc(hidden)]
    #[must_use]
    pub fn session_bytes_written(&self) -> u64 {
        guard(&self.core.state).bytes_written
    }
}

impl SessionCore {
    fn resolve_one(&self, uri: &str) -> UriResolution {
        let Some(norm) = allowlist::normalise_uri(uri) else {
            return UriResolution::Skipped {
                skip: UriSkipCode::UriInvalid,
            };
        };
        let Some(ext) = allowlist::extension_of(&norm) else {
            return UriResolution::Skipped {
                skip: UriSkipCode::UriUnsupportedKind,
            };
        };
        if allowlist::media_kind_for_ext(&ext).is_none() {
            return UriResolution::Skipped {
                skip: UriSkipCode::UriUnsupportedKind,
            };
        }
        // Decided from the string alone, with no read: a URI under a denied
        // root is refused before any lookup.
        if allowlist::starts_with_denied_root(&norm) {
            return UriResolution::Skipped {
                skip: UriSkipCode::UriOutsideAllowlist,
            };
        }
        // A URI that is itself a full allowlisted path resolves by exact match
        // first. One that is not (a relative URI from a JSON file, say) can
        // only resolve by suffix. Either way the lookup runs against the
        // listing indexes, which hold ONLY allowlisted, non-skipped entries —
        // so resolution can never name an entry the allowlist refused. That is
        // a structural guarantee, not a string check.
        let fully_allowlisted = matches!(allowlist::classify(&norm), Verdict::Listed(_));

        let basename = norm.rsplit('/').next().unwrap_or(&norm).to_owned();
        let candidates: &[usize] = self
            .basename_index
            .get(&basename)
            .map_or(&[], Vec::as_slice);

        // Exact match first, found by filtering the basename bucket: any entry
        // whose full path equals the URI necessarily shares its basename.
        if fully_allowlisted {
            let mut found: Option<usize> = None;
            let mut count = 0usize;
            for &idx in candidates {
                let Some(entry) = self.entries.get(idx) else {
                    continue;
                };
                if entry.path == norm {
                    count = count.saturating_add(1);
                    if found.is_none() {
                        found = Some(idx);
                    }
                }
            }
            if count > 0 {
                return match count {
                    1 => self.resolved(found),
                    _ => UriResolution::Skipped {
                        skip: UriSkipCode::UriAmbiguous,
                    },
                };
            }
        }

        let suffix = format!("/{norm}");
        let mut found: Option<usize> = None;
        let mut count = 0usize;
        for &idx in candidates {
            let Some(entry) = self.entries.get(idx) else {
                continue;
            };
            if entry.path.ends_with(&suffix) {
                count = count.saturating_add(1);
                if found.is_none() {
                    found = Some(idx);
                }
            }
        }
        match count {
            0 if fully_allowlisted => UriResolution::Skipped {
                skip: UriSkipCode::UriUnresolved,
            },
            0 => UriResolution::Skipped {
                skip: UriSkipCode::UriOutsideAllowlist,
            },
            1 => self.resolved(found),
            _ => UriResolution::Skipped {
                skip: UriSkipCode::UriAmbiguous,
            },
        }
    }

    fn resolved(&self, idx: Option<usize>) -> UriResolution {
        match idx.and_then(|i| self.entries.get(i)) {
            Some(e) => UriResolution::Resolved {
                entry_id: e.entry_id.clone(),
            },
            None => UriResolution::Skipped {
                skip: UriSkipCode::UriUnresolved,
            },
        }
    }
}

// ---- open / listing ----------------------------------------------------

/// Opens an archive from descriptors handed over by the native glue.
///
/// The fds are dup'd synchronously (cheap) and the listing runs on a worker
/// thread; `cancel` makes the whole open a cancellable job (F4).
#[uniffi::export]
pub async fn open_archive(
    parts: Vec<ArchivePartInput>,
    staging_dir: String,
    cancel: Arc<CancelToken>,
) -> ArchiveResult<Arc<ArchiveSession>> {
    if parts.is_empty() {
        return Err(ArchiveError::NotZip);
    }
    if parts.len() > MAX_PARTS {
        return Err(ArchiveError::TooManyParts);
    }
    let mut sources = Vec::with_capacity(parts.len());
    for (i, p) in parts.iter().enumerate() {
        let index = u32::try_from(i).map_err(|_| ArchiveError::TooManyParts)?;
        let adopted = fd::adopt(p.fd, p.byte_length, &p.file_id, index)?;
        sources.push(PartSourceInput {
            src: Box::new(FileSource::new(adopted.file, adopted.byte_length)),
            file_id: p.file_id.clone(),
            expected_fp: p.expected_fp.clone(),
        });
    }
    let flag = cancel.flag();
    crate::blocking::spawn_blocking(move || {
        let core = build_core(sources, &staging_dir, &flag, Budgets::default())?;
        Ok(Arc::new(ArchiveSession {
            core: Arc::new(core),
        }))
    })
    .await
}

struct PartListing {
    state: PartState,
    entries: Vec<EntryState>,
    rejected: HashMap<EntrySkipCode, u64>,
    /// Central-directory records parsed, allowlisted or not.
    cd_records: u64,
}

fn build_core(
    parts: Vec<PartSourceInput>,
    staging_dir: &str,
    cancel: &CancelFlag,
    budgets: Budgets,
) -> ArchiveResult<SessionCore> {
    if parts.is_empty() {
        return Err(ArchiveError::NotZip);
    }
    if parts.len() > MAX_PARTS {
        return Err(ArchiveError::TooManyParts);
    }
    let staging_dir = PathBuf::from(staging_dir)
        .canonicalize()
        .map_err(|_| ArchiveError::StagingUnavailable)?;

    let mut part_states = Vec::with_capacity(parts.len());
    let mut entries: Vec<EntryState> = Vec::new();
    let mut rejected: HashMap<EntrySkipCode, u64> = HashMap::new();
    let mut seen_file_ids: HashMap<String, ()> = HashMap::new();
    let mut seen_fps: HashMap<String, ()> = HashMap::new();
    let mut cd_records_total = 0u64;
    let mut retained_path_bytes = 0u64;

    for (i, part) in parts.into_iter().enumerate() {
        cancel.check()?;
        let index = u32::try_from(i).map_err(|_| ArchiveError::TooManyParts)?;
        // F6: duplicate parts are rejected by fileId first, then by full fp.
        if seen_file_ids.insert(part.file_id.clone(), ()).is_some() {
            return Err(ArchiveError::DuplicatePart);
        }
        let listing = list_part(part, index, cancel)?;
        if seen_fps.insert(listing.state.fp.clone(), ()).is_some() {
            return Err(ArchiveError::DuplicatePart);
        }
        cd_records_total = cd_records_total.saturating_add(listing.cd_records);
        if cd_records_total > budgets.cd_records {
            // The retained local-header offset vectors are what this bounds:
            // 64 parts x 1M records would be ~512 MB held for the life of the
            // session, which is a jetsam kill rather than an error.
            return Err(ArchiveError::TooManyEntries);
        }
        retained_path_bytes = retained_path_bytes.saturating_add(
            listing
                .entries
                .iter()
                .map(|e| to_u64(e.rec.name.len()).saturating_add(to_u64(e.path.len())))
                .sum(),
        );
        if retained_path_bytes > budgets.retained_path_bytes {
            // Long-named entries: the retained name + path strings are what a
            // hostile export inflates, not the entry count.
            return Err(ArchiveError::TooManyEntries);
        }
        for (code, n) in listing.rejected {
            *rejected.entry(code).or_insert(0) += n;
        }
        entries.extend(listing.entries);
        if entries.len() > MAX_LISTED_ENTRIES_PER_SESSION {
            return Err(ArchiveError::TooManyEntries);
        }
        part_states.push(listing.state);
    }

    mark_duplicates(&mut entries);

    for e in &entries {
        if let Some(code) = e.skip {
            *rejected.entry(code).or_insert(0) += 1;
        }
    }

    let mut by_id = HashMap::with_capacity(entries.len());
    let mut basename_index: HashMap<String, Vec<usize>> = HashMap::new();
    for (idx, e) in entries.iter().enumerate() {
        // Fail closed on a colliding id. `entry_id` is the resume key #926
        // persists, and a last-wins insert would silently point a stored id at
        // a different entry — in the near-duplicate-part case, at the twin that
        // dedup marked skipped, making media the member really has unreachable.
        // The id carries the full part fingerprint, so a collision means two
        // parts resolved to the same content identity and the session is not
        // trustworthy.
        if by_id.insert(e.entry_id.clone(), idx).is_some() {
            return Err(ArchiveError::DuplicatePart);
        }
        if e.skip.is_some() || e.kind == EntryKind::Json {
            continue;
        }
        let base = e.path.rsplit('/').next().unwrap_or(&e.path).to_owned();
        basename_index.entry(base).or_default().push(idx);
    }

    let mut rejected_counts: Vec<RejectedCount> = rejected
        .into_iter()
        .map(|(code, count)| RejectedCount { code, count })
        .collect();
    rejected_counts.sort_by_key(|r| format!("{:?}", r.code));

    Ok(SessionCore {
        parts: part_states,
        entries,
        by_id,
        basename_index,
        rejected: rejected_counts,
        staging_dir,
        budgets,
        state: Mutex::new(Mutables::default()),
    })
}

/// Two passes over the central directory.
///
/// Pass 1 computes the fingerprint, the local-header offset list and the
/// wrapper-strip decision (which needs to know that *every* file shares a first
/// segment). Pass 2 applies the strip and matches the allowlist. The CD is
/// re-read rather than buffered so memory stays bounded at 1 MiB.
fn list_part(part: PartSourceInput, index: u32, cancel: &CancelFlag) -> ArchiveResult<PartListing> {
    let src = part.src;
    let info = eocd::locate(src.as_ref(), cancel)?;
    if info.declared_entries > crate::limits::MAX_CD_ENTRIES_PER_PART {
        return Err(ArchiveError::TooManyEntries);
    }

    // ---- pass 1 ----
    let mut reader = CdReader::new(src.as_ref(), info.cd_offset, info.cd_size, cancel.clone())?;
    let mut tracker = epath::FirstSegmentTracker::default();
    let mut lh_offsets: Vec<u64> = Vec::new();
    while let Some(rec) = reader.next_record()? {
        lh_offsets.push(rec.lh_offset);
        if let Ok(valid) = epath::validate(&rec.name)
            && !valid.is_dir
        {
            tracker.observe(&valid.path);
        }
    }
    let counted = reader.count();
    // A 32-bit EOCD count saturated at 0xFFFF means "more than 65535 records",
    // and both Info-ZIP and CPython write it for large archives. The exemption
    // is gated on the absence of a ZIP64 record: when one IS present it carries
    // a real 64-bit count, so a mismatch there is corruption, not saturation.
    let declared_ok = counted == info.declared_entries
        || (!info.zip64
            && info.declared_entries == u64::from(u16::MAX)
            && counted >= info.declared_entries);
    if !declared_ok {
        return Err(ArchiveError::Corrupt);
    }
    let crc = reader.cd_crc32();
    lh_offsets.sort_unstable();

    let byte_length = src.len();
    // Content only, never pick order (F6). A change detector, not an
    // authenticator: see the plan's Q5.
    let fp = format!(
        "{crc:08x}-{:x}-{:x}-{:x}",
        info.cd_offset, info.cd_size, byte_length
    );
    if let Some(expected) = &part.expected_fp
        && expected != &fp
    {
        return Err(ArchiveError::Changed { part_index: index });
    }

    let strip = tracker
        .strip_segment(allowlist::is_known_root_key)
        .map(str::to_owned);

    // ---- pass 2 ----
    let mut reader = CdReader::new(src.as_ref(), info.cd_offset, info.cd_size, cancel.clone())?;
    let mut entries = Vec::new();
    let mut rejected: HashMap<EntrySkipCode, u64> = HashMap::new();
    let bump = |map: &mut HashMap<EntrySkipCode, u64>, code: EntrySkipCode| {
        *map.entry(code).or_insert(0) += 1;
    };

    while let Some(rec) = reader.next_record()? {
        let valid = match epath::validate(&rec.name) {
            Ok(v) => v,
            Err(code) => {
                bump(&mut rejected, code);
                continue;
            }
        };
        if valid.is_dir {
            continue;
        }
        let stripped = epath::apply_strip(&valid.path, strip.as_deref()).to_owned();
        let verdict = allowlist::classify(&stripped);
        let kind = match verdict {
            Verdict::Listed(k) => k,
            Verdict::NestedArchive => {
                bump(&mut rejected, EntrySkipCode::EntryNestedArchive);
                continue;
            }
            Verdict::NotAllowlisted => {
                bump(&mut rejected, EntrySkipCode::EntryNotAllowlisted);
                continue;
            }
        };
        // Up-front, CD-only skips are decided here so the listing already says
        // what will happen; `extract` re-checks them anyway.
        let skip = match kind_cap(kind) {
            Some(cap) => extract::precheck(&rec, cap).err(),
            // A capless kind (video) is listed with its declared size and never
            // opened, so there is no cap to precheck against — but a record
            // whose geometry we could not parse is still corrupt, and listing a
            // held video with a bogus declared size would mislead #925.
            None => {
                if rec.saturated || rec.malformed_extra {
                    Some(EntrySkipCode::EntryCorrupt)
                } else {
                    None
                }
            }
        };
        entries.push(EntryState {
            entry_id: format!("{fp}:{}", rec.ordinal),
            part: usize::try_from(index).unwrap_or(usize::MAX),
            path: stripped,
            kind,
            skip,
            rec,
        });
        if entries.len() > MAX_LISTED_ENTRIES_PER_SESSION {
            return Err(ArchiveError::TooManyEntries);
        }
    }

    // The two passes must have seen the same bytes. If the file changed
    // underneath us between them, `lh_offsets` (from pass 1) no longer
    // describes the records we just listed, and every data-span bound derived
    // from it would be checking the wrong geometry.
    if reader.cd_crc32() != crc || reader.count() != counted {
        return Err(ArchiveError::Changed { part_index: index });
    }

    Ok(PartListing {
        state: PartState {
            index,
            src: ClosableSource::new(src),
            fp,
            file_id: part.file_id,
            byte_length,
            cd_offset: info.cd_offset,
            lh_offsets,
        },
        entries,
        rejected,
        cd_records: counted,
    })
}

/// Same post-strip path in two entries: an identical copy (same CRC and size)
/// keeps the first; differing copies mark BOTH duplicate, because we cannot
/// tell which one the JSON refers to.
fn mark_duplicates(entries: &mut [EntryState]) {
    let mut first: HashMap<String, (u32, u64, usize)> = HashMap::new();
    let mut mark_both: Vec<usize> = Vec::new();
    let mut mark_later: Vec<usize> = Vec::new();
    for (idx, e) in entries.iter().enumerate() {
        match first.get(&e.path) {
            None => {
                first.insert(e.path.clone(), (e.rec.crc32, e.rec.uncomp_size, idx));
            }
            Some(&(crc, size, first_idx)) => {
                if crc == e.rec.crc32 && size == e.rec.uncomp_size {
                    mark_later.push(idx);
                } else {
                    mark_both.push(first_idx);
                    mark_both.push(idx);
                }
            }
        }
    }
    for idx in mark_later.into_iter().chain(mark_both) {
        if let Some(e) = entries.get_mut(idx)
            && e.skip.is_none()
        {
            e.skip = Some(EntrySkipCode::EntryDuplicate);
        }
    }
}
