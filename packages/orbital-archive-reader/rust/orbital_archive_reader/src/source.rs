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
/// sources (see `open_archive_with_sources`). Implementors must be `Send +
/// Sync`: a session is shared across jobs.
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

/// Reads a bounded, exact-size slice. Callers must keep `len` bounded by a
/// limit from `limits.rs` before calling: this allocates `len` bytes.
pub fn read_exact_vec(src: &dyn Source, offset: u64, len: usize) -> ArchiveResult<Vec<u8>> {
    let mut buf = vec![0u8; len];
    src.read_exact_at(&mut buf, offset)?;
    Ok(buf)
}
