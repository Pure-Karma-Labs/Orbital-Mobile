//! Staging-file hygiene.
//!
//! Rust never *creates* a staging file: the native glue does, because only the
//! glue can set `NSFileProtectionCompleteUnlessOpen` and the
//! excluded-from-backup flag. Rust opens the glue-created path with
//! `create(false)`, so a mid-job `localWipe` sweep is never undone by
//! recreating the file as residue.
//!
//! F8 hardening, in order:
//! 1. The parent directory must equal the session's canonicalised staging dir.
//! 2. The file name must match `<uuid>-archive-staging.bin`.
//! 3. The open carries `O_NOFOLLOW`, so a symlink planted at the path fails.
//! 4. After the open, `fstat` must report a regular file with `nlink == 1`
//!    (no hard link aliasing the bytes we are about to write).

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use crate::error::{ArchiveError, ArchiveResult};

/// `O_NOFOLLOW` is not exposed by `std`, and this crate deliberately has no
/// `libc` dependency (the dependency set is invariant-pinned). The constants
/// are the ABI values for the two platform families we ship, and the hostile
/// matrix proves the flag is effective by planting a symlink.
#[cfg(any(target_os = "macos", target_os = "ios"))]
const O_NOFOLLOW: i32 = 0x0000_0100;
#[cfg(any(target_os = "linux", target_os = "android"))]
const O_NOFOLLOW: i32 = 0o0_400_000;
#[cfg(not(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "linux",
    target_os = "android"
)))]
compile_error!("O_NOFOLLOW value is unknown for this target; add it before building here");

const ENOSPC: i32 = 28;
const EDQUOT_MACOS: i32 = 69;
const EDQUOT_LINUX: i32 = 122;

const STAGING_SUFFIX: &str = "-archive-staging.bin";
/// Canonical UUID group lengths: 8-4-4-4-12.
const UUID_GROUPS: [usize; 5] = [8, 4, 4, 4, 12];

/// `true` for exactly `<canonical UUID>-archive-staging.bin`.
///
/// The group shape is checked, not merely the length and the alphabet: 36
/// characters of `[0-9a-f-]` would also accept a run of 36 dashes, which is not
/// a name any glue can produce and not a name we want to open. Hex is accepted
/// in either case because iOS `NSUUID.UUIDString` is UPPERCASE while
/// `java.util.UUID.toString()` is lowercase, and neither glue should have to
/// remember to transform it.
#[must_use]
pub fn is_valid_staging_name(name: &str) -> bool {
    let Some(uuid) = name.strip_suffix(STAGING_SUFFIX) else {
        return false;
    };
    let mut groups = 0usize;
    for (i, group) in uuid.split('-').enumerate() {
        if UUID_GROUPS.get(i) != Some(&group.len()) {
            return false;
        }
        if !group.bytes().all(|b| b.is_ascii_hexdigit()) {
            return false;
        }
        groups = groups.saturating_add(1);
    }
    groups == UUID_GROUPS.len()
}

/// The staging ledger's key for `path`: the validated leaf name, ASCII
/// lowercased.
///
/// The ledger must not be keyed on the caller's raw string. `<dir>/<uuid>…`,
/// `<dir>/./<uuid>…` and a case-flipped UUID all name the SAME file — the
/// parent is forced to equal the session staging directory and the leaf is a
/// UUID — but as raw strings they are three different keys. Keyed that way, a
/// `release_staging` that spells the path differently is a silent no-op that
/// leaks a kind cap of headroom per call, and on case-insensitive APFS two case
/// variants slip past the in-use check and truncate each other's output.
pub fn ledger_key(path: &str) -> ArchiveResult<String> {
    let leaf = Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or(ArchiveError::StagingUnavailable)?;
    if !is_valid_staging_name(leaf) {
        return Err(ArchiveError::StagingUnavailable);
    }
    Ok(leaf.to_ascii_lowercase())
}

fn map_io(err: &std::io::Error) -> ArchiveError {
    match err.raw_os_error() {
        Some(code) if code == ENOSPC || code == EDQUOT_MACOS || code == EDQUOT_LINUX => {
            ArchiveError::NoSpace
        }
        _ => ArchiveError::StagingUnavailable,
    }
}

/// An opened staging file, truncated and ready to receive one entry.
pub struct StagingFile {
    file: File,
    path: PathBuf,
    written: u64,
    finished: bool,
}

impl StagingFile {
    /// Opens `path` after the four F8 checks. `staging_dir` must already be
    /// canonicalised by the session (once, at open time).
    pub fn open(path: &str, staging_dir: &Path) -> ArchiveResult<Self> {
        let candidate = Path::new(path);
        let name = candidate
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or(ArchiveError::StagingUnavailable)?;
        if !is_valid_staging_name(name) {
            return Err(ArchiveError::StagingUnavailable);
        }
        let parent = candidate
            .parent()
            .ok_or(ArchiveError::StagingUnavailable)?
            .canonicalize()
            .map_err(|e| map_io(&e))?;
        if parent != staging_dir {
            return Err(ArchiveError::StagingUnavailable);
        }

        let file = OpenOptions::new()
            .write(true)
            .truncate(true)
            .create(false)
            .custom_flags(O_NOFOLLOW)
            .open(candidate)
            .map_err(|e| map_io(&e))?;

        let meta = file.metadata().map_err(|e| map_io(&e))?;
        if !meta.is_file() || meta.nlink() != 1 {
            // A FIFO, a device node, or a hard link to a file someone else can
            // read. Unlink nothing: we did not create it.
            return Err(ArchiveError::StagingUnavailable);
        }

        Ok(Self {
            file,
            path: candidate.to_path_buf(),
            written: 0,
            finished: false,
        })
    }

    pub fn write_all(&mut self, buf: &[u8]) -> ArchiveResult<()> {
        self.file.write_all(buf).map_err(|e| map_io(&e))?;
        self.written = self
            .written
            .checked_add(crate::num::to_u64(buf.len()))
            .ok_or(ArchiveError::Internal)?;
        Ok(())
    }

    /// Flushes and hands the path to the caller, which owns the unlink.
    pub fn finish(mut self) -> ArchiveResult<u64> {
        self.file.flush().map_err(|e| map_io(&e))?;
        self.file.sync_data().map_err(|e| map_io(&e))?;
        self.finished = true;
        Ok(self.written)
    }
}

impl Drop for StagingFile {
    /// On failure or cancel the partial file is truncated and unlinked, so a
    /// half-written image can never be mistaken for a complete extract.
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        let _ = self.file.set_len(0);
        let _ = std::fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ledger_key_collapses_aliases_of_one_file() {
        let a = ledger_key("/tmp/x/0b5f1f3c-6a4e-4d2b-9f1a-123456789abc-archive-staging.bin");
        let dot = ledger_key("/tmp/x/./0b5f1f3c-6a4e-4d2b-9f1a-123456789abc-archive-staging.bin");
        let upper = ledger_key("/tmp/x/0B5F1F3C-6A4E-4D2B-9F1A-123456789ABC-archive-staging.bin");
        assert!(a.is_ok());
        assert_eq!(a, dot);
        assert_eq!(a, upper);
        // A path that could never be opened has no key either.
        assert_eq!(
            ledger_key("/tmp/x/payload.bin").err(),
            Some(ArchiveError::StagingUnavailable)
        );
    }

    #[test]
    fn staging_names_are_strict() {
        // Lowercase (Android) and uppercase (iOS NSUUID.UUIDString) both pass.
        assert!(is_valid_staging_name(
            "0b5f1f3c-6a4e-4d2b-9f1a-123456789abc-archive-staging.bin"
        ));
        assert!(is_valid_staging_name(
            "0B5F1F3C-6A4E-4D2B-9F1A-123456789ABC-archive-staging.bin"
        ));
        for bad in [
            "archive-staging.bin",
            "",
            "0b5f1f3c-archive-staging.bin",
            // Right length and alphabet, wrong shape.
            "------------------------------------archive-staging.bin",
            "0b5f1f3c6a4e-4d2b-9f1a-1234-56789abc-archive-staging.bin",
            // Non-hex.
            "0b5f1f3c-6a4e-4d2b-9f1a-123456789abZ-archive-staging.bin",
            // Extra group.
            "0b5f1f3c-6a4e-4d2b-9f1a-123456789abc-0000-archive-staging.bin",
            "0b5f1f3c-6a4e-4d2b-9f1a-123456789abc-archive-staging.bin.tmp",
            "../0b5f1f3c-6a4e-4d2b-9f1a-123456789abc-archive-staging.bin",
        ] {
            assert!(!is_valid_staging_name(bad), "{bad}");
        }
    }
}
