//! FFI value types. Every type here carries codes, counts and archive-relative
//! paths only. No key material, no ciphertext, no account identifiers.

/// Entry kind, decided by extension on the allowlisted path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum EntryKind {
    Json,
    Image,
    /// Listed with its declared size so a post can be held whole, and never
    /// opened: there is no `KIND_CAPS` row for it.
    Video,
}

/// Per-entry outcomes. These are **values**, never thrown.
///
/// The TypeScript wrapper's union is a superset: the service adds
/// `ENTRY_IS_VIDEO`, `ENTRY_UNSUPPORTED_IMAGE_FORMAT` and
/// `ENTRY_SNIFF_INDETERMINATE` after it sniffs `peek_head` output (F1). Rust
/// never produces those three.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum EntrySkipCode {
    EntryPathInvalid,
    EntryPathTraversal,
    EntrySymlink,
    EntrySpecialFile,
    EntryEncrypted,
    EntryNestedArchive,
    EntryUnsupportedMethod,
    EntryDuplicate,
    EntryOverCap,
    EntryRatioExceeded,
    EntryCorrupt,
    /// Video: no `KIND_CAPS` row, so it is listed but never opened.
    EntryKindNotEnabled,
    /// `extract_entry` was called with a kind that is not the entry's kind.
    EntryKindMismatch,
    EntryNotUtf8,
    /// Aggregation bucket for records the allowlist did not match. These are
    /// counted in `rejectedCounts` and never listed or named (F6). No entry
    /// ever carries this as its `skip`.
    EntryNotAllowlisted,
}

/// `resolve_media_uris` outcomes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum UriSkipCode {
    UriInvalid,
    UriOutsideAllowlist,
    UriUnresolved,
    UriAmbiguous,
    UriUnsupportedKind,
}

/// One part handed to `open_archive`.
///
/// `fd` is **borrowed**: the glue owns it until `closeParts` and Rust keeps
/// only a dup (F2). `expected_fp` is present on a resume and makes a changed
/// file fail with `ArchiveChanged` instead of mis-resolving stored entry ids.
#[derive(Debug, Clone, uniffi::Record)]
pub struct ArchivePartInput {
    pub fd: i32,
    pub byte_length: u64,
    /// `"dev:ino"`, as produced by the glue's `fstat`.
    pub file_id: String,
    pub expected_fp: Option<String>,
}

/// Part identity after open. `fp` derives only from part CONTENT (CRC-32 of
/// the central directory, its offset and size, and the file length) — never
/// from pick order (F6). It is a change detector, not an authenticator.
#[derive(Debug, Clone, uniffi::Record)]
pub struct ArchivePartInfo {
    pub index: u32,
    pub fp: String,
    pub byte_length: u64,
    pub file_id: String,
}

/// One allowlisted entry. Every allowlisted entry is listed; `skip` is set
/// when it was rejected (F6).
#[derive(Debug, Clone, uniffi::Record)]
pub struct ArchiveEntry {
    /// `"{partFp8}:{cdOrdinal}"`. `cdOrdinal` is the RAW central-directory
    /// record ordinal, independent of the allowlist and of skip filtering, so
    /// it is stable across re-open, part reordering and allowlist widening.
    pub entry_id: String,
    /// Archive-relative path after the wrapper strip.
    pub path: String,
    pub kind: EntryKind,
    pub declared_size: u64,
    pub skip: Option<EntrySkipCode>,
}

/// Aggregated rejection counts. Covers rejected allowlisted entries plus
/// non-allowlisted records, which are counted only and never named.
#[derive(Debug, Clone, uniffi::Record)]
pub struct RejectedCount {
    pub code: EntrySkipCode,
    pub count: u64,
}

/// Result of resolving one media URI.
#[derive(Debug, Clone, uniffi::Enum)]
pub enum UriResolution {
    Resolved { entry_id: String },
    Skipped { skip: UriSkipCode },
}

/// Result of `extract_entry`. The caller unlinks `path` after consuming it.
#[derive(Debug, Clone, uniffi::Enum)]
pub enum ExtractOutcome {
    Extracted {
        path: String,
        byte_length: u64,
        /// First `HEAD_BYTES` of the plaintext entry, for a content sniff.
        head: Vec<u8>,
    },
    Skipped {
        skip: EntrySkipCode,
    },
}

/// Result of `read_json`. Decoded in memory; no file is written.
#[derive(Debug, Clone, uniffi::Enum)]
pub enum JsonOutcome {
    Text { text: String },
    Skipped { skip: EntrySkipCode },
}

/// Result of `peek_head` (F1): at most `HEAD_PEEK_BYTES` inflated bytes, no
/// staging file, not charged to the session byte budget.
#[derive(Debug, Clone, uniffi::Enum)]
pub enum PeekOutcome {
    Head { head: Vec<u8> },
    Skipped { skip: EntrySkipCode },
}
