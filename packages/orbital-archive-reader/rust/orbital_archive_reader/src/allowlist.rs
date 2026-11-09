//! The allowlist: the only thing that decides what this crate will ever open.
//!
//! Matching is **case-sensitive** and runs on the post-strip path. A record
//! that does not match is parsed from the central directory only — its local
//! header and its data are never read (hostile-matrix group 8 asserts this with
//! a recording source).
//!
//! Deliberately NOT allowlisted, and pinned as forbidden by the security
//! invariant checker: messages, inbox, friends_and_followers, ads_information,
//! security_and_login_information, personal_information, stories, reels,
//! profile, other_content, album JSON, posts_on_other_pages..., tags, edits,
//! and every other root.

#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation,
    clippy::unwrap_used,
    clippy::expect_used
)]

use crate::types::EntryKind;

/// Roots that carry content we import.
pub const ALLOWED_ROOTS: [&str; 7] = [
    "your_facebook_activity",
    "your_activity_across_facebook",
    "your_instagram_activity",
    "posts",
    "media",
    "content",
    "photos_and_videos",
];

/// Roots we must never descend into. Listed here (not merely absent) so a
/// wrapper directory named after one of them can never be stripped away — see
/// `is_known_root_key` and F17.
pub const DENIED_ROOTS: [&str; 10] = [
    "messages",
    "inbox",
    "friends_and_followers",
    "ads_information",
    "security_and_login_information",
    "personal_information",
    "stories",
    "reels",
    "profile",
    "other_content",
];

/// F17: known root keys are the union of allowed and denied roots. A path whose
/// first segment is in this set is NEVER stripped.
#[must_use]
pub fn is_known_root_key(segment: &str) -> bool {
    ALLOWED_ROOTS.contains(&segment) || DENIED_ROOTS.contains(&segment)
}

/// True when the first segment of a *pre-strip* path is a denied root. The TS
/// service runs the same check as a tripwire; a hit means the allowlist and the
/// service disagree, which is a bug, not hostile input.
#[must_use]
pub fn starts_with_denied_root(path: &str) -> bool {
    let first = path.split('/').next().unwrap_or(path);
    DENIED_ROOTS.contains(&first)
}

/// Exact-match JSON paths (no `<N>` suffix).
const JSON_EXACT: [&str; 1] = ["your_instagram_activity/media/posts.json"];

/// JSON paths of the form `<prefix><N>.json`, `<N>` = 1-4 digits.
const JSON_NUMBERED_PREFIXES: [&str; 7] = [
    // Current Facebook layout. CONFIRMED against the local FB sample.
    "your_facebook_activity/posts/your_posts__check_ins__photos_and_videos_",
    // Older Facebook root name. Kept unverified: not present in the local
    // samples, documented in Meta's export changelog. Harmless if absent.
    "your_activity_across_facebook/posts/your_posts__check_ins__photos_and_videos_",
    // Legacy flat Facebook layout.
    "posts/your_posts_",
    // Current Instagram layout. CONFIRMED against the local IG sample
    // (posts_1.json).
    "your_instagram_activity/media/posts_",
    // Instagram "content" variant.
    "your_instagram_activity/content/posts_",
    "content/posts_",
    "media/posts_",
];

/// Media directory prefixes. Only image/video extensions below them are
/// listed. `media/` on its own is deliberately NOT a prefix: it would admit
/// `media/stories/`.
const MEDIA_PREFIXES: [&str; 5] = [
    // CONFIRMED against the local IG sample.
    "media/posts/",
    // CONFIRMED against the local FB sample.
    "your_facebook_activity/posts/media/",
    // Older Facebook root name; unverified, see above.
    "your_activity_across_facebook/posts/media/",
    "posts/media/",
    "photos_and_videos/",
];

const IMAGE_EXTS: [&str; 8] = ["jpg", "jpeg", "png", "webp", "heic", "heif", "avif", "gif"];
const VIDEO_EXTS: [&str; 6] = ["mp4", "mov", "m4v", "3gp", "webm", "mkv"];
/// Nested-archive extensions under a media prefix. These are reported as
/// `EntryNestedArchive` rather than silently ignored, so a bomb attempt is
/// visible in `rejectedCounts`.
const ARCHIVE_EXTS: [&str; 9] = ["zip", "7z", "rar", "gz", "tgz", "bz2", "xz", "zst", "tar"];

/// Lowercased extension (no dot) of the last segment, if any.
#[must_use]
pub fn extension_of(path: &str) -> Option<String> {
    let name = path.rsplit('/').next().unwrap_or(path);
    let (stem, ext) = name.rsplit_once('.')?;
    if stem.is_empty() || ext.is_empty() {
        return None;
    }
    Some(ext.to_ascii_lowercase())
}

/// Media kind by extension.
#[must_use]
pub fn media_kind_for_ext(ext: &str) -> Option<EntryKind> {
    if IMAGE_EXTS.contains(&ext) {
        Some(EntryKind::Image)
    } else if VIDEO_EXTS.contains(&ext) {
        Some(EntryKind::Video)
    } else {
        None
    }
}

#[must_use]
pub fn is_archive_ext(ext: &str) -> bool {
    ARCHIVE_EXTS.contains(&ext)
}

/// `true` when `rest` is 1-4 ASCII digits.
fn is_short_index(rest: &str) -> bool {
    let len = rest.len();
    (1..=4).contains(&len) && rest.bytes().all(|b| b.is_ascii_digit())
}

/// What the allowlist says about one post-strip path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Listed, with this kind.
    Listed(EntryKind),
    /// Under a media prefix but a nested archive by extension.
    NestedArchive,
    /// Not allowlisted: counted, never listed, never opened.
    NotAllowlisted,
}

/// The single decision point. `path` must already be hygiene-checked and
/// stripped, and must not be a directory entry.
#[must_use]
pub fn classify(path: &str) -> Verdict {
    // Defence in depth, ahead of every table below: a path whose first segment
    // is a denied root is never listed, whatever the rows say. Today no row can
    // match such a path, so this guard is inert — which is the point. It makes a
    // future row that happens to overlap a denied root (a new `media/` prefix, a
    // new root key) inert too, instead of silently opening private data. The
    // tables are edited far more often than this function.
    if starts_with_denied_root(path) {
        return Verdict::NotAllowlisted;
    }
    if JSON_EXACT.contains(&path) {
        return Verdict::Listed(EntryKind::Json);
    }
    for prefix in JSON_NUMBERED_PREFIXES {
        if let Some(rest) = path.strip_prefix(prefix) {
            if let Some(index) = rest.strip_suffix(".json")
                && is_short_index(index)
            {
                return Verdict::Listed(EntryKind::Json);
            }
            return Verdict::NotAllowlisted;
        }
    }
    for prefix in MEDIA_PREFIXES {
        if let Some(rest) = path.strip_prefix(prefix) {
            if rest.is_empty() {
                return Verdict::NotAllowlisted;
            }
            let Some(ext) = extension_of(rest) else {
                return Verdict::NotAllowlisted;
            };
            if is_archive_ext(&ext) {
                return Verdict::NestedArchive;
            }
            return match media_kind_for_ext(&ext) {
                Some(kind) => Verdict::Listed(kind),
                None => Verdict::NotAllowlisted,
            };
        }
    }
    Verdict::NotAllowlisted
}

/// Normalises a media URI from a Meta JSON file to an archive-relative path.
/// Returns `None` when the URI cannot be a path inside the archive.
#[must_use]
pub fn normalise_uri(uri: &str) -> Option<String> {
    let trimmed = uri.trim();
    if trimmed.is_empty() || trimmed.len() > crate::limits::MAX_PATH_BYTES {
        return None;
    }
    if trimmed.contains('\\') || trimmed.chars().any(char::is_control) || trimmed.contains("://") {
        return None;
    }
    let body = trimmed.strip_prefix("./").unwrap_or(trimmed);
    let body = body.strip_prefix('/').unwrap_or(body);
    if body.is_empty() {
        return None;
    }
    for seg in body.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." || seg.contains(':') {
            return None;
        }
    }
    Some(body.to_owned())
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
    fn confirmed_sample_rows_are_listed() {
        // Confirmed by name against the local FB sample.
        assert_eq!(
            classify(
                "your_facebook_activity/posts/your_posts__check_ins__photos_and_videos_1.json"
            ),
            Verdict::Listed(EntryKind::Json)
        );
        assert_eq!(
            classify("your_facebook_activity/posts/media/Album_123/4.jpg"),
            Verdict::Listed(EntryKind::Image)
        );
        assert_eq!(
            classify("your_facebook_activity/posts/media/videos/1.mp4"),
            Verdict::Listed(EntryKind::Video)
        );
        // Confirmed by name against the local IG sample.
        assert_eq!(
            classify("your_instagram_activity/media/posts_1.json"),
            Verdict::Listed(EntryKind::Json)
        );
        assert_eq!(
            classify("your_instagram_activity/media/posts.json"),
            Verdict::Listed(EntryKind::Json)
        );
        assert_eq!(
            classify("media/posts/17842302658737590.jpg"),
            Verdict::Listed(EntryKind::Image)
        );
        assert_eq!(
            classify("media/posts/178.webp"),
            Verdict::Listed(EntryKind::Image)
        );
    }

    #[test]
    fn near_misses_are_not_allowlisted() {
        for p in [
            "media/stories/1.jpg",
            "media/reels/1.jpg",
            "your_instagram_activity/media/reels.json",
            "your_instagram_activity/media/stories.json",
            "your_instagram_activity/media/other_content.json",
            "your_instagram_activity/media/profile_photos.json",
            "your_facebook_activity/posts/album/0.json",
            "your_facebook_activity/posts/posts_on_other_pages_and_profiles.json",
            "your_facebook_activity/posts/places_you_have_been_tagged_in.json",
            "your_facebook_activity/posts/edits_you_made_to_posts.json",
            "your_facebook_activity/posts/your_videos.json",
            "your_facebook_activity/posts/your_uncategorized_photos.json",
            "messages/inbox/someone/photos/1.jpg",
            "personal_information/profile.json",
            "media/posts/notes.txt",
            "media/posts/clip.srt",
            "media/posts/",
            "Media/Posts/1.jpg",
            "your_instagram_activity/media/posts_12345.json",
            "your_instagram_activity/media/posts_.json",
            "your_instagram_activity/media/posts_1.JSON",
            "your_instagram_activity/media/posts_1x.json",
        ] {
            assert_eq!(classify(p), Verdict::NotAllowlisted, "{p}");
        }
    }

    #[test]
    fn nested_archive_by_extension_under_a_media_prefix() {
        assert_eq!(classify("media/posts/payload.zip"), Verdict::NestedArchive);
        assert_eq!(classify("media/posts/payload.TGZ"), Verdict::NestedArchive);
    }

    #[test]
    fn classify_refuses_denied_roots_ahead_of_every_table() {
        for root in DENIED_ROOTS {
            for p in [
                format!("{root}/a.jpg"),
                format!("{root}/posts/a.jpg"),
                format!("{root}/media/posts/a.jpg"),
                format!("{root}/your_instagram_activity/media/posts_1.json"),
            ] {
                assert_eq!(classify(&p), Verdict::NotAllowlisted, "{p}");
            }
        }
        // The guard is first: a path that is BOTH under a denied root and under
        // an allowlisted media prefix is still refused.
        assert_eq!(classify("inbox/media/posts/a.jpg"), Verdict::NotAllowlisted);
    }

    #[test]
    fn known_root_keys_cover_both_sides() {
        assert!(is_known_root_key("messages"));
        assert!(is_known_root_key("your_instagram_activity"));
        assert!(!is_known_root_key("some_wrapper_dir"));
        for r in DENIED_ROOTS {
            assert!(is_known_root_key(r), "{r}");
            assert!(starts_with_denied_root(&format!("{r}/x.jpg")), "{r}");
        }
        for r in ALLOWED_ROOTS {
            assert!(is_known_root_key(r), "{r}");
        }
    }

    #[test]
    fn uri_normalisation_rejects_what_cannot_be_an_entry() {
        assert_eq!(
            normalise_uri("media/posts/1.jpg").as_deref(),
            Some("media/posts/1.jpg")
        );
        assert_eq!(
            normalise_uri("./media/posts/1.jpg").as_deref(),
            Some("media/posts/1.jpg")
        );
        for bad in [
            "",
            "   ",
            "https://example.com/1.jpg",
            "../1.jpg",
            "a//b.jpg",
            "a\\b.jpg",
            "C:/x.jpg",
        ] {
            assert_eq!(normalise_uri(bad), None, "{bad}");
        }
    }

    #[test]
    fn extensions_are_case_insensitive_but_paths_are_not() {
        assert_eq!(extension_of("a/b.JPG").as_deref(), Some("jpg"));
        assert_eq!(extension_of("a/b").as_deref(), None);
        assert_eq!(extension_of("a/.hidden").as_deref(), None);
        assert_eq!(media_kind_for_ext("heif"), Some(EntryKind::Image));
        assert_eq!(media_kind_for_ext("mkv"), Some(EntryKind::Video));
        assert_eq!(media_kind_for_ext("svg"), None);
    }
}
