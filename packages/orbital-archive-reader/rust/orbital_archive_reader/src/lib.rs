//! # orbital_archive_reader
//!
//! A hostile-input ZIP reader for Meta (Facebook / Instagram) data exports.
//!
//! ## No key material crosses this FFI
//!
//! **No key material, no ciphertext and no credential of any kind crosses this
//! FFI boundary, and none is ever held in this crate.** This crate reads
//! user-supplied archive files and returns plaintext archive bytes, paths and
//! codes. All Orbital cryptography lives in `orbital_signal`, a separate crate
//! and a separate binary: hostile-input parsing is deliberately kept out of the
//! key-holding binary, which is the reason this crate exists at all.
//!
//! ## Scope
//!
//! * The central directory is the only source of truth. STORED and DEFLATE
//!   only, read through positioned reads on a descriptor the native glue owns.
//! * An allowlist (`allowlist.rs`) decides what may be opened. A record it does
//!   not match is parsed from the central directory and never opened: its local
//!   header and its data are not read.
//! * Every bound lives in `limits.rs` and is enforced inside the decode loop.
//! * Nothing here writes to a path it chose: staging files are created and
//!   named by the native glue, and this crate opens them with
//!   `create(false)` + `O_NOFOLLOW`.
//! * Errors and per-entry skips carry codes and counts only — never names,
//!   paths, URIs or content.
//!
//! ## Safety posture
//!
//! `#![deny(unsafe_code)]` is crate-wide. Exactly one function, in `fd.rs`,
//! carries `#[allow(unsafe_code)]`: adopting a descriptor handed over the FFI
//! cannot be expressed in safe Rust. The parser modules additionally deny
//! `clippy::arithmetic_side_effects`, `clippy::indexing_slicing`,
//! `clippy::cast_possible_truncation`, `clippy::unwrap_used` and
//! `clippy::expect_used`, so attacker-supplied lengths cannot wrap or panic.
//!
//! There are no logging macros anywhere in this crate.

#![deny(unsafe_code)]
#![forbid(clippy::print_stdout, clippy::print_stderr, clippy::dbg_macro)]

mod allowlist;
mod blocking;
mod cancel;
mod cdir;
mod eocd;
mod error;
mod extract;
mod fd;
mod limits;
mod local;
mod num;
mod path;
mod session;
mod source;
mod staging;
mod types;

pub use cancel::CancelToken;
pub use error::{ArchiveError, ArchiveResult};
pub use session::{ArchiveSession, open_archive};
pub use types::{
    ArchiveEntry, ArchivePartInfo, ArchivePartInput, EntryKind, EntrySkipCode, ExtractOutcome,
    JsonOutcome, PeekOutcome, RejectedCount, UriResolution, UriSkipCode,
};

/// Host-test surface. Not part of the FFI: the hostile matrix lives in
/// integration tests, which can only reach the public API, and a dev-only
/// path dependency on this crate is forbidden by the security invariants.
#[doc(hidden)]
pub mod testing {
    pub use crate::allowlist::{
        ALLOWED_ROOTS, DENIED_ROOTS, Verdict, classify, is_known_root_key, normalise_uri,
        starts_with_denied_root,
    };
    pub use crate::cancel::CancelFlag;
    pub use crate::extract::looks_like_archive;
    pub use crate::limits::{
        HEAD_PEEK_BYTES, MAX_CD_RECORDS_PER_SESSION, MAX_LISTED_ENTRIES_PER_SESSION,
        MAX_LIVE_STAGING_BYTES, MAX_PARTS, MAX_RATIO, MIB, kind_cap,
    };
    pub use crate::session::{Budgets, PartSourceInput};
    pub use crate::source::{FileSource, Source};
    pub use crate::staging::is_valid_staging_name;
}

uniffi::setup_scaffolding!();
