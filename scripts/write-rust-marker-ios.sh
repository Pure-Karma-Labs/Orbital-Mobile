#!/usr/bin/env bash
# Sole writer of the iOS Rust provenance marker (#813, PR #859 review).
#
#   bash scripts/write-rust-marker-ios.sh <debug|release>
#
# Writes packages/orbital-signal/rust-profile-ios.txt as:
#   line 1   the cargo profile the xcframework was compiled with
#   line 2+  the scripts/rust-input-digest.sh output
#
# Call this ONLY after a successful `ubrn build ios`: ubrn runs an unlocked
# `cargo metadata` first, which can rewrite Cargo.lock, so the digest has to be
# taken afterwards to describe what was actually compiled.
#
# Extracted because the writer previously existed in three hand-maintained
# copies — build:ios, build:ios:release and the test harness's fake-tree
# builder — none of them linted or scanned, and build-ios only runs on main, so
# a drift between them would not have shown up on a PR. All three now call this
# script, which means scripts/test-rust-profile-gate-ios.sh exercises the real
# writer on every PR.
#
# The npm scripts' pre-build `rm -f rust-profile-ios.txt` is deliberate and
# fail-closed: if ubrn dies part-way through rewriting the xcframework, a
# surviving old marker could validate a half-written artefact.
#
# Staged through a .tmp file and an atomic mv so a digest failure leaves NO
# marker at all, rather than a profile-only one: verify-rust-profile-ios.sh
# fails closed on both, but "no marker" is the honest state after a failed
# write. The .tmp is removed on any non-zero exit.
#
# Paths derive from this script's own location, so it works from the repo root,
# from packages/orbital-signal (via ../../scripts/...) and from the harness's
# mktemp tree. Bash 3.2 compatible.

set -euo pipefail

PROFILE="${1:-}"
case "${PROFILE}" in
  debug | release) ;;
  *)
    echo "usage: write-rust-marker-ios.sh <debug|release>" >&2
    exit 2
    ;;
esac

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MARKER="${REPO_ROOT}/packages/orbital-signal/rust-profile-ios.txt"
TMP="${MARKER}.tmp"
DIGEST_SCRIPT="${REPO_ROOT}/scripts/rust-input-digest.sh"

cleanup() { rm -f "${TMP}"; }
trap cleanup EXIT

rm -f "${TMP}"
{
  echo "${PROFILE}" &&
    bash "${DIGEST_SCRIPT}"
} > "${TMP}"
mv "${TMP}" "${MARKER}"
