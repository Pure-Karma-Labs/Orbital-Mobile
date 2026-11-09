//! The single invariant-pinned limits table.
//!
//! Every cap in this file is load-bearing for hostile-input handling. The
//! security invariant checker pins the literals below; change a value only
//! together with that clause.

use crate::types::EntryKind;

pub const KIB: u64 = 1024;
pub const MIB: u64 = 1024 * KIB;
pub const GIB: u64 = 1024 * MIB;

/// Per-kind output ceiling. There is deliberately **no `Video` row**: video
/// entries are listed (so #925 can hold the whole post) but never opened, and
/// `kind_cap` returns `None` for them, which becomes `EntryKindNotEnabled`.
pub const KIND_CAPS: [(EntryKind, u64); 2] =
    [(EntryKind::Json, 32 * MIB), (EntryKind::Image, 50 * MIB)];

/// `None` means "this kind is not enabled for extraction".
#[must_use]
pub fn kind_cap(kind: EntryKind) -> Option<u64> {
    let mut i = 0;
    while i < KIND_CAPS.len() {
        match KIND_CAPS.get(i) {
            Some(&(k, cap)) if k as u8 == kind as u8 => return Some(cap),
            _ => {}
        }
        i = i.saturating_add(1);
    }
    None
}

/// Multi-part exports: Meta splits at 1-4 GiB, so 64 parts is far above any
/// real export and still bounds the open-fd count.
pub const MAX_PARTS: usize = 64;

/// Declared central-directory record count is checked first, then the counted
/// records are checked against the same bound.
pub const MAX_CD_ENTRIES_PER_PART: u64 = 1_000_000;

/// Central directory byte size bound (bounds the two CD scans).
pub const MAX_CD_BYTES_PER_PART: u64 = 256 * MIB;

/// Allowlisted entries surfaced across the whole session.
pub const MAX_LISTED_ENTRIES_PER_SESSION: usize = 100_000;

/// Bomb bound on total extracted bytes for one session (not a quota).
pub const MAX_SESSION_BYTES_WRITTEN: u64 = 8 * GIB;

/// Ceiling on staging bytes alive at once in one session (F8).
pub const MAX_LIVE_STAGING_BYTES: u64 = 512 * MIB;

/// Maximum uncompressed:compressed ratio, applied after `RATIO_GRACE_BYTES`.
pub const MAX_RATIO: u64 = 100;
pub const RATIO_GRACE_BYTES: u64 = MIB;

/// Concurrent jobs per session.
pub const MAX_JOBS: usize = 4;

/// `peek_head` inflates at most this many bytes, writes no staging file and is
/// not charged to the session byte budget (F1).
pub const HEAD_PEEK_BYTES: usize = 128;

/// Bytes of `head` returned by `extract_entry`.
pub const HEAD_BYTES: usize = HEAD_PEEK_BYTES;

/// Streaming central-directory buffer. The whole CD is never held in memory.
pub const CD_BUFFER_BYTES: usize = 1024 * 1024;

/// Copy-loop chunk.
pub const COPY_CHUNK_BYTES: usize = 64 * 1024;

/// Cancel-flag check cadence while iterating central-directory records (F4).
pub const CANCEL_CHECK_RECORDS: u64 = 10_000;

/// Hard floor for a ZIP: an empty archive is exactly one 22-byte EOCD.
pub const MIN_ZIP_BYTES: u64 = 22;

/// ZIP comment field is a u16 length.
pub const MAX_ZIP_COMMENT_BYTES: u64 = 65_535;

/// Path hygiene (path.rs).
pub const MAX_PATH_BYTES: usize = 1024;
pub const MAX_PATH_SEGMENTS: usize = 16;

/// In-memory JSON ceiling, equal to the Json kind cap. This is a JS-heap
/// budget, not a disk budget: `read_json` returns the text across the FFI.
pub const MAX_JSON_BYTES: u64 = 32 * MIB;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_are_pinned() {
        assert_eq!(kind_cap(EntryKind::Json), Some(32 * MIB));
        assert_eq!(kind_cap(EntryKind::Image), Some(50 * MIB));
        assert_eq!(kind_cap(EntryKind::Video), None);
        assert_eq!(MAX_RATIO, 100);
        assert_eq!(HEAD_PEEK_BYTES, 128);
        assert_eq!(MAX_LIVE_STAGING_BYTES, 512 * MIB);
    }
}
