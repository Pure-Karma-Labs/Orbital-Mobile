#!/usr/bin/env bash
# Fixture harness for scripts/assert-no-absolute-pod-paths.sh (issue #767).
# Run from repo root: bash scripts/test-assert-no-absolute-pod-paths.sh
#   or via: npm run test:pod-paths
#
# Tests:
#   T1  Clean tree (PODS_ROOT-relative FRAMEWORK_SEARCH_PATHS only)     → exit 0
#   T2  /Users/runner/Library/Caches/... in RNSentry.debug.xcconfig     → exit 1
#   T3  \"/Users/runner/Library/...\" inside the podspec JSON            → exit 1
#   T4  hermes /Library/Frameworks/universal line only                  → exit 0  (false-positive guard)
#   T5  RNSentry.release.xcconfig missing, outcome=success              → exit 1
#   T6  outcome=failure, JSON only; clean → exit 0; leaked JSON → exit 1
#   T7  FRAMEWORK_SEARCH_PATHS with "/tmp/sentry-cache/..." (non-/Users) → exit 1
#   T8  aggregate Pods-OrbitalMobile xcconfigs missing (required-file guard) → exit 1
#
# This harness never touches ios/Pods or any real repo file.
#
# shellcheck disable=SC2016  # fixture strings hold literal xcconfig $(PODS_ROOT) / ${PODS_ROOT} syntax on purpose

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="${REPO_ROOT}/scripts/assert-no-absolute-pod-paths.sh"

PASS=0
FAIL=0

# --- Create a temp dir for fixtures; clean up on exit ---
TMPDIR_BASE=$(mktemp -d)
cleanup() { rm -rf "$TMPDIR_BASE"; }
trap cleanup EXIT

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
    else
      echo "  output: ${output}"
    fi
    FAIL=$((FAIL + 1))
  fi
}

# --- Fixture builder ---
# Usage: make_fixture <dir> [leak_xcconfig] [leak_json] [missing_xcconfig] [hermes_only] [empty_xcconfig_dir]
#   leak_xcconfig: "1" → write /Users/... into RNSentry.debug.xcconfig
#   leak_json:     "1" → write \"/Users/...\" into RNSentry.podspec.json
#   missing_xcconfig: name of a required xcconfig to omit (e.g. "RNSentry.release")
#   hermes_only:   "1" → add a hermes FRAMEWORK_SEARCH_PATHS line (should NOT trigger)
#   empty_xcconfig_dir: "1" → create Target Support Files dir but no xcconfigs
#   leak_tmp:      "1" → write FRAMEWORK_SEARCH_PATHS with "/tmp/..." into a xcconfig
make_fixture() {
  local dir="$1"
  local leak_xcconfig="${2:-0}"
  local leak_json="${3:-0}"
  local missing_xcconfig="${4:-}"
  local hermes_only="${5:-0}"
  local empty_xcconfig_dir="${6:-0}"
  local leak_tmp="${7:-0}"

  # RNSentry xcconfigs
  local rnsentry_dir="${dir}/Target Support Files/RNSentry"
  mkdir -p "$rnsentry_dir"

  # Mirrors the real generated form: quoted ${PODS_ROOT} entries after $(inherited).
  local debug_xcconfig_content='FRAMEWORK_SEARCH_PATHS = $(inherited) "${PODS_ROOT}/hermes-engine/destroot/Library/Frameworks/universal" "${PODS_XCFRAMEWORKS_BUILD_DIR}/hermes-engine/Pre-built" "$(PODS_ROOT)/sentry-xcframeworks/9.19.1/Sentry.xcframework/ios-arm64"'
  local release_xcconfig_content='FRAMEWORK_SEARCH_PATHS = $(inherited) "${PODS_ROOT}/hermes-engine/destroot/Library/Frameworks/universal" "${PODS_XCFRAMEWORKS_BUILD_DIR}/hermes-engine/Pre-built" "$(PODS_ROOT)/sentry-xcframeworks/9.19.1/Sentry.xcframework/ios-arm64"'

  if [ "$leak_xcconfig" = "1" ]; then
    debug_xcconfig_content='FRAMEWORK_SEARCH_PATHS = /Users/runner/Library/Caches/sentry-react-native/xcframeworks/9.19.1/Sentry.xcframework/ios-arm64'
  fi
  if [ "$leak_tmp" = "1" ]; then
    debug_xcconfig_content='FRAMEWORK_SEARCH_PATHS[sdk=iphoneos*] = $(inherited) "/tmp/sentry-cache/Sentry.xcframework/ios-arm64"'
  fi
  if [ "$hermes_only" = "1" ]; then
    debug_xcconfig_content='FRAMEWORK_SEARCH_PATHS = $(inherited) "${PODS_ROOT}/hermes-engine/destroot/Library/Frameworks/universal" "${PODS_XCFRAMEWORKS_BUILD_DIR}/hermes-engine/Pre-built"'
  fi

  [ "$missing_xcconfig" = "RNSentry.debug" ] || printf '%s\n' "$debug_xcconfig_content" > "${rnsentry_dir}/RNSentry.debug.xcconfig"
  [ "$missing_xcconfig" = "RNSentry.release" ] || printf '%s\n' "$release_xcconfig_content" > "${rnsentry_dir}/RNSentry.release.xcconfig"

  # Pods-OrbitalMobile aggregate xcconfigs
  local agg_dir="${dir}/Target Support Files/Pods-OrbitalMobile"
  mkdir -p "$agg_dir"
  if [ "$empty_xcconfig_dir" != "1" ]; then
    printf '%s\n' 'FRAMEWORK_SEARCH_PATHS = $(inherited) "${PODS_ROOT}/hermes-engine/destroot/Library/Frameworks/universal" "${PODS_XCFRAMEWORKS_BUILD_DIR}/hermes-engine/Pre-built"' > "${agg_dir}/Pods-OrbitalMobile.debug.xcconfig"
    printf '%s\n' 'FRAMEWORK_SEARCH_PATHS = $(inherited) "${PODS_ROOT}/hermes-engine/destroot/Library/Frameworks/universal" "${PODS_XCFRAMEWORKS_BUILD_DIR}/hermes-engine/Pre-built"' > "${agg_dir}/Pods-OrbitalMobile.release.xcconfig"
  fi

  # RNSentry podspec JSON
  local podspecs_dir="${dir}/Local Podspecs"
  mkdir -p "$podspecs_dir"
  local json_content='{"name":"RNSentry","version":"9.19.1","FRAMEWORK_SEARCH_PATHS":"$(PODS_ROOT)/sentry-xcframeworks/9.19.1"}'
  if [ "$leak_json" = "1" ]; then
    json_content='{"name":"RNSentry","version":"9.19.1","FRAMEWORK_SEARCH_PATHS":"\"/Users/runner/Library/Caches/sentry-react-native/xcframeworks/9.19.1/Sentry.xcframework/ios-arm64\""}'
  fi
  printf '%s\n' "$json_content" > "${podspecs_dir}/RNSentry.podspec.json"
}

# T1: Clean tree → exit 0
FIXTURE="${TMPDIR_BASE}/t1"
make_fixture "$FIXTURE"
run_test "T1 (clean tree → exit 0)" 0 "" \
  bash "$SCRIPT" "$FIXTURE"

# T2: /Users/... in RNSentry.debug.xcconfig → exit 1, message contains "absolute"
FIXTURE="${TMPDIR_BASE}/t2"
make_fixture "$FIXTURE" "1"
run_test "T2 (/Users/ in debug.xcconfig → exit 1)" 1 "absolute" \
  bash "$SCRIPT" "$FIXTURE"

# T3: \"/Users/...\" in podspec JSON → exit 1
FIXTURE="${TMPDIR_BASE}/t3"
make_fixture "$FIXTURE" "0" "1"
run_test "T3 (/Users/ in podspec JSON → exit 1)" 1 "absolute" \
  bash "$SCRIPT" "$FIXTURE"

# T4: hermes /Library/Frameworks/universal line only → exit 0 (false-positive guard)
FIXTURE="${TMPDIR_BASE}/t4"
make_fixture "$FIXTURE" "0" "0" "" "1"
run_test "T4 (hermes /Library/ only → exit 0)" 0 "" \
  bash "$SCRIPT" "$FIXTURE"

# T5: RNSentry.release.xcconfig missing, outcome=success → exit 1, "not found after a successful"
FIXTURE="${TMPDIR_BASE}/t5"
make_fixture "$FIXTURE" "0" "0" "RNSentry.release"
run_test "T5 (missing release xcconfig → exit 1)" 1 "not found after a successful" \
  bash "$SCRIPT" "$FIXTURE"

# T6a: outcome=failure, only JSON present and clean → exit 0
FIXTURE="${TMPDIR_BASE}/t6a"
# Create only Local Podspecs (no Target Support Files xcconfigs needed for failure mode)
mkdir -p "${FIXTURE}/Local Podspecs"
printf '%s\n' '{"name":"RNSentry","FRAMEWORK_SEARCH_PATHS":"$(PODS_ROOT)/sentry-xcframeworks/9.19.1"}' > "${FIXTURE}/Local Podspecs/RNSentry.podspec.json"
run_test "T6a (failure mode, clean JSON → exit 0)" 0 "" \
  env POD_INSTALL_OUTCOME=failure bash "$SCRIPT" "$FIXTURE"

# T6b: outcome=failure, leaked JSON → exit 1
FIXTURE="${TMPDIR_BASE}/t6b"
mkdir -p "${FIXTURE}/Local Podspecs"
printf '%s\n' '{"name":"RNSentry","FRAMEWORK_SEARCH_PATHS":"\"/Users/runner/Library/Caches/sentry-react-native/xcframeworks/9.19.1\""}' > "${FIXTURE}/Local Podspecs/RNSentry.podspec.json"
run_test "T6b (failure mode, leaked JSON → exit 1)" 1 "absolute" \
  env POD_INSTALL_OUTCOME=failure bash "$SCRIPT" "$FIXTURE"

# T7: FRAMEWORK_SEARCH_PATHS with "/tmp/..." (non-/Users root) → exit 1
FIXTURE="${TMPDIR_BASE}/t7"
make_fixture "$FIXTURE" "0" "0" "" "0" "0" "1"
run_test "T7 (/tmp/ quoted absolute FRAMEWORK_SEARCH_PATHS → exit 1)" 1 "absolute" \
  bash "$SCRIPT" "$FIXTURE"

# T8: aggregate Pods-OrbitalMobile xcconfigs missing → exit 1 (required-file guard; the
#     directory-count guard behind it is unreachable while the four required files exist)
FIXTURE="${TMPDIR_BASE}/t8"
make_fixture "$FIXTURE" "0" "0" "" "0" "1"
run_test "T8 (aggregate xcconfigs missing → exit 1)" 1 "vacuously" \
  bash "$SCRIPT" "$FIXTURE"

echo ""
echo "Pod-path assertion results: ${PASS} passed, ${FAIL} failed"
if [ "${FAIL}" -gt 0 ]; then
  exit 1
fi
