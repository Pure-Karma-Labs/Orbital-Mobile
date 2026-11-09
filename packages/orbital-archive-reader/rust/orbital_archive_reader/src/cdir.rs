//! Streaming central-directory iterator.
//!
//! The whole central directory is never held in memory: a 1 MiB window slides
//! over it, and every byte is read from the source exactly once so the CRC-32
//! change-detector can be folded in as the window refills.
//!
//! The cancel flag is polled on every refill (per 1 MiB) and every 10,000
//! records (F4), which bounds the work a cancelled listing can still do.

#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation,
    clippy::unwrap_used,
    clippy::expect_used
)]

use crate::cancel::CancelFlag;
use crate::error::{ArchiveError, ArchiveResult};
use crate::limits::{CANCEL_CHECK_RECORDS, CD_BUFFER_BYTES, MAX_CD_ENTRIES_PER_PART};
use crate::num::{add64, addus, le_u16, le_u32, le_u64, slice_at, sub64, subus, to_u64, to_usize};
use crate::source::Source;

const CD_SIG: u32 = 0x0201_4b50;
const CD_FIXED: usize = 46;
const U32_MAX64: u64 = u32::MAX as u64;
/// `Number.MAX_SAFE_INTEGER`. A declared size above this cannot survive the
/// JS boundary intact, so the entry is marked corrupt rather than silently
/// rounded (F6).
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// One central-directory record, as parsed. `name` is raw bytes: hygiene and
/// UTF-8 validation happen in `path.rs`.
#[derive(Debug, Clone)]
pub struct CdRecord {
    /// Raw central-directory ordinal, counted before any filtering (F6).
    pub ordinal: u64,
    pub name: Vec<u8>,
    pub flags: u16,
    pub method: u16,
    pub crc32: u32,
    pub comp_size: u64,
    pub uncomp_size: u64,
    pub lh_offset: u64,
    pub version_made_by: u16,
    pub external_attrs: u32,
    pub disk_start: u32,
    /// A size or offset exceeded `MAX_SAFE_INTEGER` and was clamped.
    pub saturated: bool,
}

impl CdRecord {
    /// ZIP's "made by" high byte: 3 = Unix, so the external attributes carry a
    /// `st_mode`.
    #[must_use]
    pub fn unix_mode(&self) -> Option<u32> {
        let host = self.version_made_by >> 8;
        if host == 3 {
            Some(self.external_attrs >> 16)
        } else {
            None
        }
    }
}

/// Sliding-window reader over one part's central directory.
pub struct CdReader<'a> {
    src: &'a dyn Source,
    /// Absolute offset of the next unread CD byte.
    next_read: u64,
    /// Absolute end of the central directory.
    cd_end: u64,
    buf: Vec<u8>,
    /// Valid bytes in `buf`.
    filled: usize,
    /// Cursor into `buf`.
    cursor: usize,
    hasher: crc32fast::Hasher,
    cancel: CancelFlag,
    ordinal: u64,
    finished: bool,
}

impl<'a> CdReader<'a> {
    pub fn new(
        src: &'a dyn Source,
        cd_offset: u64,
        cd_size: u64,
        cancel: CancelFlag,
    ) -> ArchiveResult<Self> {
        Ok(Self {
            src,
            next_read: cd_offset,
            cd_end: add64(cd_offset, cd_size)?,
            buf: vec![0u8; CD_BUFFER_BYTES],
            filled: 0,
            cursor: 0,
            hasher: crc32fast::Hasher::new(),
            cancel,
            ordinal: 0,
            finished: false,
        })
    }

    /// CRC-32 over every central-directory byte. Only valid once iteration has
    /// run to completion.
    #[must_use]
    pub fn cd_crc32(&self) -> u32 {
        self.hasher.clone().finalize()
    }

    /// Records yielded so far.
    #[must_use]
    pub fn count(&self) -> u64 {
        self.ordinal
    }

    fn available(&self) -> ArchiveResult<usize> {
        subus(self.filled, self.cursor)
    }

    /// Makes at least `need` bytes available, or returns `Corrupt` when the
    /// central directory ends mid-record.
    fn ensure(&mut self, need: usize) -> ArchiveResult<()> {
        if self.available()? >= need {
            return Ok(());
        }
        if need > self.buf.len() {
            // A single record larger than the window is impossible: the three
            // variable fields are u16-bounded.
            return Err(ArchiveError::Corrupt);
        }
        // Compact.
        let leftover = self.available()?;
        self.buf.copy_within(self.cursor..self.filled, 0);
        self.cursor = 0;
        self.filled = leftover;

        self.cancel.check()?;

        let remaining_src = sub64(self.cd_end, self.next_read)?;
        let room = subus(self.buf.len(), self.filled)?;
        let want = to_usize(remaining_src.min(to_u64(room)))?;
        if want == 0 {
            return Err(ArchiveError::Corrupt);
        }
        let end = addus(self.filled, want)?;
        let dst = self
            .buf
            .get_mut(self.filled..end)
            .ok_or(ArchiveError::Internal)?;
        self.src.read_exact_at(dst, self.next_read)?;
        self.hasher.update(dst);
        self.filled = end;
        self.next_read = add64(self.next_read, to_u64(want))?;

        if self.available()? < need {
            return Err(ArchiveError::Corrupt);
        }
        Ok(())
    }

    fn head(&self, len: usize) -> ArchiveResult<&[u8]> {
        slice_at(&self.buf, self.cursor, len)
    }

    /// Next record, or `None` at the end of the central directory.
    pub fn next_record(&mut self) -> ArchiveResult<Option<CdRecord>> {
        if self.finished {
            return Ok(None);
        }
        if self.available()? == 0 && self.next_read >= self.cd_end {
            self.finished = true;
            return Ok(None);
        }
        if self.ordinal.is_multiple_of(CANCEL_CHECK_RECORDS) {
            self.cancel.check()?;
        }

        self.ensure(CD_FIXED)?;
        let fixed = self.head(CD_FIXED)?;
        if le_u32(fixed, 0)? != CD_SIG {
            return Err(ArchiveError::Corrupt);
        }
        let version_made_by = le_u16(fixed, 4)?;
        let flags = le_u16(fixed, 8)?;
        let method = le_u16(fixed, 10)?;
        let crc32 = le_u32(fixed, 16)?;
        let comp_32 = u64::from(le_u32(fixed, 20)?);
        let uncomp_32 = u64::from(le_u32(fixed, 24)?);
        let name_len = usize::from(le_u16(fixed, 28)?);
        let extra_len = usize::from(le_u16(fixed, 30)?);
        let comment_len = usize::from(le_u16(fixed, 32)?);
        let disk_32 = u32::from(le_u16(fixed, 34)?);
        let external_attrs = le_u32(fixed, 38)?;
        let lh_32 = u64::from(le_u32(fixed, 42)?);

        let total = addus(
            CD_FIXED,
            addus(name_len, addus(extra_len, comment_len)?)?,
        )?;
        self.ensure(total)?;
        let record = self.head(total)?;
        let name = slice_at(record, CD_FIXED, name_len)?.to_vec();
        let extra = slice_at(record, addus(CD_FIXED, name_len)?, extra_len)?;

        let z = parse_zip64_extra(extra, uncomp_32, comp_32, lh_32, disk_32)?;

        self.cursor = addus(self.cursor, total)?;
        let ordinal = self.ordinal;
        self.ordinal = add64(self.ordinal, 1)?;
        if self.ordinal > MAX_CD_ENTRIES_PER_PART {
            return Err(ArchiveError::TooManyEntries);
        }

        let (uncomp_size, sat_a) = saturate(z.uncomp);
        let (comp_size, sat_b) = saturate(z.comp);

        Ok(Some(CdRecord {
            ordinal,
            name,
            flags,
            method,
            crc32,
            comp_size,
            uncomp_size,
            lh_offset: z.lh_offset,
            version_made_by,
            external_attrs,
            disk_start: z.disk,
            saturated: sat_a || sat_b,
        }))
    }
}

fn saturate(v: u64) -> (u64, bool) {
    if v > MAX_SAFE_INTEGER {
        (MAX_SAFE_INTEGER, true)
    } else {
        (v, false)
    }
}

struct Zip64Fields {
    uncomp: u64,
    comp: u64,
    lh_offset: u64,
    disk: u32,
}

/// Reads the 0x0001 ZIP64 extra field. Fields are present **only** for the
/// 32-bit values that are saturated, and strictly in this order.
fn parse_zip64_extra(
    extra: &[u8],
    uncomp_32: u64,
    comp_32: u64,
    lh_32: u64,
    disk_32: u32,
) -> ArchiveResult<Zip64Fields> {
    let mut out = Zip64Fields {
        uncomp: uncomp_32,
        comp: comp_32,
        lh_offset: lh_32,
        disk: disk_32,
    };
    let mut pos = 0usize;
    while let Ok(id) = le_u16(extra, pos) {
        let size = usize::from(le_u16(extra, addus(pos, 2)?)?);
        let data_at = addus(pos, 4)?;
        let data = slice_at(extra, data_at, size)?;
        if id == 0x0001 {
            let mut p = 0usize;
            if uncomp_32 == U32_MAX64 {
                out.uncomp = le_u64(data, p)?;
                p = addus(p, 8)?;
            }
            if comp_32 == U32_MAX64 {
                out.comp = le_u64(data, p)?;
                p = addus(p, 8)?;
            }
            if lh_32 == U32_MAX64 {
                out.lh_offset = le_u64(data, p)?;
                p = addus(p, 8)?;
            }
            if disk_32 == u32::from(u16::MAX) {
                out.disk = le_u32(data, p)?;
            }
            return Ok(out);
        }
        pos = addus(data_at, size)?;
    }
    // No ZIP64 extra. Saturated 32-bit fields with no extra to read from are
    // geometry we cannot trust.
    if uncomp_32 == U32_MAX64 || comp_32 == U32_MAX64 || lh_32 == U32_MAX64 {
        return Err(ArchiveError::Corrupt);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::arithmetic_side_effects,
        clippy::indexing_slicing,
        clippy::unwrap_used,
        clippy::expect_used
    )]

    use super::*;

    #[test]
    fn saturation_is_per_value() {
        assert_eq!(saturate(5), (5, false));
        assert_eq!(saturate(MAX_SAFE_INTEGER), (MAX_SAFE_INTEGER, false));
        assert_eq!(
            saturate(MAX_SAFE_INTEGER + 1),
            (MAX_SAFE_INTEGER, true)
        );
    }

    #[test]
    fn zip64_extra_is_order_sensitive() {
        // uncomp saturated only: 8 bytes of data.
        let mut extra = vec![0x01, 0x00, 0x08, 0x00];
        extra.extend_from_slice(&5_000_000_000u64.to_le_bytes());
        let z = parse_zip64_extra(&extra, U32_MAX64, 7, 9, 0).expect("parse");
        assert_eq!(z.uncomp, 5_000_000_000);
        assert_eq!(z.comp, 7);
        assert_eq!(z.lh_offset, 9);
    }

    #[test]
    fn saturated_field_without_zip64_extra_is_corrupt() {
        assert_eq!(
            parse_zip64_extra(&[], U32_MAX64, 1, 1, 0).err(),
            Some(ArchiveError::Corrupt)
        );
    }

    #[test]
    fn unknown_extra_fields_are_skipped() {
        let mut extra = vec![0x99, 0x99, 0x02, 0x00, 0xAA, 0xBB];
        extra.extend_from_slice(&[0x01, 0x00, 0x08, 0x00]);
        extra.extend_from_slice(&42u64.to_le_bytes());
        let z = parse_zip64_extra(&extra, U32_MAX64, 1, 1, 0).expect("parse");
        assert_eq!(z.uncomp, 42);
    }
}
