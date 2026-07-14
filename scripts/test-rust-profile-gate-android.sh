#!/usr/bin/env bash
# Integration harness for the Android Rust release-profile gate (issue #550).
# Run from repo root: bash scripts/test-rust-profile-gate-android.sh
#   or via: npm run test:rust-gate:android
#
# Precondition (A0): debug-profile Rust binaries + marker must exist before
# running this harness. Produce them with: npm run build:rust:android
#
# Tests (Gradle daemon shared across A1-A4 for speed):
#   A0  Precondition: .a files exist AND marker == 'debug'
#   A1  Dry-run wiring: assembleRelease --dry-run lists checkRustBinaries
#   A2  marker=debug  + assembleRelease → FAIL profile 'debug' error
#   A3  marker absent + assembleRelease → FAIL profile 'missing' error
#   A4  marker=release + no-op probe task → PASS, gate non-vacuous
#
# IMPORTANT: the gate fast-fails on A2/A3 because android/app/build.gradle's
# preBuild depends on checkRustBinaries — the dependency graph is the
# mechanism. assembleRelease is on the CLI only to populate
# taskGraph.allTasks for the release-detection regex inside the task.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MARKER="${REPO_ROOT}/packages/orbital-signal/android/src/main/jniLibs/rust-profile.txt"
ARM64_LIB="${REPO_ROOT}/packages/orbital-signal/android/src/main/jniLibs/arm64-v8a/liborbital_signal.a"
X86_64_LIB="${REPO_ROOT}/packages/orbital-signal/android/src/main/jniLibs/x86_64/liborbital_signal.a"

PASS=0
FAIL=0

# --- A0: Precondition ---
if [ ! -f "${ARM64_LIB}" ] || [ ! -f "${X86_64_LIB}" ]; then
  echo "ERROR A0: Rust .a binaries not found — run: npm run build:rust:android"
  exit 1
fi

if [ ! -f "${MARKER}" ]; then
  echo "ERROR A0: rust-profile.txt marker absent — run: npm run build:rust:android"
  exit 1
fi

MARKER_CONTENT=$(cat "${MARKER}")
if [ "${MARKER_CONTENT}" != "debug" ]; then
  echo "ERROR A0: marker content is '${MARKER_CONTENT}', expected 'debug' — run: npm run build:rust:android"
  exit 1
fi

echo "PASS A0 (precondition: debug binaries + marker present)"
PASS=$((PASS + 1))

# --- Snapshot marker for trap restoration ---
MARKER_ORIGINAL="${MARKER_CONTENT}"

cd "${REPO_ROOT}/android"

# Restore marker and stop Gradle daemon on exit
cleanup() {
  printf '%s' "${MARKER_ORIGINAL}" > "${MARKER}"
  ./gradlew --stop 2>/dev/null || true
}
trap cleanup EXIT

# Export env so all gradle invocations skip Sentry upload
export SENTRY_DISABLE_AUTO_UPLOAD=true

# Helper: assert command exits 0 AND (optionally) output contains substring
expect_pass() {
  local label="$1"
  local req_substring="${2:-}"
  shift 2
  local output exit_code
  set +e
  output=$("$@" 2>&1)
  exit_code=$?
  set -e
  local ok=1
  [ "${exit_code}" -ne 0 ] && ok=0
  if [ -n "${req_substring}" ] && ! printf '%s' "${output}" | grep -qF "${req_substring}"; then
    ok=0
  fi
  if [ "${ok}" -eq 1 ]; then
    echo "PASS ${label}"
    PASS=$((PASS + 1))
  else
    echo "FAIL ${label}: exit=${exit_code} (expected 0)"
    [ -n "${req_substring}" ] && echo "  required substring: ${req_substring}"
    echo "  output (last 20 lines):"
    printf '%s\n' "${output}" | tail -20
    FAIL=$((FAIL + 1))
  fi
}

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
  if ! printf '%s' "${output}" | grep -qF "${req_substring}"; then
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

# --- A1: Dry-run wiring — checkRustBinaries appears in assembleRelease graph ---
expect_pass "A1 (dry-run wiring: assembleRelease lists checkRustBinaries)" \
  ":app:checkRustBinaries" \
  ./gradlew :app:assembleRelease --dry-run --console=plain

# --- A2: marker=debug + assembleRelease → profile mismatch error ---
# (assembleRelease is on the CLI to set releaseRequested=true in the task;
#  the gate fires via preBuild→checkRustBinaries before any compilation)
printf 'debug' > "${MARKER}"
expect_fail_with "A2 (Release+debug→fail)" \
  "Release build requires release-profile Rust binaries, but found profile 'debug'" \
  ./gradlew :app:checkRustBinaries :app:assembleRelease --console=plain

# --- A3: marker absent + assembleRelease → missing profile error ---
rm -f "${MARKER}"
expect_fail_with "A3 (Release+missing→fail)" \
  "but found profile 'missing'" \
  ./gradlew :app:checkRustBinaries :app:assembleRelease --console=plain

# --- A4: marker=release + probe task → gate passes, task is non-vacuous ---
# Uses rust-gate-probe.init.gradle (CI-only) to register assembleCiGateProbeRelease
# on rootProject. Its name matches the release-task regex, so releaseRequested=true
# inside checkRustBinaries; marker=release → no profile mismatch → gate passes.
printf 'release' > "${MARKER}"
{
  output=$(./gradlew \
    -I ../scripts/rust-gate-probe.init.gradle \
    :app:checkRustBinaries assembleCiGateProbeRelease \
    --console=plain 2>&1)
  exit_code=$?
  ok=1
  [ "${exit_code}" -ne 0 ] && ok=0
  printf '%s' "${output}" | grep -qF '> Task :app:checkRustBinaries' || ok=0
  printf '%s' "${output}" | grep -qF 'Release build requires release-profile' && ok=0
  if [ "${ok}" -eq 1 ]; then
    echo "PASS A4 (Release+release+probe→pass, gate non-vacuous)"
    PASS=$((PASS + 1))
  else
    echo "FAIL A4: exit=${exit_code}"
    printf '%s\n' "${output}" | tail -20
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "Android gate results: ${PASS} passed, ${FAIL} failed"
if [ "${FAIL}" -gt 0 ]; then
  exit 1
fi
