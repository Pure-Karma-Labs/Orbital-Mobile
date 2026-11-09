//! Archive-wide errors.
//!
//! Every variant carries codes and counts only — never an entry name, a path,
//! a URI or any file content. `part_index` is a count, not a name.

/// Errors that cross the FFI. The message is fixed per variant so a log line
/// can never leak archive contents.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error, uniffi::Error)]
pub enum ArchiveError {
    #[error("ARCHIVE_NOT_ZIP")]
    NotZip,
    #[error("ARCHIVE_CORRUPT")]
    Corrupt,
    #[error("ARCHIVE_UNSUPPORTED")]
    Unsupported,
    #[error("ARCHIVE_TOO_MANY_ENTRIES")]
    TooManyEntries,
    #[error("ARCHIVE_TOO_MANY_PARTS")]
    TooManyParts,
    #[error("ARCHIVE_SESSION_BYTES_EXCEEDED")]
    SessionBytesExceeded,
    #[error("ARCHIVE_DUPLICATE_PART")]
    DuplicatePart,
    #[error("ARCHIVE_NOT_SEEKABLE")]
    NotSeekable,
    #[error("ARCHIVE_READ_FAILED")]
    ReadFailed,
    #[error("ARCHIVE_ACCESS_LOST")]
    AccessLost { part_index: u32 },
    #[error("ARCHIVE_CHANGED")]
    Changed { part_index: u32 },
    #[error("ARCHIVE_STAGING_UNAVAILABLE")]
    StagingUnavailable,
    #[error("ARCHIVE_NO_SPACE")]
    NoSpace,
    /// Surfaced by the wrapper as `ECANCELLED` so the existing
    /// `isCancellation` / `isUploadCancellation` guards recognise it (F4).
    #[error("ECANCELLED")]
    Cancelled,
    #[error("ARCHIVE_SESSION_CLOSED")]
    SessionClosed,
    /// Transient: every job slot is taken. A caller may retry.
    #[error("ARCHIVE_BUSY")]
    Busy,
    /// Not transient: the caller handed over a staging path this session is
    /// still holding bytes for. Retrying with the same path will never succeed
    /// — the caller must release it or use a fresh one. Kept distinct from
    /// `Busy` so a backoff loop cannot spin on it forever.
    #[error("ARCHIVE_STAGING_IN_USE")]
    StagingInUse,
    #[error("ARCHIVE_INTERNAL")]
    Internal,
}

pub type ArchiveResult<T> = Result<T, ArchiveError>;

/// Either an archive-wide failure or a per-entry skip. Per-entry parsing
/// returns this so a single bad record can never fail the whole archive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryFault {
    Fatal(ArchiveError),
    Skip(crate::types::EntrySkipCode),
}

impl From<ArchiveError> for EntryFault {
    fn from(e: ArchiveError) -> Self {
        Self::Fatal(e)
    }
}

impl From<crate::types::EntrySkipCode> for EntryFault {
    fn from(s: crate::types::EntrySkipCode) -> Self {
        Self::Skip(s)
    }
}

pub type EntryResult<T> = Result<T, EntryFault>;
