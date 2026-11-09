#!/usr/bin/env bash
# Single owner of the iOS Rust freshness input list for the SECOND crate,
# orbital_archive_reader (#920). Sibling of scripts/rust-input-digest.sh.
#
# WHY A SIBLING AND NOT A PARAMETER: rust-input-digest.sh spells every input
# out as a literal relpath so that security invariant 18 can read the list out
# of the EXECUTABLE code after stripping comments, and assert input parity with
# android/check-rust-freshness.gradle. A `$1`-parameterised digest would turn
# those literals into interpolations and the invariant's parity clause would
# read as drift — i.e. the duplication is load-bearing. A THIRD crate changes
# that trade-off: at three copies, parameterise digest + marker writer +
# verifier + gradle task + harness together, and teach invariant 18 to read a
# per-crate table instead of literals.
#
# Emits one `<sha256>  <relpath>` line per input, LC_ALL=C sorted by path,
# with paths relative to the repo root. Two consumers:
#   1. scripts/write-rust-marker-ios.sh archive — the sole marker writer,
#      invoked by packages/orbital-archive-reader/package.json
#      build:ios[:release] AFTER a successful ubrn build (ubrn runs an unlocked
#      `cargo metadata` first, which can rewrite Cargo.lock, so the digest must
#      be taken after the compile to describe what was actually built).
#   2. scripts/verify-rust-profile-ios.sh archive — recomputes and compares, on
#      every Xcode configuration, from the Podfile's
#      '[Orbital] Verify Rust release profile (archive)' phase.
#
# REQUIRED inputs (a missing one is a hard failure):
#   packages/orbital-archive-reader/rust/orbital_archive_reader/src/**/*.rs
#   packages/orbital-archive-reader/rust/orbital_archive_reader/Cargo.toml
#   packages/orbital-archive-reader/rust/orbital_archive_reader/Cargo.lock
#   rust-toolchain.toml
#   packages/orbital-archive-reader/ubrn.config.yaml   (selects the slices)
#   packages/orbital-archive-reader/package.json       (see below)
#
# OPTIONAL inputs (hashed when present; absence is NOT an error, but adding or
# removing one changes the file set and so correctly invalidates the marker):
#   packages/orbital-archive-reader/rust/orbital_archive_reader/build.rs
#   packages/orbital-archive-reader/rust/orbital_archive_reader/.cargo/config.toml
#
# ONE repo-root toolchain pin covers both crates: security invariant 18 forbids
# any `rust-toolchain*` file under packages/**, because two pins would split
# the Android toolchain across the 1,805 shared exported symbols.
#
# Why packages/orbital-archive-reader/package.json and not the root lockfile:
# identical reasoning to the signal digest — it is the only place the ubrn
# toolchain version is pinned (`"uniffi-bindgen-react-native": "0.31.0-2"`, an
# EXACT spec) and it carries the build:ios[:release] command lines, including
# any cargo `--features` flag. A ubrn bump regenerates the C++/TS glue and its
# uniffi checksums without touching a single .rs file. Hashing the root
# package-lock.json instead would drag ~1 MB of unrelated JS dependency churn
# into the digest and condemn a good xcframework on every Dependabot bump.
#
# The crate's tests/ dir (which holds the hostile matrix and its fixtures) and
# .cargo/audit.toml are deliberately excluded: neither enters the compiled
# slices (audit.toml configures `cargo audit`). Test-only churn must not
# invalidate a good xcframework (same as Android, same as signal).
#
# NOTE on path dependencies: a `path = "…"` dep's sources are in none of the
# sets above, and Cargo.lock records a path crate with no source/checksum, so
# editing one would leave a stale xcframework looking fresh. Security
# invariant 18 forbids `path =`, `git =` and `[patch` in this crate's
# Cargo.toml for exactly that reason; do not relax it without teaching this
# script to walk `cargo metadata`.
#
# Fails closed (non-zero + stderr message) on a missing/empty source tree, a
# missing REQUIRED input, or a non-zero find/shasum/sort. Bash 3.2 compatible
# (/bin/bash on macOS): no associative arrays, no mapfile. Pipe-free: every
# status is checked explicitly rather than swallowed by a pipeline (#790).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Every path below is spelled out rather than interpolated, so the executable
# code — not just the header comment — names every input. Security invariant
# 18 strips comments before asserting input parity with
# android/check-rust-freshness.gradle's checkArchiveRustBinaries task, so an
# interpolated path would read as a drift.
SRC_DIR="packages/orbital-archive-reader/rust/orbital_archive_reader/src"

fail() {
  echo "error: rust-input-digest-archive: $*" >&2
  exit 1
}

cd "${REPO_ROOT}" || fail "cannot cd to repo root ${REPO_ROOT}"

# --- Non-vacuity: the source tree must exist and hold at least one .rs file.
# Without this, an empty or relocated src dir would yield a stable digest that
# describes nothing, and the gate would pass forever.
[ -d "${SRC_DIR}" ] || fail "crate source dir not found: ${SRC_DIR}"

RS_FILES=""
if ! RS_FILES="$(find "${SRC_DIR}" -type f -name '*.rs')"; then
  fail "find failed over ${SRC_DIR}"
fi
[ -n "${RS_FILES}" ] || fail "no *.rs files under ${SRC_DIR} — the digest would be vacuous"

# Literal relpaths, not "${CRATE_DIR}/..." interpolations, so that security
# invariant 18's parity clause can read this list after stripping comments.
FIXED_INPUTS="packages/orbital-archive-reader/rust/orbital_archive_reader/Cargo.toml
packages/orbital-archive-reader/rust/orbital_archive_reader/Cargo.lock
rust-toolchain.toml
packages/orbital-archive-reader/ubrn.config.yaml
packages/orbital-archive-reader/package.json"

# Hashed only when present. Neither exists today; both would silently change
# how the crate compiles if they appeared.
OPTIONAL_INPUTS="packages/orbital-archive-reader/rust/orbital_archive_reader/build.rs
packages/orbital-archive-reader/rust/orbital_archive_reader/.cargo/config.toml"

PRESENT_OPTIONAL=""
while IFS= read -r opt; do
  [ -n "${opt}" ] || continue
  if [ -f "${opt}" ]; then
    PRESENT_OPTIONAL="${PRESENT_OPTIONAL}${opt}
"
  fi
done <<<"${OPTIONAL_INPUTS}"

ALL_PATHS="${RS_FILES}
${FIXED_INPUTS}
${PRESENT_OPTIONAL}"

# --- Sort paths (not hashes) so the emitted order is stable and diffable.
SORTED_PATHS=""
if ! SORTED_PATHS="$(LC_ALL=C sort <<<"${ALL_PATHS}")"; then
  fail "sort failed over the input path list"
fi

INPUTS=()
while IFS= read -r p; do
  [ -n "${p}" ] || continue
  [ -f "${p}" ] || fail "required digest input missing: ${p}"
  INPUTS+=("${p}")
done <<<"${SORTED_PATHS}"

[ "${#INPUTS[@]}" -gt 0 ] || fail "input list resolved empty"

DIGEST=""
if ! DIGEST="$(shasum -a 256 "${INPUTS[@]}")"; then
  fail "shasum failed over ${#INPUTS[@]} input(s)"
fi
[ -n "${DIGEST}" ] || fail "shasum produced no output"

printf '%s\n' "${DIGEST}"
