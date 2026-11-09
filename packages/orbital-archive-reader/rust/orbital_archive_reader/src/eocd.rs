//! End-of-central-directory location, including ZIP64.
//!
//! The central directory is the single source of truth for this reader, so
//! locating it correctly is the whole security perimeter. Rules:
//!
//! * The last EOCD candidate whose comment length ends **exactly** at EOF wins.
//!   Anything else lets an attacker hide a second central directory.
//! * `cd_offset + cd_size` must equal the EOCD (or EOCD64) record offset.
//!   Prepended data (a self-extracting stub, a polyglot) is `Corrupt`, not
//!   silently tolerated: tolerating it is how zip-confusion bugs happen.
//! * A multi-disk archive is `Unsupported`.

#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation,
    clippy::unwrap_used,
    clippy::expect_used
)]

use crate::cancel::CancelFlag;
use crate::error::{ArchiveError, ArchiveResult};
use crate::limits::{MAX_CD_BYTES_PER_PART, MAX_ZIP_COMMENT_BYTES, MIN_ZIP_BYTES};
use crate::num::{add64, le_u16, le_u32, le_u64, slice_at, sub64, to_u64, to_usize};
use crate::source::{Source, read_exact_vec};

const EOCD_SIG: u32 = 0x0605_4b50;
const EOCD64_LOCATOR_SIG: u32 = 0x0706_4b50;
const EOCD64_SIG: u32 = 0x0606_4b50;

const EOCD_MIN: u64 = 22;
const EOCD64_LOCATOR_LEN: u64 = 20;
const EOCD64_MIN: u64 = 56;

/// Where the central directory lives and how many records it declares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EocdInfo {
    pub cd_offset: u64,
    pub cd_size: u64,
    pub declared_entries: u64,
    /// Offset of the record the CD must end at (EOCD, or EOCD64 when present).
    pub cd_end_anchor: u64,
    pub zip64: bool,
}

/// Locates the central directory of one part.
pub fn locate(src: &dyn Source, cancel: &CancelFlag) -> ArchiveResult<EocdInfo> {
    let file_len = src.len();
    if file_len < MIN_ZIP_BYTES {
        return Err(ArchiveError::NotZip);
    }

    cancel.check()?;

    let window = add64(EOCD_MIN, MAX_ZIP_COMMENT_BYTES)?.min(file_len);
    let window_start = sub64(file_len, window)?;
    let tail = read_exact_vec(src, window_start, to_usize(window)?)?;

    let eocd_rel = find_eocd(&tail, cancel)?;
    let eocd_abs = add64(window_start, to_u64(eocd_rel))?;

    let disk = le_u16(&tail, add64(to_u64(eocd_rel), 4).and_then(to_usize)?)?;
    let cd_disk = le_u16(&tail, add64(to_u64(eocd_rel), 6).and_then(to_usize)?)?;
    if disk != 0 || cd_disk != 0 {
        return Err(ArchiveError::Unsupported);
    }

    let base = to_usize(to_u64(eocd_rel))?;
    let entries_32 = u64::from(le_u16(&tail, base.saturating_add(10))?);
    let cd_size_32 = u64::from(le_u32(&tail, base.saturating_add(12))?);
    let cd_offset_32 = u64::from(le_u32(&tail, base.saturating_add(16))?);

    // A saturated size or offset REQUIRES a ZIP64 record: without one there is
    // no way to learn the real geometry. A saturated entry count does not --
    // 0xFFFF only means "more than 65535 records", and both Info-ZIP and
    // CPython write that value in the 32-bit EOCD while the records themselves
    // remain countable. Treating the count as fatal would reject real
    // multi-part exports; the counted value is checked against the per-part
    // bound regardless, so nothing can hide behind the saturation.
    let needs_zip64 = cd_size_32 == u64::from(u32::MAX) || cd_offset_32 == u64::from(u32::MAX);

    let info = match read_zip64(src, eocd_abs, &tail, window_start, eocd_rel)? {
        Some(z) => z,
        None => {
            if needs_zip64 {
                // The 32-bit fields are saturated but there is no ZIP64 record
                // to read the real values from.
                return Err(ArchiveError::Corrupt);
            }
            EocdInfo {
                cd_offset: cd_offset_32,
                cd_size: cd_size_32,
                declared_entries: entries_32,
                cd_end_anchor: eocd_abs,
                zip64: false,
            }
        }
    };

    if info.cd_size > MAX_CD_BYTES_PER_PART {
        return Err(ArchiveError::TooManyEntries);
    }
    // Strict layout: the CD must end exactly where its anchor record begins.
    if add64(info.cd_offset, info.cd_size)? != info.cd_end_anchor {
        return Err(ArchiveError::Corrupt);
    }
    if info.cd_offset > file_len || info.cd_end_anchor > file_len {
        return Err(ArchiveError::Corrupt);
    }

    Ok(info)
}

/// Highest EOCD whose comment ends exactly at the end of the window.
fn find_eocd(tail: &[u8], cancel: &CancelFlag) -> ArchiveResult<usize> {
    let tail_len = tail.len();
    if tail_len < to_usize(EOCD_MIN)? {
        return Err(ArchiveError::NotZip);
    }
    let mut pos = tail_len.saturating_sub(to_usize(EOCD_MIN)?);
    let mut polled = 0usize;
    loop {
        polled = polled.saturating_add(1);
        if polled.is_multiple_of(4096) {
            cancel.check()?;
        }
        if le_u32(tail, pos).is_ok_and(|sig| sig == EOCD_SIG) {
            let comment_len = u64::from(le_u16(tail, pos.saturating_add(20))?);
            let after_header = add64(to_u64(pos), EOCD_MIN)?;
            if add64(after_header, comment_len)? == to_u64(tail_len) {
                return Ok(pos);
            }
        }
        if pos == 0 {
            return Err(ArchiveError::NotZip);
        }
        pos = pos.saturating_sub(1);
    }
}

/// Reads the ZIP64 locator + record if one is present directly before the EOCD.
fn read_zip64(
    src: &dyn Source,
    eocd_abs: u64,
    tail: &[u8],
    window_start: u64,
    eocd_rel: usize,
) -> ArchiveResult<Option<EocdInfo>> {
    if eocd_abs < EOCD64_LOCATOR_LEN {
        return Ok(None);
    }
    let locator_abs = sub64(eocd_abs, EOCD64_LOCATOR_LEN)?;
    // The locator is inside the already-read tail whenever the EOCD is far
    // enough into it; otherwise read it directly.
    let locator = if locator_abs >= window_start {
        let rel = to_usize(sub64(locator_abs, window_start)?)?;
        slice_at(tail, rel, to_usize(EOCD64_LOCATOR_LEN)?)?.to_vec()
    } else {
        read_exact_vec(src, locator_abs, to_usize(EOCD64_LOCATOR_LEN)?)?
    };
    let _ = eocd_rel;

    if le_u32(&locator, 0)? != EOCD64_LOCATOR_SIG {
        return Ok(None);
    }
    let locator_disk = le_u32(&locator, 4)?;
    let total_disks = le_u32(&locator, 16)?;
    if locator_disk != 0 || total_disks > 1 {
        return Err(ArchiveError::Unsupported);
    }
    let rec_abs = le_u64(&locator, 8)?;
    if add64(rec_abs, EOCD64_MIN)? > locator_abs {
        // A lying locator: the record cannot fit before the locator.
        return Err(ArchiveError::Corrupt);
    }

    let rec = read_exact_vec(src, rec_abs, to_usize(EOCD64_MIN)?)?;
    if le_u32(&rec, 0)? != EOCD64_SIG {
        return Err(ArchiveError::Corrupt);
    }
    if le_u32(&rec, 16)? != 0 || le_u32(&rec, 20)? != 0 {
        return Err(ArchiveError::Unsupported);
    }
    let declared_entries = le_u64(&rec, 32)?;
    let cd_size = le_u64(&rec, 40)?;
    let cd_offset = le_u64(&rec, 48)?;

    Ok(Some(EocdInfo {
        cd_offset,
        cd_size,
        declared_entries,
        cd_end_anchor: rec_abs,
        zip64: true,
    }))
}
