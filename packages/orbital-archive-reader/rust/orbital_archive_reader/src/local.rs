//! Local file header verification.
//!
//! The central directory is authoritative, so the local header is read only to
//! find where the data starts and to prove the two agree. Disagreement is
//! `EntryCorrupt` for that one entry — never an archive-wide failure.
//!
//! The `data_end <= next_local_header_offset` check is the defence against
//! overlapping-entry bombs (Fifield): without it, one physical deflate stream
//! can be claimed by thousands of central-directory records.

#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation,
    clippy::unwrap_used,
    clippy::expect_used
)]

use crate::cdir::CdRecord;
use crate::error::{ArchiveError, EntryFault, EntryResult};
use crate::num::{add64, addus, le_u16, le_u32, to_u64};
use crate::source::{Source, read_exact_vec};
use crate::types::EntrySkipCode;

const LH_SIG: u32 = 0x0403_4b50;
const LH_FIXED: usize = 30;
const U32_MAX64: u64 = u32::MAX as u64;

/// General-purpose bit 0: traditional PKWARE encryption.
pub const FLAG_ENCRYPTED: u16 = 1 << 0;
/// General-purpose bit 3: sizes live in a data descriptor after the data.
pub const FLAG_DATA_DESCRIPTOR: u16 = 1 << 3;
/// General-purpose bit 6: strong encryption.
pub const FLAG_STRONG_ENCRYPTION: u16 = 1 << 6;

/// Where an entry's compressed bytes begin and end.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DataSpan {
    pub start: u64,
    pub len: u64,
}

/// Smallest local-header offset strictly greater than `lh_offset`, falling back
/// to the start of the central directory. `sorted` must be ascending.
#[must_use]
pub fn next_boundary(sorted: &[u64], lh_offset: u64, cd_offset: u64) -> u64 {
    let idx = sorted.partition_point(|&o| o <= lh_offset);
    match sorted.get(idx) {
        Some(&next) if next <= cd_offset => next,
        _ => cd_offset,
    }
}

/// Verifies the local header of `rec` and returns its data span.
pub fn verify(
    src: &dyn Source,
    rec: &CdRecord,
    lh_offsets: &[u64],
    cd_offset: u64,
) -> EntryResult<DataSpan> {
    if rec.lh_offset >= cd_offset {
        return Err(EntrySkipCode::EntryCorrupt.into());
    }
    let header = read_exact_vec(src, rec.lh_offset, LH_FIXED).map_err(EntryFault::Fatal)?;

    let corrupt = || EntryFault::Skip(EntrySkipCode::EntryCorrupt);

    if le_u32(&header, 0).map_err(EntryFault::Fatal)? != LH_SIG {
        return Err(corrupt());
    }
    let flags = le_u16(&header, 6).map_err(EntryFault::Fatal)?;
    let method = le_u16(&header, 8).map_err(EntryFault::Fatal)?;
    let crc = le_u32(&header, 14).map_err(EntryFault::Fatal)?;
    let comp_32 = u64::from(le_u32(&header, 18).map_err(EntryFault::Fatal)?);
    let uncomp_32 = u64::from(le_u32(&header, 22).map_err(EntryFault::Fatal)?);
    let name_len = usize::from(le_u16(&header, 26).map_err(EntryFault::Fatal)?);
    let extra_len = usize::from(le_u16(&header, 28).map_err(EntryFault::Fatal)?);

    if method != rec.method {
        return Err(corrupt());
    }
    // Encryption bits must agree: an archive that claims "not encrypted" in the
    // central directory and "encrypted" locally is lying to one of its readers.
    let enc_mask = FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION;
    if (flags & enc_mask) != (rec.flags & enc_mask) {
        return Err(corrupt());
    }

    if name_len != rec.name.len() {
        return Err(corrupt());
    }
    let name_at = add64(rec.lh_offset, to_u64(LH_FIXED)).map_err(EntryFault::Fatal)?;
    let name = read_exact_vec(src, name_at, name_len).map_err(EntryFault::Fatal)?;
    if name != rec.name {
        return Err(corrupt());
    }

    if (flags & FLAG_DATA_DESCRIPTOR) == 0 {
        // Without bit 3 the local sizes and CRC must equal the central
        // directory's. 0xFFFFFFFF is the ZIP64 sentinel and is accepted.
        let crc_ok = crc == rec.crc32;
        let comp_ok = comp_32 == rec.comp_size || comp_32 == U32_MAX64;
        let uncomp_ok = uncomp_32 == rec.uncomp_size || uncomp_32 == U32_MAX64;
        if !(crc_ok && comp_ok && uncomp_ok) {
            return Err(corrupt());
        }
    }
    // With bit 3 set the central directory stays authoritative and the trailing
    // data descriptor is never read.

    let data_start = add64(
        name_at,
        to_u64(addus(name_len, extra_len).map_err(EntryFault::Fatal)?),
    )
    .map_err(EntryFault::Fatal)?;
    let data_end = add64(data_start, rec.comp_size).map_err(EntryFault::Fatal)?;

    let boundary = next_boundary(lh_offsets, rec.lh_offset, cd_offset);
    if data_end > boundary || data_end > src.len() {
        return Err(corrupt());
    }
    if data_start > data_end {
        return Err(EntryFault::Fatal(ArchiveError::Internal));
    }

    Ok(DataSpan {
        start: data_start,
        len: rec.comp_size,
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::indexing_slicing, clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    #[test]
    fn boundary_is_the_next_header_or_the_central_directory() {
        let offs = [0u64, 100, 500];
        assert_eq!(next_boundary(&offs, 0, 900), 100);
        assert_eq!(next_boundary(&offs, 100, 900), 500);
        assert_eq!(next_boundary(&offs, 500, 900), 900);
        // Duplicated offsets (two records pointing at one header) must not
        // produce a zero-length window that silently passes.
        let dup = [100u64, 100, 500];
        assert_eq!(next_boundary(&dup, 100, 900), 500);
    }
}
