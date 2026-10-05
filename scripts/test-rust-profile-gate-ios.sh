#!/usr/bin/env bash
# Unit harness for the iOS Rust provenance gate (#550, #813).
# Run from repo root: bash scripts/test-rust-profile-gate-ios.sh
#   or via: npm run test:rust-gate:ios
#
# READ-ONLY against the real checkout. Every behavioural case runs in a
# throwaway `mktemp -d` tree that mirrors the repo layout, with both
# scripts/verify-rust-profile-ios.sh and scripts/rust-input-digest.sh copied
# in (they derive all paths from their own location). Nothing under the real
# packages/orbital-signal is created, moved or rewritten — which is why this
# script is in `npm run gut-check` and the Android one is not.
#
# Cases:
#   I0   Podfile wiring — Podfile delegates to verify-rust-profile-ios.sh and
#        keeps the '[Orbital] Verify Rust release profile' phase name
#   A0   Real-repo anchor — rust-input-digest.sh succeeds against THIS
#        checkout and emits at least one .rs line (needs no build artefacts;
#        catches a relocated/empty crate that would make the gate vacuous)
#   P1   fresh Debug                              -> pass
#   P2   fresh Release (release marker)           -> pass
#   P3   tests/*.rs content change                -> pass (tests/ is excluded)
#   P4   identical-content rewrite (touch only)   -> pass (content, not mtime)
#   P5   optional inputs present and unchanged    -> pass
#   F1-F5  content change of src/*.rs, Cargo.toml, Cargo.lock,
#          rust-toolchain.toml, ubrn.config.yaml -> fail, names the path
#   F6   added src/*.rs                           -> fail, 'added'
#   F7   removed src/*.rs                         -> fail, 'removed'
#   F8   missing device slice                     -> fail, 'not found'
#   F9   missing simulator slice                  -> fail, 'not found'
#   F10  missing marker (Debug)                   -> fail, 'is missing'
#   F11  profile-only marker, no digest (Debug)   -> fail, 'no input digest'
#   F12  missing crate src dir                    -> fail, digest fails closed
#   F13  src dir with zero *.rs                   -> fail, digest fails closed
#   F14  Release with a debug marker              -> fail, profile message
#   F15  package.json content change (ubrn pin / build flags) -> fail
#   F16  optional build.rs content change         -> fail
#   F17  optional .cargo/config.toml change       -> fail
#   F18  optional build.rs APPEARS after the build -> fail, 'added'
#
# Every behavioural case uses scripts/write-rust-marker-ios.sh to write its
# marker, so the real writer is exercised on every PR (build-ios is main-only).

set -euo pipefail

# Pipe-free substring test (#790): `printf | grep -q` under pipefail SIGPIPEs on large output.
contains() { [ -n "$2" ] && [[ "$1" == *"$2"* ]]; }  # empty needle never matches

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="${REPO_ROOT}/scripts/verify-rust-profile-ios.sh"
DIGEST_SCRIPT="${REPO_ROOT}/scripts/rust-input-digest.sh"
WRITER_SCRIPT="${REPO_ROOT}/scripts/write-rust-marker-ios.sh"
PODFILE="${REPO_ROOT}/ios/Podfile"

PASS=0
FAIL=0

pass() { echo "PASS $1"; PASS=$((PASS + 1)); }
failed() { echo "FAIL $1"; FAIL=$((FAIL + 1)); }

# --- Fake-tree builder ------------------------------------------------------
# new_tree <profile> [optional-inputs] -> sets $T to a fresh fake tree.
#
# mktemp MUST happen in the PARENT shell. The first version of this harness did
# `new_tree debug`, so `TMP_ROOTS+=(...)` ran inside the command
# substitution's SUBSHELL and never reached the parent — the EXIT trap saw an
# empty array and leaked one tree per case (PR #859 review found 129 of them
# under /var/folders). `new_tree` assigns to the global $T instead of echoing a
# path, which keeps every mktemp registered for cleanup.
TMP_ROOTS=()
cleanup() {
  for t in ${TMP_ROOTS[@]+"${TMP_ROOTS[@]}"}; do
    [ -n "${t}" ] && [ -d "${t}" ] && rm -rf "${t}"
  done
}
trap cleanup EXIT

T=""
new_tree() {
  T="$(mktemp -d)"
  TMP_ROOTS+=("${T}")
  make_tree "${T}" "$@"
}

# make_tree <dir> <profile> [with-optional]
make_tree() {
  local t="$1"
  local profile="$2"
  local with_optional="${3:-}"

  local pkg="${t}/packages/orbital-signal"
  local crate="${pkg}/rust/orbital_signal"
  mkdir -p "${t}/scripts" "${crate}/src" "${crate}/tests" \
    "${pkg}/OrbitalSignalFramework.xcframework/ios-arm64" \
    "${pkg}/OrbitalSignalFramework.xcframework/ios-arm64_x86_64-simulator"

  cp "${SCRIPT}" "${t}/scripts/verify-rust-profile-ios.sh"
  cp "${DIGEST_SCRIPT}" "${t}/scripts/rust-input-digest.sh"
  cp "${WRITER_SCRIPT}" "${t}/scripts/write-rust-marker-ios.sh"

  printf 'pub fn a() {}\n' > "${crate}/src/lib.rs"
  printf 'pub fn b() {}\n' > "${crate}/src/keys.rs"
  printf 'fn t() {}\n' > "${crate}/tests/integration_tests.rs"
  printf '[package]\nname = "orbital_signal"\n' > "${crate}/Cargo.toml"
  printf '# lock\nversion = 4\n' > "${crate}/Cargo.lock"
  printf '[toolchain]\nchannel = "1.94.1"\n' > "${t}/rust-toolchain.toml"
  # Heredoc, not printf: a format string starting with '-' is parsed as a flag.
  cat > "${pkg}/ubrn.config.yaml" <<'YAML'
---
rust:
  directory: ./rust/orbital_signal
YAML
  printf 'ar\n' > "${pkg}/OrbitalSignalFramework.xcframework/ios-arm64/liborbital_signal.a"
  printf 'ar\n' > "${pkg}/OrbitalSignalFramework.xcframework/ios-arm64_x86_64-simulator/liborbital_signal.a"

  # package.json is a REQUIRED digest input: it pins the ubrn toolchain version
  # and carries the build:ios command lines (cargo feature flags).
  printf '{\n  "name": "orbital-signal",\n  "dependencies": { "uniffi-bindgen-react-native": "0.31.0-2" }\n}\n' > "${pkg}/package.json"

  # Optional inputs: absent by default (as in the real repo), present on request.
  if [ "${with_optional}" = "with-optional" ]; then
    mkdir -p "${crate}/.cargo"
    printf 'fn main() {}\n' > "${crate}/build.rs"
    printf '[build]\nrustflags = []\n' > "${crate}/.cargo/config.toml"
  fi

  # Marker written by the REAL writer, the same one build:ios[:release] calls.
  bash "${t}/scripts/write-rust-marker-ios.sh" "${profile}"
}

# --- Case runner ------------------------------------------------------------
# run_case <label> <CONFIGURATION> <tree> <expected_exit> [needle...]
run_case() {
  local label="$1" config="$2" tree="$3" expected_exit="$4"
  shift 4
  local output exit_code ok=1
  set +e
  output=$(env CONFIGURATION="${config}" bash "${tree}/scripts/verify-rust-profile-ios.sh" 2>&1)
  exit_code=$?
  set -e
  if [ "${exit_code}" -ne "${expected_exit}" ]; then ok=0; fi
  local needle
  for needle in "$@"; do
    if ! contains "${output}" "${needle}"; then ok=0; fi
  done
  if [ "${ok}" -eq 1 ]; then
    pass "${label}"
  else
    failed "${label}: exit=${exit_code} (expected ${expected_exit})"
    for needle in "$@"; do
      echo "  expected substring: ${needle}"
    done
    echo "  output: ${output}"
  fi
}

# ===========================================================================
# I0: Podfile wiring — phase name and script delegation must both survive
# ===========================================================================
if grep -qF "verify-rust-profile-ios.sh" "${PODFILE}" && \
   grep -qF "[Orbital] Verify Rust release profile" "${PODFILE}"; then
  pass "I0 (Podfile wiring)"
else
  failed "I0 (Podfile wiring): Podfile missing 'verify-rust-profile-ios.sh' or '[Orbital] Verify Rust release profile'"
fi

# ===========================================================================
# A0: real-repo anchor — the digest script must resolve THIS checkout's crate
# ===========================================================================
set +e
ANCHOR_OUT=$(bash "${DIGEST_SCRIPT}" 2>&1)
ANCHOR_EXIT=$?
set -e
ANCHOR_RS=0
while IFS= read -r line; do
  case "${line}" in *.rs) ANCHOR_RS=$((ANCHOR_RS + 1)) ;; esac
done <<<"${ANCHOR_OUT}"
if [ "${ANCHOR_EXIT}" -eq 0 ] && [ "${ANCHOR_RS}" -ge 1 ] && contains "${ANCHOR_OUT}" "src/lib.rs"; then
  pass "A0 (real-repo digest anchor: ${ANCHOR_RS} .rs inputs)"
else
  failed "A0 (real-repo digest anchor): exit=${ANCHOR_EXIT}, .rs lines=${ANCHOR_RS}"
  echo "  output: ${ANCHOR_OUT}"
fi

# ===========================================================================
# Passing cases
# ===========================================================================
new_tree debug
run_case "P1 (fresh Debug -> pass)" Debug "${T}" 0

new_tree release
run_case "P2 (fresh Release -> pass)" Release "${T}" 0

new_tree debug
printf 'fn t() {}\nfn t2() {}\n' > "${T}/packages/orbital-signal/rust/orbital_signal/tests/integration_tests.rs"
run_case "P3 (tests/*.rs change -> pass)" Debug "${T}" 0

new_tree debug
printf 'pub fn a() {}\n' > "${T}/packages/orbital-signal/rust/orbital_signal/src/lib.rs"  # identical bytes
touch "${T}/packages/orbital-signal/rust/orbital_signal/src/lib.rs"
touch "${T}/packages/orbital-signal/rust/orbital_signal/Cargo.lock"
run_case "P4 (identical-content rewrite/touch -> pass)" Debug "${T}" 0

new_tree debug with-optional
run_case "P5 (optional inputs present + fresh -> pass)" Debug "${T}" 0

# ===========================================================================
# Content-change failures
# ===========================================================================
new_tree debug
printf 'pub fn a() {}\n// edited\n' > "${T}/packages/orbital-signal/rust/orbital_signal/src/lib.rs"
run_case "F1 (src/lib.rs content change -> fail)" Debug "${T}" 1 "STALE" "changed:" "src/lib.rs" "npm run build:rust:ios"

new_tree debug
printf '[package]\nname = "orbital_signal"\nversion = "0.0.2"\n' > "${T}/packages/orbital-signal/rust/orbital_signal/Cargo.toml"
run_case "F2 (Cargo.toml content change -> fail)" Debug "${T}" 1 "STALE" "Cargo.toml"

new_tree debug
printf '# lock\nversion = 4\n# drift\n' > "${T}/packages/orbital-signal/rust/orbital_signal/Cargo.lock"
run_case "F3 (Cargo.lock content change -> fail)" Debug "${T}" 1 "STALE" "Cargo.lock"

new_tree release
printf '[toolchain]\nchannel = "1.95.0"\n' > "${T}/rust-toolchain.toml"
run_case "F4 (rust-toolchain.toml change -> fail)" Release "${T}" 1 "STALE" "rust-toolchain.toml" "npm run build:rust:ios:release"

new_tree debug
cat > "${T}/packages/orbital-signal/ubrn.config.yaml" <<'YAML'
---
rust:
  directory: ./rust/orbital_signal
ios:
  targets: []
YAML
run_case "F5 (ubrn.config.yaml change -> fail)" Debug "${T}" 1 "STALE" "ubrn.config.yaml"

# ===========================================================================
# File-set-change failures
# ===========================================================================
new_tree debug
printf 'pub fn c() {}\n' > "${T}/packages/orbital-signal/rust/orbital_signal/src/newmod.rs"
run_case "F6 (added src/*.rs -> fail)" Debug "${T}" 1 "STALE" "added:" "newmod.rs"

new_tree debug
rm -f "${T}/packages/orbital-signal/rust/orbital_signal/src/keys.rs"
run_case "F7 (removed src/*.rs -> fail)" Debug "${T}" 1 "STALE" "removed:" "keys.rs"

# ===========================================================================
# Missing-artefact failures
# ===========================================================================
new_tree debug
rm -f "${T}/packages/orbital-signal/OrbitalSignalFramework.xcframework/ios-arm64/liborbital_signal.a"
run_case "F8 (missing device slice -> fail)" Debug "${T}" 1 "xcframework not found" "missing device slice"

new_tree debug
rm -f "${T}/packages/orbital-signal/OrbitalSignalFramework.xcframework/ios-arm64_x86_64-simulator/liborbital_signal.a"
run_case "F9 (missing simulator slice -> fail)" Debug "${T}" 1 "xcframework not found" "missing simulator slice"

new_tree debug
rm -f "${T}/packages/orbital-signal/rust-profile-ios.txt"
run_case "F10 (missing marker, Debug -> fail)" Debug "${T}" 1 "marker" "is missing"

new_tree debug
printf 'debug\n' > "${T}/packages/orbital-signal/rust-profile-ios.txt"
run_case "F11 (profile-only marker, Debug -> fail)" Debug "${T}" 1 "no input digest"

# ===========================================================================
# Bad-source-tree failures (digest fails closed, gate refuses to link)
# ===========================================================================
new_tree debug
rm -rf "${T}/packages/orbital-signal/rust/orbital_signal/src"
run_case "F12 (missing src dir -> fail)" Debug "${T}" 1 "crate source dir not found" "Refusing to link"

new_tree debug
rm -f "${T}/packages/orbital-signal/rust/orbital_signal/src"/*.rs
run_case "F13 (src with zero *.rs -> fail)" Debug "${T}" 1 "no *.rs files" "Refusing to link"

# ===========================================================================
# Profile failure
# ===========================================================================
new_tree debug
run_case "F14 (Release + debug marker -> fail)" Release "${T}" 1 "profile 'debug', not 'release'" "npm run build:rust:ios:release"

# ===========================================================================
# package.json + optional inputs (PR #859 review)
# ===========================================================================
new_tree debug
printf '{\n  "name": "orbital-signal",\n  "dependencies": { "uniffi-bindgen-react-native": "0.32.0" }\n}\n' > "${T}/packages/orbital-signal/package.json"
run_case "F15 (package.json change -> fail)" Debug "${T}" 1 "STALE" "orbital-signal/package.json"

new_tree debug with-optional
printf 'fn main() { println!("changed"); }\n' > "${T}/packages/orbital-signal/rust/orbital_signal/build.rs"
run_case "F16 (build.rs change -> fail)" Debug "${T}" 1 "STALE" "build.rs"

new_tree debug with-optional
printf '[build]\nrustflags = ["-C", "target-cpu=native"]\n' > "${T}/packages/orbital-signal/rust/orbital_signal/.cargo/config.toml"
run_case "F17 (.cargo/config.toml change -> fail)" Debug "${T}" 1 "STALE" ".cargo/config.toml"

new_tree debug
printf 'fn main() {}\n' > "${T}/packages/orbital-signal/rust/orbital_signal/build.rs"
run_case "F18 (optional build.rs appears -> fail)" Debug "${T}" 1 "STALE" "added:" "build.rs"

echo ""
echo "iOS gate results: ${PASS} passed, ${FAIL} failed"
if [ "${FAIL}" -gt 0 ]; then
  exit 1
fi
