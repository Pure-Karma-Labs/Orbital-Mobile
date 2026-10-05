#!/usr/bin/env bash
# Single owner of the iOS Rust freshness input list (#813).
#
# Emits one `<sha256>  <relpath>` line per input, LC_ALL=C sorted by path,
# with paths relative to the repo root. Two consumers:
#   1. packages/orbital-signal/package.json build:ios[:release] — appends this
#      output below the profile line in packages/orbital-signal/rust-profile-ios.txt
#      AFTER a successful ubrn build (ubrn runs an unlocked `cargo metadata`
#      first, which can rewrite Cargo.lock, so the digest must be taken after
#      the compile to describe what was actually built).
#   2. scripts/verify-rust-profile-ios.sh — recomputes and compares, on every
#      Xcode configuration.
#
# Inputs (mirrors android/check-rust-freshness.gradle, plus ubrn.config.yaml
# which is iOS-only because it selects the xcframework slices):
#   packages/orbital-signal/rust/orbital_signal/src/**/*.rs
#   packages/orbital-signal/rust/orbital_signal/Cargo.toml
#   packages/orbital-signal/rust/orbital_signal/Cargo.lock
#   rust-toolchain.toml
#   packages/orbital-signal/ubrn.config.yaml
#
# tests/ is deliberately excluded — it does not enter the compiled slices.
# Test-only churn must not invalidate a good xcframework (same as Android).
#
# Fails closed (non-zero + stderr message) on a missing/empty source tree, a
# missing fixed input, or a non-zero find/shasum/sort. Bash 3.2 compatible
# (/bin/bash on macOS): no associative arrays, no mapfile. Pipe-free: every
# status is checked explicitly rather than swallowed by a pipeline (#790).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

PKG_DIR="packages/orbital-signal"
CRATE_DIR="${PKG_DIR}/rust/orbital_signal"
SRC_DIR="${CRATE_DIR}/src"

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

FIXED_INPUTS="${CRATE_DIR}/Cargo.toml
${CRATE_DIR}/Cargo.lock
rust-toolchain.toml
${PKG_DIR}/ubrn.config.yaml"

ALL_PATHS="${RS_FILES}
${FIXED_INPUTS}"

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
