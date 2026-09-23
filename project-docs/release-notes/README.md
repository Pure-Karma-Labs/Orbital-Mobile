# Release notes — conventions

Per-version "What's New" drafts live here as `<version>.md` (e.g. `1.7.6.md`).
Items are appended to a version's draft as they land, so the copy pasted into
App Store Connect / Play Console at submission time is written once and reviewed
once. `project-docs/store-listing.md` holds the evergreen listing metadata; this
directory holds only the per-release copy.

Only `*.md` here is tracked — everything else under `project-docs/` stays under
the never-commit rule, screenshots and exports included.

## Rules for every version file

- Entries describe **shipped, user-visible behaviour only**, and only behaviour
  verified on the platform the entry is written for. If a change is not in the
  build being submitted, or was only ever observed on the other platform, it
  does not go in the copy.
- Never name a security issue, describe its mechanism, or announce a fix that
  has not been deployed and released. Release notes are public the moment they
  are uploaded.
- Never word an entry so that it implies earlier builds were unsafe or leaked
  anything. "Now does X" reads as "used to fail to do X".
- Write in plain language, the way the person holding the phone would describe
  it — no marker names, no file formats, no internal terminology.
- App Store copy must never mention Android or cross-platform availability
  (same rule as the listing metadata).
- A version with nothing user-visible to say ships no entry. Silence is a valid
  release note.

## Internal notes sections

Every version file ends with an **Internal notes** section. It records why the
copy says what it says — including why a change was deliberately *not*
announced — and is limited to public issue numbers.

**Nothing in an Internal notes section is ever uploaded to either store.** It is
working context for whoever writes the next submission, not draft copy.
