//! The session object: listing, indexes, job registry and byte budgets.
//!
//! Everything derived from archive content is computed once at open and then
//! immutable, so concurrent jobs share it without a lock. Only the budgets and
//! the job registry are mutable, behind one `Mutex`.

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
    HEAD_PEEK_BYTES, MAX_JOBS, MAX_JSON_BYTES, MAX_LISTED_ENTRIES_PER_SESSION,
    MAX_LIVE_STAGING_BYTES, MAX_PARTS, MAX_SESSION_BYTES_WRITTEN, kind_cap,
};
use crate::local;
use crate::num::to_u64;
use crate::path as epath;
use crate::source::{FileSource, Source};
use crate::staging::StagingFile;
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

struct PartState {
    index: u32,
    src: Box<dyn Source>,
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
    bytes_written: u64,
    live_staging: u64,
    jobs: HashMap<String, CancelFlag>,
}

/// Immutable listing plus mutable budgets. Held behind an `Arc` so a blocking
/// job can own a clone without borrowing the uniffi object.
pub struct SessionCore {
    parts: Vec<PartState>,
    entries: Vec<EntryState>,
    by_id: HashMap<String, usize>,
    exact_index: HashMap<String, Vec<usize>>,
    basename_index: HashMap<String, Vec<usize>>,
    rejected: Vec<RejectedCount>,
    staging_dir: PathBuf,
    /// Normally `MAX_SESSION_BYTES_WRITTEN`; overridable by the host matrix so
    /// the budget can be exercised without extracting gigabytes.
    max_session_bytes: u64,
    /// Normally `MAX_LIVE_STAGING_BYTES` (F8).
    max_live_staging: u64,
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

    fn remaining_session_bytes(&self) -> u64 {
        let st = guard(&self.state);
        self.max_session_bytes.saturating_sub(st.bytes_written)
    }

    // ---- job bodies (run on a blocking worker thread) -------------------

    fn do_peek_head(&self, entry_id: &str, cancel: &CancelFlag) -> ArchiveResult<PeekOutcome> {
        let entry = self.entry(entry_id)?;
        if let Some(skip) = entry.skip {
            return Ok(PeekOutcome::Skipped { skip });
        }
        // F1: a peek is allowed for json and image kinds only. Video entries,
        // identified by extension, are never opened.
        if entry.kind == EntryKind::Video {
            return Ok(PeekOutcome::Skipped {
                skip: EntrySkipCode::EntryKindNotEnabled,
            });
        }
        let cap = kind_cap(entry.kind).ok_or(ArchiveError::Internal)?;
        if let Err(skip) = extract::precheck(&entry.rec, cap) {
            return Ok(PeekOutcome::Skipped { skip });
        }
        let part = self.part(entry.part)?;
        let span = match local::verify(
            part.src.as_ref(),
            &entry.rec,
            &part.lh_offsets,
            part.cd_offset,
        ) {
            Ok(s) => s,
            Err(EntryFault::Skip(skip)) => return Ok(PeekOutcome::Skipped { skip }),
            Err(EntryFault::Fatal(e)) => return Err(e),
        };
        let limits = StreamLimits {
            declared: entry.rec.uncomp_size,
            cap,
            // Not charged to the session byte budget (F1).
            session_remaining: u64::MAX,
            max_output: Some(to_u64(HEAD_PEEK_BYTES)),
        };
        let mut sink = NullSink;
        match extract::stream_entry(
            part.src.as_ref(),
            span,
            &entry.rec,
            &limits,
            cancel,
            &mut sink,
        ) {
            Ok(out) => Ok(PeekOutcome::Head { head: out.head }),
            Err(EntryFault::Skip(skip)) => Ok(PeekOutcome::Skipped { skip }),
            Err(EntryFault::Fatal(e)) => Err(e),
        }
    }

    fn do_read_json(&self, entry_id: &str, cancel: &CancelFlag) -> ArchiveResult<JsonOutcome> {
        let entry = self.entry(entry_id)?;
        if let Some(skip) = entry.skip {
            return Ok(JsonOutcome::Skipped { skip });
        }
        if entry.kind != EntryKind::Json {
            return Ok(JsonOutcome::Skipped {
                skip: EntrySkipCode::EntryKindMismatch,
            });
        }
        let cap = kind_cap(EntryKind::Json)
            .ok_or(ArchiveError::Internal)?
            .min(MAX_JSON_BYTES);
        if let Err(skip) = extract::precheck(&entry.rec, cap) {
            return Ok(JsonOutcome::Skipped { skip });
        }
        let part = self.part(entry.part)?;
        let span = match local::verify(
            part.src.as_ref(),
            &entry.rec,
            &part.lh_offsets,
            part.cd_offset,
        ) {
            Ok(s) => s,
            Err(EntryFault::Skip(skip)) => return Ok(JsonOutcome::Skipped { skip }),
            Err(EntryFault::Fatal(e)) => return Err(e),
        };
        let limits = StreamLimits {
            declared: entry.rec.uncomp_size,
            cap,
            session_remaining: u64::MAX,
            max_output: None,
        };
        let mut buf: Vec<u8> = Vec::new();
        match extract::stream_entry(
            part.src.as_ref(),
            span,
            &entry.rec,
            &limits,
            cancel,
            &mut buf,
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
        let entry = self.entry(entry_id)?;
        if let Some(skip) = entry.skip {
            return Ok(ExtractOutcome::Skipped { skip });
        }
        if entry.kind != kind {
            return Ok(ExtractOutcome::Skipped {
                skip: EntrySkipCode::EntryKindMismatch,
            });
        }
        let Some(cap) = kind_cap(kind) else {
            // Video: no KIND_CAPS row, so it is never opened.
            return Ok(ExtractOutcome::Skipped {
                skip: EntrySkipCode::EntryKindNotEnabled,
            });
        };
        if let Err(skip) = extract::precheck(&entry.rec, cap) {
            return Ok(ExtractOutcome::Skipped { skip });
        }

        let projected = entry.rec.uncomp_size.min(cap);
        {
            let st = guard(&self.state);
            if st.closed {
                return Err(ArchiveError::SessionClosed);
            }
            if st.live_staging.saturating_add(projected) > self.max_live_staging {
                // F8: too many extracted-but-unreleased files alive at once.
                return Err(ArchiveError::NoSpace);
            }
        }

        let part = self.part(entry.part)?;
        let span = match local::verify(
            part.src.as_ref(),
            &entry.rec,
            &part.lh_offsets,
            part.cd_offset,
        ) {
            Ok(s) => s,
            Err(EntryFault::Skip(skip)) => return Ok(ExtractOutcome::Skipped { skip }),
            Err(EntryFault::Fatal(e)) => return Err(e),
        };

        let mut file = StagingFile::open(staging_path, &self.staging_dir)?;
        let limits = StreamLimits {
            declared: entry.rec.uncomp_size,
            cap,
            session_remaining: self.remaining_session_bytes(),
            max_output: None,
        };
        let outcome = match extract::stream_entry(
            part.src.as_ref(),
            span,
            &entry.rec,
            &limits,
            cancel,
            &mut file,
        ) {
            Ok(o) => o,
            // `file` is dropped here, which truncates and unlinks the partial
            // output, so a skipped or cancelled extract leaves no residue.
            Err(EntryFault::Skip(skip)) => return Ok(ExtractOutcome::Skipped { skip }),
            Err(EntryFault::Fatal(e)) => return Err(e),
        };
        let written = file.finish()?;

        {
            let mut st = guard(&self.state);
            st.bytes_written = st.bytes_written.saturating_add(written);
            st.live_staging = st.live_staging.saturating_add(written);
        }

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

    /// Releases `byte_length` from the live-staging ceiling. The TS service
    /// calls this in the same `finally` that unlinks the staging file (F8).
    pub fn release_staging(&self, byte_length: u64) {
        let mut st = guard(&self.core.state);
        st.live_staging = st.live_staging.saturating_sub(byte_length);
    }

    /// Cancels one in-flight job. Synchronous and lock-free enough for
    /// `localWipe` phase 1.
    pub fn cancel(&self, job_id: String) {
        if let Some(flag) = guard(&self.core.state).jobs.get(&job_id) {
            flag.cancel();
        }
    }

    /// Cancels every job and refuses further work. Idempotent. Only this
    /// crate's dups are dropped; the glue still owns the original fds (F2).
    pub fn close(&self) {
        let mut st = guard(&self.core.state);
        st.closed = true;
        for flag in st.jobs.values() {
            flag.cancel();
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
    /// `path` after consuming it, and calls `release_staging`.
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
        Self::open_with_sources_and_budgets(
            parts,
            staging_dir,
            cancel,
            MAX_SESSION_BYTES_WRITTEN,
            MAX_LIVE_STAGING_BYTES,
        )
    }

    /// Host-test entry point with overridable budgets, so the session byte
    /// budget and the live-staging ceiling can be exercised in milliseconds
    /// instead of gigabytes.
    #[doc(hidden)]
    pub fn open_with_sources_and_budgets(
        parts: Vec<PartSourceInput>,
        staging_dir: &str,
        cancel: &CancelFlag,
        max_session_bytes: u64,
        max_live_staging: u64,
    ) -> ArchiveResult<Arc<Self>> {
        let mut core = build_core(parts, staging_dir, cancel)?;
        core.max_session_bytes = max_session_bytes;
        core.max_live_staging = max_live_staging;
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

        if fully_allowlisted && let Some(hits) = self.exact_index.get(&norm) {
            return match hits.len() {
                1 => self.resolved(hits.first().copied()),
                _ => UriResolution::Skipped {
                    skip: UriSkipCode::UriAmbiguous,
                },
            };
        }

        let basename = norm.rsplit('/').next().unwrap_or(&norm).to_owned();
        let suffix = format!("/{norm}");
        let mut found: Option<usize> = None;
        let mut count = 0usize;
        if let Some(candidates) = self.basename_index.get(&basename) {
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
        let core = build_core(sources, &staging_dir, &flag)?;
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
}

fn build_core(
    parts: Vec<PartSourceInput>,
    staging_dir: &str,
    cancel: &CancelFlag,
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
    let mut exact_index: HashMap<String, Vec<usize>> = HashMap::new();
    let mut basename_index: HashMap<String, Vec<usize>> = HashMap::new();
    for (idx, e) in entries.iter().enumerate() {
        by_id.insert(e.entry_id.clone(), idx);
        if e.skip.is_some() || e.kind == EntryKind::Json {
            continue;
        }
        exact_index.entry(e.path.clone()).or_default().push(idx);
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
        exact_index,
        basename_index,
        rejected: rejected_counts,
        staging_dir,
        max_session_bytes: MAX_SESSION_BYTES_WRITTEN,
        max_live_staging: MAX_LIVE_STAGING_BYTES,
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
        let utf8 = (rec.flags & (1 << 11)) != 0;
        if let Ok(valid) = epath::validate(&rec.name, utf8)
            && !valid.is_dir
        {
            tracker.observe(&valid.path);
        }
    }
    let counted = reader.count();
    let declared_ok = counted == info.declared_entries
        || (info.declared_entries == u64::from(u16::MAX) && counted >= info.declared_entries);
    if !declared_ok {
        return Err(ArchiveError::Corrupt);
    }
    let crc = reader.cd_crc32();
    lh_offsets.sort_unstable();

    let byte_length = src.len();
    let fp = format!(
        "{crc:08x}-{:x}-{:x}-{:x}",
        info.cd_offset, info.cd_size, byte_length
    );
    let fp8 = format!("{crc:08x}");
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
        let utf8 = (rec.flags & (1 << 11)) != 0;
        let valid = match epath::validate(&rec.name, utf8) {
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
            // Video: listed with its declared size, never opened.
            None => None,
        };
        entries.push(EntryState {
            entry_id: format!("{fp8}:{}", rec.ordinal),
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

    Ok(PartListing {
        state: PartState {
            index,
            src,
            fp,
            file_id: part.file_id,
            byte_length,
            cd_offset: info.cd_offset,
            lh_offsets,
        },
        entries,
        rejected,
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
