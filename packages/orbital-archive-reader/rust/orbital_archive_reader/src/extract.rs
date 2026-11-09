//! The copy/inflate loop and its budgets.
//!
//! Every bound that matters against a hostile archive is enforced *inside* this
//! loop, not after it: the kind cap, the compression ratio, the session byte
//! budget and the cancel flag. A bomb therefore costs at most one chunk beyond
//! the limit, never a full expansion.

#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation,
    clippy::unwrap_used,
    clippy::expect_used
)]

use flate2::{Decompress, FlushDecompress, Status};

use crate::cancel::CancelFlag;
use crate::cdir::CdRecord;
use crate::error::{ArchiveError, EntryFault, EntryResult};
use crate::limits::{COPY_CHUNK_BYTES, HEAD_BYTES, MAX_RATIO, RATIO_GRACE_BYTES};
use crate::local::{DataSpan, FLAG_ENCRYPTED, FLAG_STRONG_ENCRYPTION};
use crate::num::{add64, mul64, slice_at, sub64, to_u64, to_usize};
use crate::source::Source;
use crate::staging::StagingFile;
use crate::types::EntrySkipCode;

const METHOD_STORED: u16 = 0;
const METHOD_DEFLATE: u16 = 8;
/// WinZip AES.
const METHOD_AE_X: u16 = 99;

const S_IFMT: u32 = 0o170_000;
const S_IFLNK: u32 = 0o120_000;
const S_IFREG: u32 = 0o100_000;
const S_IFDIR: u32 = 0o040_000;

/// Container magic numbers. An entry whose plaintext starts with one of these
/// is a nested archive regardless of its extension.
const ARCHIVE_MAGICS: [&[u8]; 7] = [
    b"PK\x03\x04",
    b"7z\xBC\xAF\x27\x1C",
    b"Rar!\x1A\x07",
    b"\x1F\x8B",
    b"\xFD7zXZ\x00",
    b"\x28\xB5\x2F\xFD",
    b"BZh",
];

#[must_use]
pub fn looks_like_archive(head: &[u8]) -> bool {
    ARCHIVE_MAGICS.iter().any(|m| head.starts_with(m))
}

/// Where decoded bytes go.
pub trait ByteSink {
    fn write(&mut self, buf: &[u8]) -> Result<(), ArchiveError>;
}

impl ByteSink for StagingFile {
    fn write(&mut self, buf: &[u8]) -> Result<(), ArchiveError> {
        self.write_all(buf)
    }
}

impl ByteSink for Vec<u8> {
    fn write(&mut self, buf: &[u8]) -> Result<(), ArchiveError> {
        self.extend_from_slice(buf);
        Ok(())
    }
}

/// Discards output; used by `peek_head`, which only needs the head bytes.
pub struct NullSink;

impl ByteSink for NullSink {
    fn write(&mut self, _buf: &[u8]) -> Result<(), ArchiveError> {
        Ok(())
    }
}

/// Budgets for one streaming decode.
#[derive(Debug, Clone, Copy)]
pub struct StreamLimits {
    /// The central directory's uncompressed size (authoritative).
    pub declared: u64,
    /// The kind cap from `limits.rs`.
    pub cap: u64,
    /// Bytes still available in the session budget.
    pub session_remaining: u64,
    /// `Some(n)` stops cleanly after `n` bytes without a CRC check (peek).
    pub max_output: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct StreamOutcome {
    pub byte_length: u64,
    pub head: Vec<u8>,
}

/// Checks everything that can be decided without reading entry data.
pub fn precheck(rec: &CdRecord, cap: u64) -> Result<(), EntrySkipCode> {
    if rec.saturated {
        // A size beyond MAX_SAFE_INTEGER: this one entry is unusable, the
        // archive is not (F6).
        return Err(EntrySkipCode::EntryCorrupt);
    }
    if rec.disk_start != 0 {
        return Err(EntrySkipCode::EntryCorrupt);
    }
    if let Some(mode) = rec.unix_mode() {
        let kind = mode & S_IFMT;
        if kind == S_IFLNK {
            return Err(EntrySkipCode::EntrySymlink);
        }
        if kind == S_IFDIR {
            return Err(EntrySkipCode::EntrySpecialFile);
        }
        // Mode 0 means "no mode recorded", which is common and benign.
        if kind != 0 && kind != S_IFREG {
            return Err(EntrySkipCode::EntrySpecialFile);
        }
    }
    if (rec.flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) != 0 || rec.method == METHOD_AE_X {
        return Err(EntrySkipCode::EntryEncrypted);
    }
    if rec.method != METHOD_STORED && rec.method != METHOD_DEFLATE {
        return Err(EntrySkipCode::EntryUnsupportedMethod);
    }
    if rec.uncomp_size > cap {
        return Err(EntrySkipCode::EntryOverCap);
    }
    // Declared ratio, before a single byte is inflated.
    if rec.uncomp_size > RATIO_GRACE_BYTES {
        let allowed = rec.comp_size.saturating_mul(MAX_RATIO);
        if rec.uncomp_size > allowed {
            return Err(EntrySkipCode::EntryRatioExceeded);
        }
    }
    Ok(())
}

enum Decoder {
    Stored,
    Deflate(Box<Decompress>),
}

struct Emitter<'s, S: ByteSink> {
    sink: &'s mut S,
    hasher: crc32fast::Hasher,
    written: u64,
    head: Vec<u8>,
    stop: bool,
}

impl<S: ByteSink> Emitter<'_, S> {
    fn emit(&mut self, chunk: &[u8], limits: &StreamLimits, consumed_comp: u64) -> EntryResult<()> {
        let mut chunk = chunk;
        if let Some(max) = limits.max_output {
            let room = sub64(max, self.written.min(max)).map_err(EntryFault::Fatal)?;
            let room = to_usize(room).map_err(EntryFault::Fatal)?;
            if chunk.len() >= room {
                chunk = slice_at(chunk, 0, room).map_err(EntryFault::Fatal)?;
                self.stop = true;
            }
        }
        if chunk.is_empty() {
            return Ok(());
        }

        self.written = add64(self.written, to_u64(chunk.len())).map_err(EntryFault::Fatal)?;

        if self.written > limits.session_remaining {
            return Err(EntryFault::Fatal(ArchiveError::SessionBytesExceeded));
        }
        if self.written > limits.cap {
            return Err(EntryFault::Skip(EntrySkipCode::EntryOverCap));
        }
        if limits.max_output.is_none() && self.written > limits.declared {
            // The central directory lied about the uncompressed size.
            return Err(EntryFault::Skip(EntrySkipCode::EntryCorrupt));
        }
        if self.written > RATIO_GRACE_BYTES {
            let allowed = mul64(consumed_comp, MAX_RATIO).map_err(EntryFault::Fatal)?;
            if self.written > allowed {
                return Err(EntryFault::Skip(EntrySkipCode::EntryRatioExceeded));
            }
        }

        if self.head.len() < HEAD_BYTES {
            let room = HEAD_BYTES.saturating_sub(self.head.len());
            let take = room.min(chunk.len());
            self.head
                .extend_from_slice(slice_at(chunk, 0, take).map_err(EntryFault::Fatal)?);
            if looks_like_archive(&self.head) {
                return Err(EntryFault::Skip(EntrySkipCode::EntryNestedArchive));
            }
        }

        self.hasher.update(chunk);
        self.sink.write(chunk).map_err(EntryFault::Fatal)?;
        Ok(())
    }
}

/// Streams one entry's data through `sink`, enforcing `limits` as it goes.
pub fn stream_entry<S: ByteSink>(
    src: &dyn Source,
    span: DataSpan,
    rec: &CdRecord,
    limits: &StreamLimits,
    cancel: &CancelFlag,
    sink: &mut S,
) -> EntryResult<StreamOutcome> {
    let mut decoder = if rec.method == METHOD_STORED {
        Decoder::Stored
    } else {
        Decoder::Deflate(Box::new(Decompress::new(false)))
    };

    let mut emitter = Emitter {
        sink,
        hasher: crc32fast::Hasher::new(),
        written: 0,
        head: Vec::with_capacity(HEAD_BYTES),
        stop: false,
    };

    let mut inbuf = vec![0u8; COPY_CHUNK_BYTES];
    let mut outbuf = vec![0u8; COPY_CHUNK_BYTES];
    let mut offset = span.start;
    let mut comp_left = span.len;
    let mut consumed_comp = 0u64;
    let mut stream_end = false;

    while !stream_end && !emitter.stop {
        cancel.check().map_err(EntryFault::Fatal)?;

        let want = to_usize(comp_left.min(to_u64(COPY_CHUNK_BYTES))).map_err(EntryFault::Fatal)?;
        if want == 0 {
            // Input exhausted. STORED is simply done; DEFLATE that never
            // reached its end-of-stream marker is a truncated entry.
            if matches!(decoder, Decoder::Stored) {
                stream_end = true;
                break;
            }
            return Err(EntryFault::Skip(EntrySkipCode::EntryCorrupt));
        }
        let chunk = inbuf.get_mut(..want).ok_or(ArchiveError::Internal)?;
        src.read_exact_at(chunk, offset)
            .map_err(EntryFault::Fatal)?;
        offset = add64(offset, to_u64(want)).map_err(EntryFault::Fatal)?;
        comp_left = sub64(comp_left, to_u64(want)).map_err(EntryFault::Fatal)?;
        consumed_comp = add64(consumed_comp, to_u64(want)).map_err(EntryFault::Fatal)?;

        match &mut decoder {
            Decoder::Stored => {
                let data = slice_at(&inbuf, 0, want).map_err(EntryFault::Fatal)?;
                emitter.emit(data, limits, consumed_comp)?;
                if comp_left == 0 && !emitter.stop {
                    stream_end = true;
                }
            }
            Decoder::Deflate(dec) => {
                let mut in_pos = 0usize;
                loop {
                    let before_in = dec.total_in();
                    let before_out = dec.total_out();
                    let input = slice_at(&inbuf, in_pos, want.saturating_sub(in_pos))
                        .map_err(EntryFault::Fatal)?;
                    let status = dec
                        .decompress(input, &mut outbuf, FlushDecompress::None)
                        .map_err(|_| EntryFault::Skip(EntrySkipCode::EntryCorrupt))?;
                    let used =
                        to_usize(sub64(dec.total_in(), before_in).map_err(EntryFault::Fatal)?)
                            .map_err(EntryFault::Fatal)?;
                    let made =
                        to_usize(sub64(dec.total_out(), before_out).map_err(EntryFault::Fatal)?)
                            .map_err(EntryFault::Fatal)?;
                    in_pos = in_pos.saturating_add(used);
                    if made > 0 {
                        let out = slice_at(&outbuf, 0, made).map_err(EntryFault::Fatal)?;
                        emitter.emit(out, limits, consumed_comp)?;
                    }
                    if emitter.stop {
                        break;
                    }
                    if status == Status::StreamEnd {
                        stream_end = true;
                        break;
                    }
                    if used == 0 && made == 0 {
                        // Needs more input.
                        break;
                    }
                }
            }
        }
    }

    let _ = stream_end;
    // A peek (`max_output`) never verifies CRC or size: it decodes a prefix on
    // purpose. A full decode always does, and the central directory wins.
    if limits.max_output.is_none() {
        // Full decode: the central directory's CRC and size are authoritative.
        if emitter.hasher.clone().finalize() != rec.crc32 {
            return Err(EntryFault::Skip(EntrySkipCode::EntryCorrupt));
        }
        if emitter.written != rec.uncomp_size {
            return Err(EntryFault::Skip(EntrySkipCode::EntryCorrupt));
        }
    }

    Ok(StreamOutcome {
        byte_length: emitter.written,
        head: emitter.head.clone(),
    })
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
    fn magic_detection_covers_the_container_family() {
        assert!(looks_like_archive(b"PK\x03\x04rest"));
        assert!(looks_like_archive(b"\x1F\x8B\x08"));
        assert!(looks_like_archive(b"BZh9"));
        assert!(looks_like_archive(b"\xFD7zXZ\x00"));
        assert!(!looks_like_archive(b"\xFF\xD8\xFF\xE0jpeg"));
        assert!(!looks_like_archive(b""));
    }
}
