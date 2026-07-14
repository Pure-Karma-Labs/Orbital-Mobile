#!/usr/bin/env bash
# Unit harness for the iOS Rust release-profile gate (issue #550).
# Run from repo root: bash scripts/test-rust-profile-gate-ios.sh
#   or via: npm run test:rust-gate:ios
#
# Tests:
#   I0  Podfile wiring — Podfile delegates to verify-rust-profile-ios.sh
#   I1  CONFIGURATION=Release, marker=debug  → exit 1 + error message
#   I2  CONFIGURATION=Release, marker absent → exit 1 + 'profile missing'
#   I3  CONFIGURATION=Release, marker=release→ exit 0
#   I4  CONFIGURATION=Debug,   marker=debug  → exit 0 (gate inactive)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="${REPO_ROOT}/scripts/verify-rust-profile-ios.sh"
PODFILE="${REPO_ROOT}/ios/Podfile"
MARKER="${REPO_ROOT}/packages/orbital-signal/rust-profile-ios.txt"

PASS=0
FAIL=0

# --- Snapshot marker state (it may be gitignored and absent) ---
if [ -f "${MARKER}" ]; then
  MARKER_BACKUP=$(cat "${MARKER}")
  MARKER_EXISTS=1
else
  MARKER_BACKUP=""
  MARKER_EXISTS=0
fi

restore_marker() {
  if [ "${MARKER_EXISTS}" -eq 1 ]; then
    printf '%s' "${MARKER_BACKUP}" > "${MARKER}"
  else
    rm -f "${MARKER}"
  fi
}
trap restore_marker EXIT

# --- Helper: run a command, assert exit code and optional substring ---
run_test() {
  local label="$1"
  local expected_exit="$2"
  local expected_substring="$3"
  shift 3
  local output exit_code
  set +e
  output=$("$@" 2>&1)
  exit_code=$?
  set -e
  local ok=1
  if [ "${exit_code}" -ne "${expected_exit}" ]; then
    ok=0
  fi
  if [ -n "${expected_substring}" ] && ! printf '%s' "${output}" | grep -qF "${expected_substring}"; then
    ok=0
  fi
  if [ "${ok}" -eq 1 ]; then
    echo "PASS ${label}"
    PASS=$((PASS + 1))
  else
    echo "FAIL ${label}: exit=${exit_code} (expected ${expected_exit})"
    if [ -n "${expected_substring}" ]; then
      echo "  expected substring: ${expected_substring}"
      echo "  output: ${output}"
    fi
    FAIL=$((FAIL + 1))
  fi
}

# I0: Podfile must reference the external script and keep the phase name
if grep -qF "verify-rust-profile-ios.sh" "${PODFILE}" && \
   grep -qF "[Orbital] Verify Rust release profile" "${PODFILE}"; then
  echo "PASS I0 (Podfile wiring)"
  PASS=$((PASS + 1))
else
  echo "FAIL I0 (Podfile wiring): Podfile missing 'verify-rust-profile-ios.sh' or '[Orbital] Verify Rust release profile'"
  FAIL=$((FAIL + 1))
fi

# I1: Release + marker=debug → fail, message names the wrong profile
printf 'debug' > "${MARKER}"
run_test "I1 (Release+debug→fail)" 1 "profile 'debug', not 'release'" \
  env CONFIGURATION=Release bash "${SCRIPT}"

# I2: Release + missing marker → fail, message says 'missing'
rm -f "${MARKER}"
run_test "I2 (Release+missing→fail)" 1 "profile 'missing'" \
  env CONFIGURATION=Release bash "${SCRIPT}"

# I3: Release + marker=release → pass
printf 'release' > "${MARKER}"
run_test "I3 (Release+release→pass)" 0 "" \
  env CONFIGURATION=Release bash "${SCRIPT}"

# I4: Debug + marker=debug → pass (gate is inactive for non-Release)
printf 'debug' > "${MARKER}"
run_test "I4 (Debug+debug→pass)" 0 "" \
  env CONFIGURATION=Debug bash "${SCRIPT}"

echo ""
echo "iOS gate results: ${PASS} passed, ${FAIL} failed"
if [ "${FAIL}" -gt 0 ]; then
  exit 1
fi
