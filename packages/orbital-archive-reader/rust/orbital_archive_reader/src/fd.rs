//! The only module in this crate that contains `unsafe`.
//!
//! Adopting a file descriptor handed over the FFI is inherently unsafe: Rust
//! cannot prove the integer names a live descriptor. The containment strategy
//! is:
//!
//! 1. The single `unsafe` expression is `BorrowedFd::borrow_raw`, immediately
//!    followed by `try_clone_to_owned` (a `fcntl(F_DUPFD_CLOEXEC)`), so this
//!    crate owns a dup and never closes the glue's descriptor (F2).
//! 2. Everything after the dup is safe code, and the dup is validated before
//!    any parsing: it must be a regular file, its `dev:ino` must equal the
//!    `fileId` the glue measured, and its size must equal the declared length.
//! 3. A failed regular/seek check is `NotSeekable` (an MTP pipe, a socket, a
//!    directory). A `dev:ino` mismatch is `ReadFailed`: the fd number was
//!    reused between the glue's `fstat` and this call.

use std::fs::File;
use std::os::fd::BorrowedFd;
use std::os::unix::fs::MetadataExt;

use crate::error::{ArchiveError, ArchiveResult};
use crate::limits::MIN_ZIP_BYTES;

/// Duplicates a borrowed descriptor.
///
/// # Safety contract with the caller (the native glue)
/// `fd` must be a descriptor the glue has open for reading and will keep open
/// until `closeParts`. Rust never closes `fd` itself — only the returned dup.
#[allow(unsafe_code)]
fn dup_borrowed(fd: i32, part_index: u32) -> ArchiveResult<File> {
    if fd < 0 {
        return Err(ArchiveError::AccessLost { part_index });
    }
    // SAFETY: see the module header and the caller contract above. The
    // BorrowedFd is used for exactly one dup and never escapes this function,
    // so the unsafe lifetime assumption is bounded by this expression.
    let borrowed = unsafe { BorrowedFd::borrow_raw(fd) };
    let owned = borrowed
        .try_clone_to_owned()
        .map_err(|_| ArchiveError::AccessLost { part_index })?;
    Ok(File::from(owned))
}

/// A validated dup of one part's descriptor.
pub struct AdoptedPart {
    pub file: File,
    pub byte_length: u64,
}

/// Adopts and validates one part descriptor.
///
/// `file_id` is the glue's `"dev:ino"`. An empty `file_id` is rejected: the
/// check is mandatory, so a glue bug cannot silently skip it.
pub fn adopt(
    fd: i32,
    declared_len: u64,
    file_id: &str,
    part_index: u32,
) -> ArchiveResult<AdoptedPart> {
    let file = dup_borrowed(fd, part_index)?;

    let meta = file
        .metadata()
        .map_err(|_| ArchiveError::AccessLost { part_index })?;

    // Regular files only. A pipe (Android MTP), socket, device or directory is
    // not seekable, and the "copy to your device first" path is the UX answer.
    if !meta.is_file() {
        return Err(ArchiveError::NotSeekable);
    }

    let actual_id = format!("{}:{}", meta.dev(), meta.ino());
    if file_id.is_empty() || actual_id != file_id {
        // fd-number reuse between the glue's fstat and this call.
        return Err(ArchiveError::ReadFailed);
    }

    let actual_len = meta.len();
    if actual_len != declared_len {
        return Err(ArchiveError::ReadFailed);
    }
    if actual_len < MIN_ZIP_BYTES {
        return Err(ArchiveError::NotZip);
    }

    Ok(AdoptedPart {
        file,
        byte_length: actual_len,
    })
}
