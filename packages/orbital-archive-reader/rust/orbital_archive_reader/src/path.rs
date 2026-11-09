//! Entry-path hygiene and the per-part wrapper strip.
//!
//! No path from an archive ever reaches the filesystem: staging paths are
//! created by the native glue and named by a UUID. These checks therefore exist
//! to keep hostile names out of the *listing* and out of URI resolution, and to
//! make traversal structurally unrepresentable rather than merely unused.

#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation,
    clippy::unwrap_used,
    clippy::expect_used
)]

use crate::limits::{MAX_PATH_BYTES, MAX_PATH_SEGMENTS};
use crate::types::EntrySkipCode;

/// A central-directory name that passed hygiene checks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidPath {
    /// Archive-relative, slash-separated, no leading slash, no empty segment.
    pub path: String,
    /// Directory entries are ignored by the listing.
    pub is_dir: bool,
}

/// Validates one central-directory name.
///
/// `utf8_flag` is general-purpose bit 11. We require valid UTF-8 either way —
/// Meta exports are always UTF-8, and a name we cannot decode is a name we
/// cannot match against the allowlist, so listing it would be unsafe.
pub fn validate(name: &[u8], utf8_flag: bool) -> Result<ValidPath, EntrySkipCode> {
    let _ = utf8_flag;

    if name.is_empty() || name.len() > MAX_PATH_BYTES {
        return Err(EntrySkipCode::EntryPathInvalid);
    }

    let text = core::str::from_utf8(name).map_err(|_| EntrySkipCode::EntryPathInvalid)?;

    // NUL, C0 controls and DEL. Also rejects embedded newlines, which would
    // otherwise let a name forge a log line.
    if text.chars().any(|c| c.is_control()) {
        return Err(EntrySkipCode::EntryPathInvalid);
    }
    // Backslash: a Windows separator that would make segment analysis lie.
    if text.contains('\\') {
        return Err(EntrySkipCode::EntryPathInvalid);
    }
    // Absolute POSIX path.
    if text.starts_with('/') {
        return Err(EntrySkipCode::EntryPathInvalid);
    }
    // Drive letter or any colon in the first segment (also covers "C:" and
    // alternate data streams).
    let first = text.split('/').next().unwrap_or(text);
    if first.contains(':') {
        return Err(EntrySkipCode::EntryPathInvalid);
    }

    let is_dir = text.ends_with('/');
    let body = if is_dir {
        text.strip_suffix('/').unwrap_or(text)
    } else {
        text
    };
    if body.is_empty() {
        return Err(EntrySkipCode::EntryPathInvalid);
    }

    let mut segments = 0usize;
    for seg in body.split('/') {
        if seg.is_empty() {
            // "a//b" and a trailing "a//" are malformed, not merely odd.
            return Err(EntrySkipCode::EntryPathInvalid);
        }
        if seg == "." || seg == ".." {
            return Err(EntrySkipCode::EntryPathTraversal);
        }
        segments = segments.saturating_add(1);
        if segments > MAX_PATH_SEGMENTS {
            return Err(EntrySkipCode::EntryPathInvalid);
        }
    }

    Ok(ValidPath {
        path: body.to_owned(),
        is_dir,
    })
}

/// Tracks whether every file entry in a part shares one first segment.
///
/// A single root-level file (no `/`) permanently disqualifies the part from
/// stripping: that file would lose its identity.
#[derive(Debug, Default)]
pub struct FirstSegmentTracker {
    candidate: Option<String>,
    disqualified: bool,
}

impl FirstSegmentTracker {
    pub fn observe(&mut self, path: &str) {
        if self.disqualified {
            return;
        }
        let Some((head, rest)) = path.split_once('/') else {
            self.disqualified = true;
            return;
        };
        if rest.is_empty() {
            self.disqualified = true;
            return;
        }
        match &self.candidate {
            None => self.candidate = Some(head.to_owned()),
            Some(existing) if existing == head => {}
            Some(_) => self.disqualified = true,
        }
    }

    /// The segment to strip, or `None`.
    ///
    /// `is_known_root_key` is the F17 union of allowlist roots and denied
    /// roots: a key in that set is NEVER stripped, so a wrapper directory
    /// literally named `messages` cannot promote `messages/...` content into
    /// an allowlisted position.
    pub fn strip_segment(&self, is_known_root_key: impl Fn(&str) -> bool) -> Option<&str> {
        if self.disqualified {
            return None;
        }
        let head = self.candidate.as_deref()?;
        if is_known_root_key(head) {
            return None;
        }
        Some(head)
    }
}

/// Applies at most one level of strip. Returns `None` if the path does not sit
/// under `segment` (which cannot happen for a non-disqualified tracker, but the
/// caller must not assume it).
#[must_use]
pub fn apply_strip<'a>(path: &'a str, segment: Option<&str>) -> &'a str {
    match segment {
        None => path,
        Some(seg) => match path.split_once('/') {
            Some((head, rest)) if head == seg && !rest.is_empty() => rest,
            _ => path,
        },
    }
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

    fn err(name: &str) -> EntrySkipCode {
        match validate(name.as_bytes(), true) {
            Ok(v) => panic!("expected rejection, got {v:?}"),
            Err(e) => e,
        }
    }

    #[test]
    fn traversal_segments_are_traversal() {
        assert_eq!(err("../x.jpg"), EntrySkipCode::EntryPathTraversal);
        assert_eq!(err("a/../../x.jpg"), EntrySkipCode::EntryPathTraversal);
        assert_eq!(err("./x.jpg"), EntrySkipCode::EntryPathTraversal);
        assert_eq!(err("a/./b"), EntrySkipCode::EntryPathTraversal);
    }

    #[test]
    fn structural_attacks_are_invalid() {
        assert_eq!(err("/etc/passwd"), EntrySkipCode::EntryPathInvalid);
        assert_eq!(err("a\\b.jpg"), EntrySkipCode::EntryPathInvalid);
        assert_eq!(err("C:/x.jpg"), EntrySkipCode::EntryPathInvalid);
        assert_eq!(err("a//b.jpg"), EntrySkipCode::EntryPathInvalid);
        assert_eq!(err(""), EntrySkipCode::EntryPathInvalid);
        assert_eq!(
            validate(b"a\x00b", true),
            Err(EntrySkipCode::EntryPathInvalid)
        );
        assert_eq!(
            validate(b"a\nb", true),
            Err(EntrySkipCode::EntryPathInvalid)
        );
        assert_eq!(
            validate(&[0x80, 0x81], true),
            Err(EntrySkipCode::EntryPathInvalid)
        );
        let deep = "a/".repeat(17);
        assert_eq!(
            err(&format!("{deep}x.jpg")),
            EntrySkipCode::EntryPathInvalid
        );
        let long = format!("{}.jpg", "a".repeat(MAX_PATH_BYTES));
        assert_eq!(err(&long), EntrySkipCode::EntryPathInvalid);
    }

    #[test]
    fn directory_entries_are_flagged() {
        let v = validate(b"media/posts/", true).expect("dir");
        assert!(v.is_dir);
        assert_eq!(v.path, "media/posts");
    }

    #[test]
    fn strip_requires_a_unanimous_non_root_segment() {
        let mut t = FirstSegmentTracker::default();
        t.observe("wrapper/media/posts/a.jpg");
        t.observe("wrapper/media/posts_1.json");
        assert_eq!(t.strip_segment(|_| false), Some("wrapper"));
        assert_eq!(t.strip_segment(|s| s == "wrapper"), None);

        let mut t2 = FirstSegmentTracker::default();
        t2.observe("wrapper/a.jpg");
        t2.observe("other/a.jpg");
        assert_eq!(t2.strip_segment(|_| false), None);

        let mut t3 = FirstSegmentTracker::default();
        t3.observe("wrapper/a.jpg");
        t3.observe("rootfile.json");
        assert_eq!(t3.strip_segment(|_| false), None);
    }

    #[test]
    fn strip_is_one_level_only() {
        assert_eq!(apply_strip("w/media/a.jpg", Some("w")), "media/a.jpg");
        assert_eq!(apply_strip("x/media/a.jpg", Some("w")), "x/media/a.jpg");
        assert_eq!(apply_strip("media/a.jpg", None), "media/a.jpg");
    }
}
