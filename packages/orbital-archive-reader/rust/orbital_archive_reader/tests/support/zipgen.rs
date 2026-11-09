//! Hostile ZIP generator for the host matrix.
//!
//! Archives are generated in code, never committed: a committed hostile binary
//! is a thing a reader has to trust, and this repo is public. The only
//! committed fixtures are three tiny SYNTHETIC interop archives (see
//! `tests/fixtures/interop/README.md`).
//!
//! Offsets are written relative to the start of the entry region, so a
//! non-empty `prepend` naturally produces the "prepended data" attack shape.

#![allow(dead_code)]

use std::io::Write;

const LH_SIG: u32 = 0x0403_4b50;
const CD_SIG: u32 = 0x0201_4b50;
const DD_SIG: u32 = 0x0807_4b50;
const EOCD_SIG: u32 = 0x0605_4b50;
const EOCD64_SIG: u32 = 0x0606_4b50;
const EOCD64_LOC_SIG: u32 = 0x0706_4b50;

pub const METHOD_STORED: u16 = 0;
pub const METHOD_DEFLATE: u16 = 8;

pub const FLAG_ENCRYPTED: u16 = 1 << 0;
pub const FLAG_DATA_DESCRIPTOR: u16 = 1 << 3;
pub const FLAG_STRONG_ENCRYPTION: u16 = 1 << 6;
pub const FLAG_UTF8: u16 = 1 << 11;

pub const MODE_REGULAR: u32 = 0o100_644;
pub const MODE_SYMLINK: u32 = 0o120_777;
pub const MODE_FIFO: u32 = 0o010_644;
pub const MODE_DIR: u32 = 0o040_755;

#[must_use]
pub fn crc32(data: &[u8]) -> u32 {
    let mut h = crc32fast::Hasher::new();
    h.update(data);
    h.finalize()
}

#[must_use]
pub fn deflate(data: &[u8]) -> Vec<u8> {
    let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::best());
    enc.write_all(data).expect("deflate");
    enc.finish().expect("deflate finish")
}

/// One entry, plus every override a hostile archive might use.
#[derive(Clone)]
pub struct EntrySpec {
    pub name: Vec<u8>,
    pub data: Vec<u8>,
    pub method: u16,
    pub flags: u16,
    pub unix_mode: Option<u32>,
    /// Raw bytes to put in the data region instead of compressing `data`.
    pub raw_data: Option<Vec<u8>>,
    pub cd_crc: Option<u32>,
    pub cd_uncomp: Option<u64>,
    pub cd_comp: Option<u64>,
    pub cd_method: Option<u16>,
    pub cd_flags: Option<u16>,
    pub cd_name: Option<Vec<u8>>,
    pub cd_lh_offset: Option<u64>,
    pub cd_disk_start: Option<u16>,
    pub lh_crc: Option<u32>,
    pub lh_uncomp: Option<u32>,
    pub lh_comp: Option<u32>,
    pub lh_method: Option<u16>,
    pub lh_name: Option<Vec<u8>>,
    pub lh_sig: Option<u32>,
    /// Replaces the central-directory extra field with these exact bytes.
    pub cd_extra: Option<Vec<u8>>,
    pub omit_local_header: bool,
    pub append_data_descriptor: bool,
    /// Force the ZIP64 extra field for this record.
    pub zip64_record: bool,
    pub extra: Vec<u8>,
}

impl EntrySpec {
    #[must_use]
    pub fn stored(name: &str, data: &[u8]) -> Self {
        Self {
            name: name.as_bytes().to_vec(),
            data: data.to_vec(),
            method: METHOD_STORED,
            flags: FLAG_UTF8,
            unix_mode: Some(MODE_REGULAR),
            raw_data: None,
            cd_crc: None,
            cd_uncomp: None,
            cd_comp: None,
            cd_method: None,
            cd_flags: None,
            cd_name: None,
            cd_lh_offset: None,
            cd_disk_start: None,
            lh_crc: None,
            lh_uncomp: None,
            lh_comp: None,
            lh_method: None,
            lh_name: None,
            lh_sig: None,
            cd_extra: None,
            omit_local_header: false,
            append_data_descriptor: false,
            zip64_record: false,
            extra: Vec::new(),
        }
    }

    #[must_use]
    pub fn deflated(name: &str, data: &[u8]) -> Self {
        let mut s = Self::stored(name, data);
        s.method = METHOD_DEFLATE;
        s
    }

    #[must_use]
    pub fn dir(name: &str) -> Self {
        let mut s = Self::stored(name, b"");
        s.unix_mode = Some(MODE_DIR);
        s
    }

    #[must_use]
    pub fn with_mode(mut self, mode: u32) -> Self {
        self.unix_mode = Some(mode);
        self
    }

    #[must_use]
    pub fn with_flags(mut self, flags: u16) -> Self {
        self.flags = flags;
        self
    }

    #[must_use]
    pub fn with_method(mut self, method: u16) -> Self {
        self.method = method;
        self
    }

    fn payload(&self) -> Vec<u8> {
        if let Some(raw) = &self.raw_data {
            return raw.clone();
        }
        match self.method {
            METHOD_DEFLATE => deflate(&self.data),
            _ => self.data.clone(),
        }
    }
}

/// Archive-level overrides.
#[derive(Default, Clone)]
pub struct ZipBuilder {
    pub entries: Vec<EntrySpec>,
    pub comment: Vec<u8>,
    pub prepend: Vec<u8>,
    pub append: Vec<u8>,
    /// Bytes inserted between the last entry and the central directory. The
    /// central-directory offset is computed after them, so the archive stays
    /// strictly well formed — only `cd_offset` and the file length move. That
    /// is the near-duplicate-part shape: the central directory bytes, and hence
    /// their CRC-32, are identical to the unpadded copy's.
    pub pad_before_cd: Vec<u8>,
    pub zip64: bool,
    pub disk_number: u16,
    pub cd_disk: u16,
    pub eocd_entries: Option<u16>,
    pub eocd_cd_offset: Option<u32>,
    pub eocd_cd_size: Option<u32>,
    pub eocd64_entries: Option<u64>,
    pub eocd64_cd_offset: Option<u64>,
    pub eocd64_cd_size: Option<u64>,
    pub eocd64_locator_offset: Option<u64>,
    pub eocd64_total_disks: Option<u32>,
    pub truncate_cd_bytes: usize,
    pub omit_eocd: bool,
    pub comment_len_override: Option<u16>,
}

fn w16(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_le_bytes());
}

fn w32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}

fn w64(out: &mut Vec<u8>, v: u64) {
    out.extend_from_slice(&v.to_le_bytes());
}

fn clamp32(v: u64) -> u32 {
    u32::try_from(v).unwrap_or(u32::MAX)
}

impl ZipBuilder {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn with(mut self, e: EntrySpec) -> Self {
        self.entries.push(e);
        self
    }

    #[must_use]
    pub fn stored(self, name: &str, data: &[u8]) -> Self {
        self.with(EntrySpec::stored(name, data))
    }

    #[must_use]
    pub fn deflated(self, name: &str, data: &[u8]) -> Self {
        self.with(EntrySpec::deflated(name, data))
    }

    /// Serialises the archive.
    #[must_use]
    pub fn build(&self) -> Vec<u8> {
        let mut body: Vec<u8> = Vec::new();
        // (lh_offset, payload_len, crc, payload) per entry.
        let mut placed: Vec<(u64, u64, u32)> = Vec::with_capacity(self.entries.len());

        for e in &self.entries {
            let payload = e.payload();
            let crc = e.cd_crc.unwrap_or_else(|| crc32(&e.data));
            let lh_offset = u64::try_from(body.len()).expect("offset");
            if !e.omit_local_header {
                let name = e.lh_name.clone().unwrap_or_else(|| e.name.clone());
                w32(&mut body, e.lh_sig.unwrap_or(LH_SIG));
                w16(&mut body, if e.zip64_record { 45 } else { 20 });
                w16(&mut body, e.flags);
                w16(&mut body, e.lh_method.unwrap_or(e.method));
                w16(&mut body, 0);
                w16(&mut body, 0);
                w32(&mut body, e.lh_crc.unwrap_or(crc));
                w32(
                    &mut body,
                    e.lh_comp
                        .unwrap_or_else(|| clamp32(u64::try_from(payload.len()).unwrap_or(0))),
                );
                w32(
                    &mut body,
                    e.lh_uncomp
                        .unwrap_or_else(|| clamp32(u64::try_from(e.data.len()).unwrap_or(0))),
                );
                w16(&mut body, u16::try_from(name.len()).expect("name len"));
                w16(&mut body, u16::try_from(e.extra.len()).expect("extra len"));
                body.extend_from_slice(&name);
                body.extend_from_slice(&e.extra);
                body.extend_from_slice(&payload);
                if e.append_data_descriptor {
                    w32(&mut body, DD_SIG);
                    w32(&mut body, crc);
                    w32(
                        &mut body,
                        clamp32(u64::try_from(payload.len()).unwrap_or(0)),
                    );
                    w32(&mut body, clamp32(u64::try_from(e.data.len()).unwrap_or(0)));
                }
            }
            placed.push((
                e.cd_lh_offset.unwrap_or(lh_offset),
                u64::try_from(payload.len()).unwrap_or(0),
                crc,
            ));
        }

        body.extend_from_slice(&self.pad_before_cd);

        let cd_offset = u64::try_from(body.len()).expect("cd offset");
        let mut cd: Vec<u8> = Vec::new();
        for (e, &(lh_offset, payload_len, crc)) in self.entries.iter().zip(placed.iter()) {
            let name = e.cd_name.clone().unwrap_or_else(|| e.name.clone());
            let uncomp = e
                .cd_uncomp
                .unwrap_or_else(|| u64::try_from(e.data.len()).unwrap_or(0));
            let comp = e.cd_comp.unwrap_or(payload_len);

            let mut extra: Vec<u8> = Vec::new();
            let (uncomp_32, comp_32, lh_32) = if e.zip64_record {
                let mut z: Vec<u8> = Vec::new();
                w64(&mut z, uncomp);
                w64(&mut z, comp);
                w64(&mut z, lh_offset);
                w16(&mut extra, 0x0001);
                w16(&mut extra, u16::try_from(z.len()).expect("z64 len"));
                extra.extend_from_slice(&z);
                (u32::MAX, u32::MAX, u32::MAX)
            } else {
                (clamp32(uncomp), clamp32(comp), clamp32(lh_offset))
            };

            if let Some(custom) = &e.cd_extra {
                extra = custom.clone();
            }

            w32(&mut cd, CD_SIG);
            // version made by: host 3 (Unix) when a mode is set, else 0 (FAT).
            w16(
                &mut cd,
                if e.unix_mode.is_some() {
                    0x031E
                } else {
                    0x001E
                },
            );
            w16(&mut cd, if e.zip64_record { 45 } else { 20 });
            w16(&mut cd, e.cd_flags.unwrap_or(e.flags));
            w16(&mut cd, e.cd_method.unwrap_or(e.method));
            w16(&mut cd, 0);
            w16(&mut cd, 0);
            w32(&mut cd, crc);
            w32(&mut cd, comp_32);
            w32(&mut cd, uncomp_32);
            w16(&mut cd, u16::try_from(name.len()).expect("name len"));
            w16(&mut cd, u16::try_from(extra.len()).expect("extra len"));
            w16(&mut cd, 0);
            w16(&mut cd, e.cd_disk_start.unwrap_or(0));
            w16(&mut cd, 0);
            w32(&mut cd, e.unix_mode.map_or(0, |m| m << 16));
            w32(&mut cd, lh_32);
            cd.extend_from_slice(&name);
            cd.extend_from_slice(&extra);
        }
        if self.truncate_cd_bytes > 0 {
            let keep = cd.len().saturating_sub(self.truncate_cd_bytes);
            cd.truncate(keep);
        }
        let cd_size = u64::try_from(cd.len()).expect("cd size");
        body.extend_from_slice(&cd);

        let entries_count = u64::try_from(self.entries.len()).expect("count");

        if self.zip64 {
            let rec_offset = u64::try_from(body.len()).expect("rec offset");
            w32(&mut body, EOCD64_SIG);
            w64(&mut body, 44);
            w16(&mut body, 45);
            w16(&mut body, 45);
            w32(&mut body, 0);
            w32(&mut body, 0);
            w64(&mut body, self.eocd64_entries.unwrap_or(entries_count));
            w64(&mut body, self.eocd64_entries.unwrap_or(entries_count));
            w64(&mut body, self.eocd64_cd_size.unwrap_or(cd_size));
            w64(&mut body, self.eocd64_cd_offset.unwrap_or(cd_offset));
            w32(&mut body, EOCD64_LOC_SIG);
            w32(&mut body, 0);
            w64(&mut body, self.eocd64_locator_offset.unwrap_or(rec_offset));
            w32(&mut body, self.eocd64_total_disks.unwrap_or(1));
        }

        if !self.omit_eocd {
            w32(&mut body, EOCD_SIG);
            w16(&mut body, self.disk_number);
            w16(&mut body, self.cd_disk);
            let count16 = self
                .eocd_entries
                .unwrap_or_else(|| u16::try_from(entries_count).unwrap_or(u16::MAX));
            w16(&mut body, count16);
            w16(&mut body, count16);
            w32(
                &mut body,
                self.eocd_cd_size.unwrap_or_else(|| {
                    if self.zip64 {
                        u32::MAX
                    } else {
                        clamp32(cd_size)
                    }
                }),
            );
            w32(
                &mut body,
                self.eocd_cd_offset.unwrap_or_else(|| {
                    if self.zip64 {
                        u32::MAX
                    } else {
                        clamp32(cd_offset)
                    }
                }),
            );
            let clen = self
                .comment_len_override
                .unwrap_or_else(|| u16::try_from(self.comment.len()).expect("comment len"));
            w16(&mut body, clen);
            body.extend_from_slice(&self.comment);
        }

        let mut out = self.prepend.clone();
        out.extend_from_slice(&body);
        out.extend_from_slice(&self.append);
        out
    }
}

/// A plausible Instagram-shaped archive: one JSON plus two images.
#[must_use]
pub fn instagram_like() -> ZipBuilder {
    ZipBuilder::new()
        .stored(
            "your_instagram_activity/media/posts_1.json",
            br#"{"media":[{"uri":"media/posts/a.jpg"}]}"#,
        )
        .stored("media/posts/a.jpg", b"\xFF\xD8\xFF\xE0 jpeg-a")
        .stored("media/posts/b.jpg", b"\xFF\xD8\xFF\xE0 jpeg-b")
}
