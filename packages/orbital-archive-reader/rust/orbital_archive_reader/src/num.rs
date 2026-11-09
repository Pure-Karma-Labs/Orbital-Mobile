//! Checked arithmetic and bounds-checked slice helpers.
//!
//! The parser modules deny `clippy::arithmetic_side_effects`,
//! `clippy::indexing_slicing` and `clippy::cast_possible_truncation`. Every
//! offset computation there goes through these helpers, so an attacker-supplied
//! length can never wrap or panic: it becomes a typed error instead.

#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation,
    clippy::unwrap_used,
    clippy::expect_used
)]

use crate::error::{ArchiveError, ArchiveResult};

/// Overflow in a size computation means the archive is lying about geometry.
#[inline]
pub fn add64(a: u64, b: u64) -> ArchiveResult<u64> {
    a.checked_add(b).ok_or(ArchiveError::Corrupt)
}

#[inline]
pub fn sub64(a: u64, b: u64) -> ArchiveResult<u64> {
    a.checked_sub(b).ok_or(ArchiveError::Corrupt)
}

#[inline]
pub fn mul64(a: u64, b: u64) -> ArchiveResult<u64> {
    a.checked_mul(b).ok_or(ArchiveError::Corrupt)
}

#[inline]
pub fn addus(a: usize, b: usize) -> ArchiveResult<usize> {
    a.checked_add(b).ok_or(ArchiveError::Corrupt)
}

#[inline]
pub fn subus(a: usize, b: usize) -> ArchiveResult<usize> {
    a.checked_sub(b).ok_or(ArchiveError::Corrupt)
}

/// `u64 -> usize` without truncation. On a 32-bit target an oversized ZIP64
/// value becomes `Unsupported` rather than a wrapped index.
#[inline]
pub fn to_usize(v: u64) -> ArchiveResult<usize> {
    usize::try_from(v).map_err(|_| ArchiveError::Unsupported)
}

#[inline]
pub fn to_u64(v: usize) -> u64 {
    u64::try_from(v).unwrap_or(u64::MAX)
}

/// Bounds-checked subslice: `[off, off+len)`.
#[inline]
pub fn slice_at(buf: &[u8], off: usize, len: usize) -> ArchiveResult<&[u8]> {
    let end = addus(off, len)?;
    buf.get(off..end).ok_or(ArchiveError::Corrupt)
}

#[inline]
pub fn le_u16(buf: &[u8], off: usize) -> ArchiveResult<u16> {
    let s = slice_at(buf, off, 2)?;
    let arr: [u8; 2] = s.try_into().map_err(|_| ArchiveError::Corrupt)?;
    Ok(u16::from_le_bytes(arr))
}

#[inline]
pub fn le_u32(buf: &[u8], off: usize) -> ArchiveResult<u32> {
    let s = slice_at(buf, off, 4)?;
    let arr: [u8; 4] = s.try_into().map_err(|_| ArchiveError::Corrupt)?;
    Ok(u32::from_le_bytes(arr))
}

#[inline]
pub fn le_u64(buf: &[u8], off: usize) -> ArchiveResult<u64> {
    let s = slice_at(buf, off, 8)?;
    let arr: [u8; 8] = s.try_into().map_err(|_| ArchiveError::Corrupt)?;
    Ok(u64::from_le_bytes(arr))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overflow_is_an_error_not_a_wrap() {
        assert_eq!(add64(u64::MAX, 1), Err(ArchiveError::Corrupt));
        assert_eq!(sub64(0, 1), Err(ArchiveError::Corrupt));
        assert_eq!(mul64(u64::MAX, 2), Err(ArchiveError::Corrupt));
        assert_eq!(addus(usize::MAX, 1), Err(ArchiveError::Corrupt));
    }

    #[test]
    fn slice_reads_are_bounds_checked() {
        let b = [1u8, 2, 3];
        assert_eq!(slice_at(&b, 1, 2), Ok(&b[1..3]));
        assert_eq!(slice_at(&b, 2, 2), Err(ArchiveError::Corrupt));
        assert_eq!(slice_at(&b, usize::MAX, 1), Err(ArchiveError::Corrupt));
        assert_eq!(le_u16(&b, 0), Ok(0x0201));
        assert_eq!(le_u32(&b, 0), Err(ArchiveError::Corrupt));
    }
}
