#!/usr/bin/env bash
# Single owner of the iOS Rust freshness input list (#813).
#
# Emits one `<sha256>  <relpath>` line per input, LC_ALL=C sorted by path,
# with paths relative to the repo root. Two consumers:
#   1. scripts/write-rust-marker-ios.sh — the sole marker writer, invoked by
#      packages/orbital-signal/package.json build:ios[:release] AFTER a
#      successful ubrn build (ubrn runs an unlocked `cargo metadata` first,
#      which can rewrite Cargo.lock, so the digest must be taken after the
#      compile to describe what was actually built).
#   2. scripts/verify-rust-profile-ios.sh — recomputes and compares, on every
#      Xcode configuration.
#
# REQUIRED inputs (a missing one is a hard failure):
#   packages/orbital-signal/rust/orbital_signal/src/**/*.rs
#   packages/orbital-signal/rust/orbital_signal/Cargo.toml
#   packages/orbital-signal/rust/orbital_signal/Cargo.lock
#   rust-toolchain.toml
#   packages/orbital-signal/ubrn.config.yaml   (iOS-only: it selects the slices)
#   packages/orbital-signal/package.json       (see below)
#
# OPTIONAL inputs (hashed when present; absence is NOT an error, but adding or
# removing one changes the file set and so correctly invalidates the marker):
#   packages/orbital-signal/rust/orbital_signal/build.rs
#   packages/orbital-signal/rust/orbital_signal/.cargo/config.toml
#
# Why packages/orbital-signal/package.json and not the root lockfile: that file
# is simultaneously (a) the only place the ubrn toolchain version is pinned —
# `"uniffi-bindgen-react-native": "0.31.0-2"`, an EXACT spec, so the root
# package-lock.json merely echoes it and adds no pin of its own — and (b) where
# the build:ios[:release] command lines live, including any cargo `--features`
# flag. A ubrn bump regenerates the C++/TS glue and its uniffi checksums
# without touching a single .rs file, and a feature flag changes the compiled
# FFI surface; both must invalidate the xcframework. Hashing the root
# package-lock.json instead would drag ~1 MB of unrelated JS dependency churn
# into the digest, so every Dependabot bump would condemn a perfectly good
# xcframework — a false-positive rate that trains developers to distrust the
# gate. If ubrn is ever pinned with a RANGE, this file stops being sufficient
# and the resolved version must come from the lockfile.
#
# The crate's tests/ dir and .cargo/audit.toml are deliberately excluded:
# neither enters the compiled slices (audit.toml configures `cargo audit`).
# Test-only churn must not invalidate a good xcframework (same as Android).
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
# android/check-rust-freshness.gradle, so an interpolated path would read as a
# drift.
SRC_DIR="packages/orbital-signal/rust/orbital_signal/src"

fail() {
  echo "error: rust-input-digest: $*" >&2
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
FIXED_INPUTS="packages/orbital-signal/rust/orbital_signal/Cargo.toml
packages/orbital-signal/rust/orbital_signal/Cargo.lock
rust-toolchain.toml
packages/orbital-signal/ubrn.config.yaml
packages/orbital-signal/package.json"

# Hashed only when present. Neither exists today; both would silently change
# how the crate compiles if they appeared.
OPTIONAL_INPUTS="packages/orbital-signal/rust/orbital_signal/build.rs
packages/orbital-signal/rust/orbital_signal/.cargo/config.toml"

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
