#!/usr/bin/env bash
# Unit harness for the iOS Rust provenance gate (#550, #813, #920).
# Run from repo root: bash scripts/test-rust-profile-gate-ios.sh
#   or via: npm run test:rust-gate:ios
#
# READ-ONLY against the real checkout. Every behavioural case runs in a
# throwaway `mktemp -d` tree that mirrors the repo layout for BOTH Rust crates,
# with all four scripts copied in (verify-rust-profile-ios.sh,
# write-rust-marker-ios.sh and the two rust-input-digest*.sh — they derive all
# paths from their own location). Nothing under the real packages/orbital-signal
# or packages/orbital-archive-reader is created, moved or rewritten — which is
# why this script is in `npm run gut-check` and the Android one is not.
#
# TWO CRATES (#920). The verifier, the marker writer and the digest take an
# OPTIONAL `signal|archive` selector defaulting to `signal`, so every
# behavioural case below is written ONCE and run for both crates via
# `crate_paths` + a `for CRATE in signal archive` loop. Labels carry the crate:
# `F1 [signal]`, `F1 [archive]`. The default-selector call sites (ios/Podfile's
# first phase and packages/orbital-signal/package.json) get their own explicit
# no-argument proofs, D1 and D2 — without them, a default flipped to `archive`
# would still show 46 green per-crate cases.
#
# Cases:
#   I0   Podfile wiring — Podfile delegates to verify-rust-profile-ios.sh, keeps
#        BOTH phase names ('[Orbital] Verify Rust release profile' and
#        '... (archive)') and passes the literal `archive` selector
#   A0   Real-repo anchor, once per crate — rust-input-digest.sh and
#        rust-input-digest-archive.sh each succeed against THIS checkout and
#        emit at least one .rs line (needs no build artefacts; catches a
#        relocated/empty crate that would make the gate vacuous)
#   D1   writer default $2 — `write-rust-marker-ios.sh debug` (no selector)
#        writes the SIGNAL marker, which then validates
#   D2   verifier default $1 — `verify-rust-profile-ios.sh` (no selector) still
#        fails on a tampered SIGNAL input
#
# Per crate ([signal] and [archive]):
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
# Cross-crate (#920):
#   F19  unknown crate selector 'bogus'           -> exit 2, 'unknown crate selector'
#   F20a/F20b  isolation: ONLY the archive crate tampered -> signal verify
#              passes, archive verify fails naming the archive path
#   F21a/F21b  mirror: ONLY the signal crate tampered -> archive verify passes,
#              signal verify fails naming the signal path
#
# Every behavioural case uses scripts/write-rust-marker-ios.sh to write BOTH
# markers, so the real writer is exercised on every PR (build-ios is main-only).

set -euo pipefail

# Pipe-free substring test (#790): `printf | grep -q` under pipefail SIGPIPEs on large output.
contains() { [ -n "$2" ] && [[ "$1" == *"$2"* ]]; }  # empty needle never matches

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="${REPO_ROOT}/scripts/verify-rust-profile-ios.sh"
DIGEST_SCRIPT="${REPO_ROOT}/scripts/rust-input-digest.sh"
DIGEST_SCRIPT_ARCHIVE="${REPO_ROOT}/scripts/rust-input-digest-archive.sh"
WRITER_SCRIPT="${REPO_ROOT}/scripts/write-rust-marker-ios.sh"
PODFILE="${REPO_ROOT}/ios/Podfile"

PASS=0
FAIL=0

pass() { echo "PASS $1"; PASS=$((PASS + 1)); }
failed() { echo "FAIL $1"; FAIL=$((FAIL + 1)); }

# --- Per-crate paths and strings -------------------------------------------
# crate_paths <signal|archive> sets the CP_* globals, all relative to a tree
# root (the fake tree's, or the repo's). Cases interpolate "${T}/${CP_*}". The
# needle strings (CP_LABEL, CP_REBUILD) are the verifier's own literals, so a
# crate whose messages regress to the other crate's wording fails here.
CP_PKG=""
CP_CRATE=""
CP_XCF=""
CP_LIB=""
CP_LABEL=""
CP_REBUILD=""
crate_paths() {
  case "$1" in
    signal)
      CP_PKG="packages/orbital-signal"
      CP_CRATE="packages/orbital-signal/rust/orbital_signal"
      CP_XCF="packages/orbital-signal/OrbitalSignalFramework.xcframework"
      CP_LIB="liborbital_signal.a"
      CP_LABEL="OrbitalSignal"
      CP_REBUILD="npm run build:rust:ios"
      ;;
    archive)
      CP_PKG="packages/orbital-archive-reader"
      CP_CRATE="packages/orbital-archive-reader/rust/orbital_archive_reader"
      CP_XCF="packages/orbital-archive-reader/OrbitalArchiveReaderFramework.xcframework"
      CP_LIB="liborbital_archive_reader.a"
      CP_LABEL="OrbitalArchiveReader"
      CP_REBUILD="npm run build:rust:archive:ios"
      ;;
    *)
      echo "harness bug: crate_paths: unknown crate '$1'" >&2
      exit 2
      ;;
  esac
}

# --- Fake-tree builder ------------------------------------------------------
# new_tree <profile> [with-optional] -> sets $T to a fresh fake tree holding
# BOTH packages, both xcframeworks (both slices each) and both markers.
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

  mkdir -p "${t}/scripts"
  cp "${SCRIPT}" "${t}/scripts/verify-rust-profile-ios.sh"
  cp "${DIGEST_SCRIPT}" "${t}/scripts/rust-input-digest.sh"
  cp "${DIGEST_SCRIPT_ARCHIVE}" "${t}/scripts/rust-input-digest-archive.sh"
  cp "${WRITER_SCRIPT}" "${t}/scripts/write-rust-marker-ios.sh"

  # ONE repo-root toolchain pin covers both crates (security invariant 18
  # forbids a per-package rust-toolchain file), so it is written once here and
  # a change to it must invalidate BOTH markers.
  printf '[toolchain]\nchannel = "1.94.1"\n' > "${t}/rust-toolchain.toml"

  make_crate_tree "${t}" signal "${with_optional}"
  make_crate_tree "${t}" archive "${with_optional}"

  # Markers written by the REAL writer, the same one each package's
  # build:ios[:release] calls. Written AFTER both crates exist, because each
  # digest hashes the shared rust-toolchain.toml.
  bash "${t}/scripts/write-rust-marker-ios.sh" "${profile}" signal
  bash "${t}/scripts/write-rust-marker-ios.sh" "${profile}" archive
}

# make_crate_tree <dir> <signal|archive> [with-optional]
# Sources are per-crate but deliberately identical in shape, so one case body
# can tamper either crate through the CP_* paths.
#
# The CP_* names are declared `local` HERE on purpose: bash is dynamically
# scoped, so crate_paths assigns to these locals and the caller's CP_* (set for
# the crate under test by the `for CRATE` loop) survives a tree build that has
# to walk both crates. Without this, every case body would silently read the
# LAST crate make_tree happened to create.
make_crate_tree() {
  local t="$1"
  local sel="$2"
  local with_optional="${3:-}"
  local CP_PKG CP_CRATE CP_XCF CP_LIB CP_LABEL CP_REBUILD
  crate_paths "${sel}"

  local pkg="${t}/${CP_PKG}"
  local crate="${t}/${CP_CRATE}"
  local xcf="${t}/${CP_XCF}"
  mkdir -p "${crate}/src" "${crate}/tests" \
    "${xcf}/ios-arm64" \
    "${xcf}/ios-arm64_x86_64-simulator"

  printf 'pub fn a() {}\n' > "${crate}/src/lib.rs"
  printf 'pub fn b() {}\n' > "${crate}/src/keys.rs"
  printf 'fn t() {}\n' > "${crate}/tests/integration_tests.rs"
  printf '[package]\nname = "%s"\n' "${sel}" > "${crate}/Cargo.toml"
  printf '# lock\nversion = 4\n' > "${crate}/Cargo.lock"
  # Heredoc, not printf: a format string starting with '-' is parsed as a flag.
  cat > "${pkg}/ubrn.config.yaml" <<YAML
---
rust:
  directory: ./rust/$(basename "${CP_CRATE}")
YAML
  printf 'ar\n' > "${xcf}/ios-arm64/${CP_LIB}"
  printf 'ar\n' > "${xcf}/ios-arm64_x86_64-simulator/${CP_LIB}"

  # package.json is a REQUIRED digest input: it pins the ubrn toolchain version
  # and carries the build:ios command lines (cargo feature flags).
  printf '{\n  "name": "%s",\n  "dependencies": { "uniffi-bindgen-react-native": "0.31.0-2" }\n}\n' \
    "$(basename "${CP_PKG}")" > "${pkg}/package.json"

  # Optional inputs: absent by default (as in the real repo), present on request.
  if [ "${with_optional}" = "with-optional" ]; then
    mkdir -p "${crate}/.cargo"
    printf 'fn main() {}\n' > "${crate}/build.rs"
    printf '[build]\nrustflags = []\n' > "${crate}/.cargo/config.toml"
  fi
}

# --- Case runner ------------------------------------------------------------
# run_case <label> <CONFIGURATION> <tree> <crate> <expected_exit> [needle...]
# <crate> is 'signal', 'archive', anything else the verifier should reject, or
# the EMPTY STRING to invoke the verifier with NO positional argument (the
# default-selector path the Podfile's first phase uses).
run_case() {
  local label="$1" config="$2" tree="$3" crate="$4" expected_exit="$5"
  shift 5
  local output exit_code ok=1
  set +e
  if [ -z "${crate}" ]; then
    output=$(env CONFIGURATION="${config}" bash "${tree}/scripts/verify-rust-profile-ios.sh" 2>&1)
  else
    output=$(env CONFIGURATION="${config}" bash "${tree}/scripts/verify-rust-profile-ios.sh" "${crate}" 2>&1)
  fi
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

# --- Real-repo digest anchor ------------------------------------------------
# anchor_case <id> <digest script> <needle>
anchor_case() {
  local id="$1" script="$2" needle="$3"
  local out code rs line
  set +e
  out=$(bash "${script}" 2>&1)
  code=$?
  set -e
  rs=0
  while IFS= read -r line; do
    case "${line}" in *.rs) rs=$((rs + 1)) ;; esac
  done <<<"${out}"
  if [ "${code}" -eq 0 ] && [ "${rs}" -ge 1 ] && contains "${out}" "${needle}"; then
    pass "${id} (real-repo digest anchor: ${rs} .rs inputs)"
  else
    failed "${id} (real-repo digest anchor): exit=${code}, .rs lines=${rs}"
    echo "  expected substring: ${needle}"
    echo "  output: ${out}"
  fi
}

# ===========================================================================
# I0: Podfile wiring — both phase names, the script delegation and the literal
# `archive` selector must all survive. The selector is what makes the second
# phase check the second crate; without it the phase would silently re-check
# signal twice and the archive gate would be vacuous in Xcode.
# ===========================================================================
if grep -qF "verify-rust-profile-ios.sh" "${PODFILE}" && \
   grep -qF "[Orbital] Verify Rust release profile" "${PODFILE}" && \
   grep -qF "[Orbital] Verify Rust release profile (archive)" "${PODFILE}" && \
   grep -qF 'verify-rust-profile-ios.sh" archive' "${PODFILE}"; then
  pass "I0 (Podfile wiring: both phases + archive selector)"
else
  failed "I0 (Podfile wiring): Podfile missing 'verify-rust-profile-ios.sh', a '[Orbital] Verify Rust release profile' phase name, the '(archive)' phase, or the literal 'verify-rust-profile-ios.sh\" archive' argument"
fi

# ===========================================================================
# A0: real-repo anchor — each digest script must resolve THIS checkout's crate
# ===========================================================================
anchor_case "A0 [signal]" "${DIGEST_SCRIPT}" \
  "packages/orbital-signal/rust/orbital_signal/src/lib.rs"
anchor_case "A0 [archive]" "${DIGEST_SCRIPT_ARCHIVE}" \
  "packages/orbital-archive-reader/rust/orbital_archive_reader/src/lib.rs"

# ===========================================================================
# D1/D2: the OPTIONAL selector's default must stay `signal` — ios/Podfile's
# first phase and packages/orbital-signal/package.json both call with no
# argument, so a default flipped to `archive` would leave the signal crate
# ungated while every [signal]/[archive] case below still passed.
# ===========================================================================
new_tree debug
rm -f "${T}/packages/orbital-signal/rust-profile-ios.txt"
bash "${T}/scripts/write-rust-marker-ios.sh" debug   # no $2 -> must write SIGNAL's marker
run_case "D1 (writer default \$2 writes the signal marker -> pass)" Debug "${T}" signal 0

new_tree debug
printf 'pub fn a() {}\n// edited\n' > "${T}/packages/orbital-signal/rust/orbital_signal/src/lib.rs"
run_case "D2 (verifier default \$1 gates the signal crate -> fail)" Debug "${T}" "" 1 \
  "STALE" "changed:" "packages/orbital-signal/rust/orbital_signal/src/lib.rs" "OrbitalSignal"

# ===========================================================================
# Per-crate behavioural cases — written once, run for both crates.
# ===========================================================================
for CRATE in signal archive; do
  crate_paths "${CRATE}"

  # --- Passing cases --------------------------------------------------------
  new_tree debug
  run_case "P1 [${CRATE}] (fresh Debug -> pass)" Debug "${T}" "${CRATE}" 0

  new_tree release
  run_case "P2 [${CRATE}] (fresh Release -> pass)" Release "${T}" "${CRATE}" 0

  new_tree debug
  printf 'fn t() {}\nfn t2() {}\n' > "${T}/${CP_CRATE}/tests/integration_tests.rs"
  run_case "P3 [${CRATE}] (tests/*.rs change -> pass)" Debug "${T}" "${CRATE}" 0

  new_tree debug
  printf 'pub fn a() {}\n' > "${T}/${CP_CRATE}/src/lib.rs"  # identical bytes
  touch "${T}/${CP_CRATE}/src/lib.rs"
  touch "${T}/${CP_CRATE}/Cargo.lock"
  run_case "P4 [${CRATE}] (identical-content rewrite/touch -> pass)" Debug "${T}" "${CRATE}" 0

  new_tree debug with-optional
  run_case "P5 [${CRATE}] (optional inputs present + fresh -> pass)" Debug "${T}" "${CRATE}" 0

  # --- Content-change failures ---------------------------------------------
  new_tree debug
  printf 'pub fn a() {}\n// edited\n' > "${T}/${CP_CRATE}/src/lib.rs"
  run_case "F1 [${CRATE}] (src/lib.rs content change -> fail)" Debug "${T}" "${CRATE}" 1 \
    "STALE" "changed:" "${CP_CRATE}/src/lib.rs" "${CP_REBUILD}"

  new_tree debug
  printf '[package]\nname = "%s"\nversion = "0.0.2"\n' "${CRATE}" > "${T}/${CP_CRATE}/Cargo.toml"
  run_case "F2 [${CRATE}] (Cargo.toml content change -> fail)" Debug "${T}" "${CRATE}" 1 \
    "STALE" "${CP_CRATE}/Cargo.toml"

  new_tree debug
  printf '# lock\nversion = 4\n# drift\n' > "${T}/${CP_CRATE}/Cargo.lock"
  run_case "F3 [${CRATE}] (Cargo.lock content change -> fail)" Debug "${T}" "${CRATE}" 1 \
    "STALE" "${CP_CRATE}/Cargo.lock"

  new_tree release
  printf '[toolchain]\nchannel = "1.95.0"\n' > "${T}/rust-toolchain.toml"
  run_case "F4 [${CRATE}] (rust-toolchain.toml change -> fail)" Release "${T}" "${CRATE}" 1 \
    "STALE" "rust-toolchain.toml" "${CP_REBUILD}:release"

  new_tree debug
  cat > "${T}/${CP_PKG}/ubrn.config.yaml" <<YAML
---
rust:
  directory: ./rust/$(basename "${CP_CRATE}")
ios:
  targets: []
YAML
  run_case "F5 [${CRATE}] (ubrn.config.yaml change -> fail)" Debug "${T}" "${CRATE}" 1 \
    "STALE" "${CP_PKG}/ubrn.config.yaml"

  # --- File-set-change failures --------------------------------------------
  new_tree debug
  printf 'pub fn c() {}\n' > "${T}/${CP_CRATE}/src/newmod.rs"
  run_case "F6 [${CRATE}] (added src/*.rs -> fail)" Debug "${T}" "${CRATE}" 1 \
    "STALE" "added:" "${CP_CRATE}/src/newmod.rs"

  new_tree debug
  rm -f "${T}/${CP_CRATE}/src/keys.rs"
  run_case "F7 [${CRATE}] (removed src/*.rs -> fail)" Debug "${T}" "${CRATE}" 1 \
    "STALE" "removed:" "${CP_CRATE}/src/keys.rs"

  # --- Missing-artefact failures -------------------------------------------
  new_tree debug
  rm -f "${T}/${CP_XCF}/ios-arm64/${CP_LIB}"
  run_case "F8 [${CRATE}] (missing device slice -> fail)" Debug "${T}" "${CRATE}" 1 \
    "${CP_LABEL} xcframework not found" "missing device slice" "${CP_REBUILD}"

  new_tree debug
  rm -f "${T}/${CP_XCF}/ios-arm64_x86_64-simulator/${CP_LIB}"
  run_case "F9 [${CRATE}] (missing simulator slice -> fail)" Debug "${T}" "${CRATE}" 1 \
    "${CP_LABEL} xcframework not found" "missing simulator slice" "${CP_REBUILD}"

  new_tree debug
  rm -f "${T}/${CP_PKG}/rust-profile-ios.txt"
  run_case "F10 [${CRATE}] (missing marker, Debug -> fail)" Debug "${T}" "${CRATE}" 1 \
    "marker" "${CP_PKG}/rust-profile-ios.txt" "is missing"

  new_tree debug
  printf 'debug\n' > "${T}/${CP_PKG}/rust-profile-ios.txt"
  run_case "F11 [${CRATE}] (profile-only marker, Debug -> fail)" Debug "${T}" "${CRATE}" 1 \
    "no input digest" "${CP_PKG}/rust-profile-ios.txt"

  # --- Bad-source-tree failures (digest fails closed, gate refuses to link) -
  new_tree debug
  rm -rf "${T}/${CP_CRATE}/src"
  run_case "F12 [${CRATE}] (missing src dir -> fail)" Debug "${T}" "${CRATE}" 1 \
    "crate source dir not found" "Refusing to link an unverified ${CP_LABEL}"

  new_tree debug
  rm -f "${T}/${CP_CRATE}/src"/*.rs
  run_case "F13 [${CRATE}] (src with zero *.rs -> fail)" Debug "${T}" "${CRATE}" 1 \
    "no *.rs files" "Refusing to link an unverified ${CP_LABEL}"

  # --- Profile failure ------------------------------------------------------
  new_tree debug
  run_case "F14 [${CRATE}] (Release + debug marker -> fail)" Release "${T}" "${CRATE}" 1 \
    "${CP_LABEL} xcframework was built with Rust profile 'debug', not 'release'" \
    "${CP_REBUILD}:release"

  # --- package.json + optional inputs (PR #859 review) ---------------------
  new_tree debug
  printf '{\n  "name": "%s",\n  "dependencies": { "uniffi-bindgen-react-native": "0.32.0" }\n}\n' \
    "$(basename "${CP_PKG}")" > "${T}/${CP_PKG}/package.json"
  run_case "F15 [${CRATE}] (package.json change -> fail)" Debug "${T}" "${CRATE}" 1 \
    "STALE" "${CP_PKG}/package.json"

  new_tree debug with-optional
  printf 'fn main() { println!("changed"); }\n' > "${T}/${CP_CRATE}/build.rs"
  run_case "F16 [${CRATE}] (build.rs change -> fail)" Debug "${T}" "${CRATE}" 1 \
    "STALE" "${CP_CRATE}/build.rs"

  new_tree debug with-optional
  printf '[build]\nrustflags = ["-C", "target-cpu=native"]\n' > "${T}/${CP_CRATE}/.cargo/config.toml"
  run_case "F17 [${CRATE}] (.cargo/config.toml change -> fail)" Debug "${T}" "${CRATE}" 1 \
    "STALE" "${CP_CRATE}/.cargo/config.toml"

  new_tree debug
  printf 'fn main() {}\n' > "${T}/${CP_CRATE}/build.rs"
  run_case "F18 [${CRATE}] (optional build.rs appears -> fail)" Debug "${T}" "${CRATE}" 1 \
    "STALE" "added:" "${CP_CRATE}/build.rs"
done

# ===========================================================================
# F19: unknown selector — the verifier must refuse rather than fall back to a
# crate. exit 2 (usage), distinct from the gate's own exit 1.
# ===========================================================================
new_tree debug
run_case "F19 (unknown crate selector -> exit 2)" Debug "${T}" bogus 2 \
  "unknown crate selector" "bogus"

# ===========================================================================
# F20/F21: CROSS-CRATE ISOLATION. The two gates must not bleed into each
# other: one stale crate must fail its own phase and leave the other's alone.
# A shared marker path, a shared digest script or a copy-paste of the wrong
# PKG_DIR in the verifier's `case` all show up here and nowhere else.
# ===========================================================================
new_tree debug
crate_paths archive
printf 'pub fn a() {}\n// archive-only edit\n' > "${T}/${CP_CRATE}/src/lib.rs"
ISO_ARCHIVE_PATH="${CP_CRATE}/src/lib.rs"
run_case "F20a (only archive tampered -> signal verify passes)" Debug "${T}" signal 0
run_case "F20b (only archive tampered -> archive verify fails)" Debug "${T}" archive 1 \
  "STALE" "changed:" "${ISO_ARCHIVE_PATH}" "OrbitalArchiveReader"

new_tree debug
crate_paths signal
printf 'pub fn a() {}\n// signal-only edit\n' > "${T}/${CP_CRATE}/src/lib.rs"
ISO_SIGNAL_PATH="${CP_CRATE}/src/lib.rs"
run_case "F21a (only signal tampered -> archive verify passes)" Debug "${T}" archive 0
run_case "F21b (only signal tampered -> signal verify fails)" Debug "${T}" signal 1 \
  "STALE" "changed:" "${ISO_SIGNAL_PATH}" "OrbitalSignal"

echo ""
echo "iOS gate results: ${PASS} passed, ${FAIL} failed"
if [ "${FAIL}" -gt 0 ]; then
  exit 1
fi
