//! Random-access byte source.
//!
//! Every read in this crate is a positioned read (`pread`): no shared file
//! cursor, so nothing can be desynchronised by a concurrent job. Any I/O error
//! at any offset is `ArchiveError::ReadFailed` — a hostile archive must not be
//! able to distinguish "I/O failed" from "that offset is out of range".

use std::fs::File;
use std::os::unix::fs::FileExt;

use crate::error::{ArchiveError, ArchiveResult};

/// A positioned reader over one archive part.
///
/// Public so the host-side hostile matrix can inject recording and failing
/// sources (see `ArchiveSession::open_with_sources`). Implementors must be
/// `Send + Sync`: a session is shared across jobs.
pub trait Source: Send + Sync {
    /// Fill `buf` entirely from `offset`, or fail. A short read is a failure.
    fn read_exact_at(&self, buf: &mut [u8], offset: u64) -> ArchiveResult<()>;

    /// Byte length of the part, as validated at open time.
    fn len(&self) -> u64;

    fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// `Source` over a real file descriptor dup owned by this crate.
pub struct FileSource {
    file: File,
    len: u64,
}

impl FileSource {
    #[must_use]
    pub fn new(file: File, len: u64) -> Self {
        Self { file, len }
    }
}

impl Source for FileSource {
    fn read_exact_at(&self, buf: &mut [u8], offset: u64) -> ArchiveResult<()> {
        self.file
            .read_exact_at(buf, offset)
            .map_err(|_| ArchiveError::ReadFailed)
    }

    fn len(&self) -> u64 {
        self.len
    }
}

/// A `Source` the session can release early.
///
/// `close()` has to drop this crate's descriptor dups without waiting for the
/// uniffi destroy, and it is called from `localWipe` phase 1, which must not
/// block. So the lock lives INSIDE the read path, one `RwLock` read per
/// positioned read (an uncontended atomic, negligible beside the syscall),
/// rather than being held for the length of a job. A job that is mid-read when
/// the session closes gets `SessionClosed` on its next read and unwinds through
/// the normal error path, unlinking its staging file.
pub struct ClosableSource {
    inner: std::sync::RwLock<Option<Box<dyn Source>>>,
    len: u64,
}

impl ClosableSource {
    #[must_use]
    pub fn new(src: Box<dyn Source>) -> Self {
        let len = src.len();
        Self {
            inner: std::sync::RwLock::new(Some(src)),
            len,
        }
    }

    /// Drops the underlying source. Idempotent.
    pub fn release(&self) {
        let mut g = self
            .inner
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *g = None;
    }
}

impl Source for ClosableSource {
    fn read_exact_at(&self, buf: &mut [u8], offset: u64) -> ArchiveResult<()> {
        let g = self
            .inner
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match g.as_deref() {
            Some(src) => src.read_exact_at(buf, offset),
            None => Err(ArchiveError::SessionClosed),
        }
    }

    fn len(&self) -> u64 {
        self.len
    }
}

/// Reads a bounded, exact-size slice. Callers must keep `len` bounded by a
/// limit from `limits.rs` before calling: this allocates `len` bytes.
pub fn read_exact_vec(src: &dyn Source, offset: u64, len: usize) -> ArchiveResult<Vec<u8>> {
    let mut buf = vec![0u8; len];
    src.read_exact_at(&mut buf, offset)?;
    Ok(buf)
}
