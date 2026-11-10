#!/usr/bin/env bash
# Integration harness for the Android Rust release-profile gate (#550, #920).
# Run from repo root: bash scripts/test-rust-profile-gate-android.sh
#   or via: npm run test:rust-gate:android
#
# Precondition (A0): debug-profile Rust binaries + markers must exist for BOTH
# crates before running this harness. Produce them with:
#   npm run build:rust:android          (orbital_signal)
#   npm run build:rust:archive:android  (orbital_archive_reader)
#
# TWO TASKS, ONE PER CRATE (#920): android/check-rust-freshness.gradle registers
# checkRustBinaries (orbital_signal) and checkArchiveRustBinaries
# (orbital_archive_reader), and android/app/build.gradle hangs BOTH off preBuild.
# Gradle does not specify an execution order between two independent preBuild
# dependencies, so a case that pins only one marker is ambiguous: whichever task
# ran first could be the one that threw. EVERY case below therefore sets BOTH
# markers explicitly, and the case's needle names the crate it is about.
#
# Tests (Gradle daemon shared across A1-A9 for speed):
#   A0  Precondition: both .a pairs exist AND both markers == 'debug'
#   A1  Dry-run wiring: assembleRelease --dry-run lists checkRustBinaries AND
#       checkArchiveRustBinaries
#   A2  signal marker=debug  (archive release) + assembleRelease → FAIL signal
#       profile 'debug' error
#   A3  signal marker absent (archive release) + assembleRelease → FAIL signal
#       profile 'missing' error
#   A4  both markers=release + no-op probe task → PASS, signal gate non-vacuous
#   A5  archive marker=debug  (signal release) + assembleRelease → FAIL archive
#       profile 'debug' error
#   A6  archive marker absent (signal release) + assembleRelease → FAIL archive
#       profile 'missing' error
#   A7  both markers=release + no-op probe task → PASS, archive gate non-vacuous
#   A8  STALENESS: archive ubrn.config.yaml newer than the archive .a, non-release
#       invocation → FAIL naming ubrn.config.yaml
#   A9  STALENESS: archive package.json newer than the archive .a, non-release
#       invocation → FAIL naming package.json
#
# A8/A9 are the first tests of the Android mtime arithmetic anywhere (the iOS
# harness covers content digests, not timestamps), and they cover the two inputs
# that make checkArchiveRustBinaries deliberately STRONGER than
# checkRustBinaries. They stamp mtimes only — the two files' CONTENTS are never
# written, so `git status` stays clean. Both use a non-release invocation so the
# profile gate is inert and the staleness branch is what fails.
#
# MTIME DISCIPLINE: a staleness case touches the archive .a pair to NOW, then
# stamps exactly ONE input to now+1min (`touch -t`), so the gate's changed-file
# list is exactly that file whatever the checkout's real timestamps are. The
# EXIT trap undoes it: it plain-touches both stamped inputs, then all four .a,
# then both markers — the binaries end up at least as new as every input, so the
# tree is left fresh for the next real build.
#
# IMPORTANT: the gate fast-fails on A2/A3/A5/A6 because android/app/build.gradle's
# preBuild depends on both check tasks — the dependency graph is the
# mechanism. assembleRelease is on the CLI only to populate
# taskGraph.allTasks for the release-detection regex inside the tasks.

set -euo pipefail

# Pipe-free substring test (#790): `printf | grep -q` under pipefail SIGPIPEs on large output.
contains() { [ -n "$2" ] && [[ "$1" == *"$2"* ]]; }  # empty needle never matches

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

SIGNAL_JNI="${REPO_ROOT}/packages/orbital-signal/android/src/main/jniLibs"
MARKER="${SIGNAL_JNI}/rust-profile.txt"
ARM64_LIB="${SIGNAL_JNI}/arm64-v8a/liborbital_signal.a"
X86_64_LIB="${SIGNAL_JNI}/x86_64/liborbital_signal.a"

ARCHIVE_PKG="${REPO_ROOT}/packages/orbital-archive-reader"
ARCHIVE_JNI="${ARCHIVE_PKG}/android/src/main/jniLibs"
ARCHIVE_MARKER="${ARCHIVE_JNI}/rust-profile.txt"
ARCHIVE_ARM64_LIB="${ARCHIVE_JNI}/arm64-v8a/liborbital_archive_reader.a"
ARCHIVE_X86_64_LIB="${ARCHIVE_JNI}/x86_64/liborbital_archive_reader.a"
# The two inputs checkArchiveRustBinaries watches and checkRustBinaries does not.
ARCHIVE_UBRN_CONFIG="${ARCHIVE_PKG}/ubrn.config.yaml"
ARCHIVE_PKG_JSON="${ARCHIVE_PKG}/package.json"

PASS=0
FAIL=0

# --- A0: Precondition (both crates) ---
if [ ! -f "${ARM64_LIB}" ] || [ ! -f "${X86_64_LIB}" ]; then
  echo "ERROR A0: orbital_signal .a binaries not found — run: npm run build:rust:android"
  exit 1
fi

if [ ! -f "${ARCHIVE_ARM64_LIB}" ] || [ ! -f "${ARCHIVE_X86_64_LIB}" ]; then
  echo "ERROR A0: orbital_archive_reader .a binaries not found — run: npm run build:rust:archive:android"
  exit 1
fi

if [ ! -f "${MARKER}" ]; then
  echo "ERROR A0: orbital-signal jniLibs/rust-profile.txt marker absent — run: npm run build:rust:android"
  exit 1
fi

if [ ! -f "${ARCHIVE_MARKER}" ]; then
  echo "ERROR A0: orbital-archive-reader jniLibs/rust-profile.txt marker absent — run: npm run build:rust:archive:android"
  exit 1
fi

MARKER_CONTENT=$(cat "${MARKER}")
if [ "${MARKER_CONTENT}" != "debug" ]; then
  echo "ERROR A0: orbital-signal marker content is '${MARKER_CONTENT}', expected 'debug' — run: npm run build:rust:android"
  exit 1
fi

ARCHIVE_MARKER_CONTENT=$(cat "${ARCHIVE_MARKER}")
if [ "${ARCHIVE_MARKER_CONTENT}" != "debug" ]; then
  echo "ERROR A0: orbital-archive-reader marker content is '${ARCHIVE_MARKER_CONTENT}', expected 'debug' — run: npm run build:rust:archive:android"
  exit 1
fi

echo "PASS A0 (precondition: debug binaries + markers present for both crates)"
PASS=$((PASS + 1))

# --- Snapshot both markers for trap restoration ---
MARKER_ORIGINAL="${MARKER_CONTENT}"
ARCHIVE_MARKER_ORIGINAL="${ARCHIVE_MARKER_CONTENT}"

# --- Marker + mtime helpers -------------------------------------------------
# set_marker <path> <debug|release|absent>
set_marker() {
  if [ "$2" = "absent" ]; then
    rm -f "$1"
  else
    printf '%s' "$2" > "$1"
  fi
}

# set_markers <signal state> <archive state> — every case calls this, see the
# header's note on unspecified task order.
set_markers() {
  set_marker "${MARKER}" "$1"
  set_marker "${ARCHIVE_MARKER}" "$2"
}

# A timestamp one minute in the future, for `touch -t` (BSD first, GNU fallback).
future_stamp() {
  date -v+1M +%Y%m%d%H%M 2>/dev/null || date -d '+1 minute' +%Y%m%d%H%M
}

# Make every binary at least as new as every input again. Inputs FIRST, then the
# .a files: Gradle's check is `input > oldestBinary`, so a same-second touch of
# the binaries after the inputs still reads as fresh.
restore_freshness() {
  touch "${ARCHIVE_UBRN_CONFIG}" "${ARCHIVE_PKG_JSON}" 2>/dev/null || true
  touch "${ARM64_LIB}" "${X86_64_LIB}" "${ARCHIVE_ARM64_LIB}" "${ARCHIVE_X86_64_LIB}" 2>/dev/null || true
}

cd "${REPO_ROOT}/android"

# Restore markers, undo any mtime tampering, and stop the Gradle daemon on exit
cleanup() {
  printf '%s' "${MARKER_ORIGINAL}" > "${MARKER}"
  printf '%s' "${ARCHIVE_MARKER_ORIGINAL}" > "${ARCHIVE_MARKER}"
  restore_freshness
  touch "${MARKER}" "${ARCHIVE_MARKER}" 2>/dev/null || true
  ./gradlew --stop 2>/dev/null || true
}
trap cleanup EXIT

# Start from a provably fresh tree: A1-A7 are about the PROFILE gate, and a
# checkout whose sources happen to be newer than its .a files would make the
# staleness branch fire first and hide the profile error these cases assert.
restore_freshness

# Export env so all gradle invocations skip Sentry upload
export SENTRY_DISABLE_AUTO_UPLOAD=true

# Helper: assert command exits non-zero AND output contains substring
expect_fail_with() {
  local label="$1"
  local req_substring="$2"
  shift 2
  local output exit_code
  set +e
  output=$("$@" 2>&1)
  exit_code=$?
  set -e
  local ok=1
  [ "${exit_code}" -eq 0 ] && ok=0
  if ! contains "${output}" "${req_substring}"; then
    ok=0
  fi
  if [ "${ok}" -eq 1 ]; then
    echo "PASS ${label}"
    PASS=$((PASS + 1))
  else
    echo "FAIL ${label}: exit=${exit_code} (expected non-zero), missing substring: '${req_substring}'"
    echo "  output (last 20 lines):"
    printf '%s\n' "${output}" | tail -20
    FAIL=$((FAIL + 1))
  fi
}

# Multi-needle helper: set REQ=(...) (all must appear) and NEG=(...) (none may
# appear) before calling. Bracketed with set +e like expect_fail_with, so an
# unexpected Gradle failure lands in the FAIL branch with diagnostics instead of
# aborting the script at the assignment.
#   gradle_case <label> <pass|fail> <cmd...>
REQ=()
NEG=()
gradle_case() {
  local label="$1" expectation="$2"
  shift 2
  local output exit_code ok=1 n
  set +e
  output=$("$@" 2>&1)
  exit_code=$?
  set -e
  if [ "${expectation}" = "pass" ]; then
    [ "${exit_code}" -ne 0 ] && ok=0
  else
    [ "${exit_code}" -eq 0 ] && ok=0
  fi
  for n in ${REQ[@]+"${REQ[@]}"}; do
    if ! contains "${output}" "${n}"; then ok=0; fi
  done
  # Negative checks are meaningful only when the positive ones above hold.
  for n in ${NEG[@]+"${NEG[@]}"}; do
    if contains "${output}" "${n}"; then ok=0; fi
  done
  if [ "${ok}" -eq 1 ]; then
    echo "PASS ${label}"
    PASS=$((PASS + 1))
  else
    echo "FAIL ${label}: exit=${exit_code} (expected ${expectation})"
    for n in ${REQ[@]+"${REQ[@]}"}; do echo "  required substring: ${n}"; done
    for n in ${NEG[@]+"${NEG[@]}"}; do echo "  forbidden substring: ${n}"; done
    echo "  output (last 20 lines):"
    printf '%s\n' "${output}" | tail -20
    FAIL=$((FAIL + 1))
  fi
}

# --- A1: Dry-run wiring — BOTH check tasks appear in the assembleRelease graph ---
set_markers debug release
REQ=(":app:checkRustBinaries" ":app:checkArchiveRustBinaries")
NEG=()
gradle_case "A1 (dry-run wiring: assembleRelease lists both check tasks)" pass \
  ./gradlew :app:assembleRelease --dry-run --console=plain

# --- A2: signal marker=debug + assembleRelease → profile mismatch error ---
# (assembleRelease is on the CLI to set releaseRequested=true in the task;
#  the gate fires via preBuild→checkRustBinaries before any compilation.
#  The archive marker is pinned to release so only the signal task can throw.)
set_markers debug release
expect_fail_with "A2 (Release+signal debug→fail)" \
  "Release build requires release-profile Rust binaries, but found profile 'debug'" \
  ./gradlew :app:checkRustBinaries :app:assembleRelease --console=plain

# --- A3: signal marker absent + assembleRelease → missing profile error ---
set_markers absent release
expect_fail_with "A3 (Release+signal missing→fail)" \
  "but found profile 'missing'" \
  ./gradlew :app:checkRustBinaries :app:assembleRelease --console=plain

# --- A4: markers=release + probe task → signal gate passes, task non-vacuous ---
# Uses rust-gate-probe.init.gradle (CI-only) to register assembleCiGateProbeRelease
# on rootProject. Its name matches the release-task regex, so releaseRequested=true
# inside checkRustBinaries; marker=release → no profile mismatch → gate passes.
set_markers release release
REQ=('> Task :app:checkRustBinaries' 'rust-gate release probe executed')
NEG=('Release build requires release-profile')
gradle_case "A4 (Release+signal release+probe→pass, gate non-vacuous)" pass \
  ./gradlew -I ../scripts/rust-gate-probe.init.gradle \
  :app:checkRustBinaries assembleCiGateProbeRelease --console=plain

# ===========================================================================
# A5-A9: the SECOND crate's task, checkArchiveRustBinaries (#920)
# ===========================================================================

# --- A5: archive marker=debug + assembleRelease → archive profile mismatch ---
# Signal is pinned to release, so the only task that can throw is the archive one
# and the crate name in the message is the assertion.
set_markers release debug
expect_fail_with "A5 (Release+archive debug→fail)" \
  "Release build requires release-profile orbital_archive_reader binaries, but found profile 'debug'" \
  ./gradlew :app:checkArchiveRustBinaries :app:assembleRelease --console=plain

# --- A6: archive marker absent + assembleRelease → archive missing profile ---
set_markers release absent
expect_fail_with "A6 (Release+archive missing→fail)" \
  "orbital_archive_reader binaries, but found profile 'missing'" \
  ./gradlew :app:checkArchiveRustBinaries :app:assembleRelease --console=plain

# --- A7: markers=release + probe task → archive gate passes, non-vacuous ---
set_markers release release
REQ=('> Task :app:checkArchiveRustBinaries' 'rust-gate release probe executed')
NEG=('Release build requires release-profile')
gradle_case "A7 (Release+archive release+probe→pass, gate non-vacuous)" pass \
  ./gradlew -I ../scripts/rust-gate-probe.init.gradle \
  :app:checkArchiveRustBinaries assembleCiGateProbeRelease --console=plain

# --- A8: staleness — archive ubrn.config.yaml newer than the archive .a ---
# Non-release invocation: releaseRequested=false, so the profile gate is inert
# (both markers are debug) and the mtime branch is what must fail. ubrn.config.yaml
# is STAMPED ONLY (touch -t); its contents are never rewritten.
set_markers debug debug
restore_freshness
touch -t "$(future_stamp)" "${ARCHIVE_UBRN_CONFIG}"
REQ=("orbital_archive_reader sources are newer than Android binaries" "Changed files: ubrn.config.yaml")
NEG=('Release build requires release-profile')
gradle_case "A8 (archive ubrn.config.yaml stale→fail)" fail \
  ./gradlew :app:checkArchiveRustBinaries --console=plain

# --- A9: staleness — archive package.json newer than the archive .a ---
# A separate invocation rather than a second file stamped in A8: with only one
# file stale at a time the gate's changed-file list is exactly that file, so each
# of the archive task's two extra inputs is proved on its own. restore_freshness
# first undoes A8's stamp, which would otherwise ride along in the list.
set_markers debug debug
restore_freshness
touch -t "$(future_stamp)" "${ARCHIVE_PKG_JSON}"
REQ=("orbital_archive_reader sources are newer than Android binaries" "Changed files: package.json")
NEG=('Release build requires release-profile')
gradle_case "A9 (archive package.json stale→fail)" fail \
  ./gradlew :app:checkArchiveRustBinaries --console=plain

echo ""
echo "Android gate results: ${PASS} passed, ${FAIL} failed"
if [ "${FAIL}" -gt 0 ]; then
  exit 1
fi
