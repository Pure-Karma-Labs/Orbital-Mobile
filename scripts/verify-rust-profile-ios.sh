#!/usr/bin/env bash
# Invoked by the Podfile script_phase '[Orbital] Verify Rust release profile';
# unit-tested by scripts/test-rust-profile-gate-ios.sh (#550, #813).
#
# The filename and the Xcode phase name are historical (#541/#550, when the
# only check was the cargo profile) and are deliberately retained so this
# change needs no ios/Podfile or project.pbxproj churn. Since #813 the script
# also gates STALENESS, on every configuration, not just Release.
#
# Checks, in order:
#   1. Both xcframework slices hold liborbital_signal.a.
#   2. packages/orbital-signal/rust-profile-ios.txt exists AND carries digest
#      lines (an old/raw `npx ubrn build ios` writes a profile-only marker).
#   3. Release only: the marker's profile line must be `release`.
#   4. All configurations: the recomputed input digest must equal the marker's,
#      and a mismatch names the changed / added / removed paths.
#
# Freshness is CONTENT-addressed (sha256 of the Rust inputs via
# scripts/rust-input-digest.sh), not mtime-based like Android's
# check-rust-freshness.gradle. Consequences, both deliberate:
#   - a `touch`, or a branch switch that restores identical content, no longer
#     trips the gate;
#   - there is NO escape hatch. Unlike Android's `orbital.autoRebuildRust`,
#     iOS always fails closed and tells you which command to run. Hand-editing
#     the marker still defeats it: this is a developer safety net against
#     linking stale crypto, not a security boundary.
#
# Paths are derived from this script's own location so the check works both
# from Xcode (SRCROOT-relative) and from the test harness's fake tree.
# CONFIGURATION is read with ${CONFIGURATION:-} (set -u safe: unset passes as
# a non-Release build). Bash 3.2 compatible; pipe-free status checks (#790).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG_DIR="${REPO_ROOT}/packages/orbital-signal"
MARKER="${PKG_DIR}/rust-profile-ios.txt"
DIGEST_SCRIPT="${REPO_ROOT}/scripts/rust-input-digest.sh"
XCFRAMEWORK="${PKG_DIR}/OrbitalSignalFramework.xcframework"
DEVICE_LIB="${XCFRAMEWORK}/ios-arm64/liborbital_signal.a"
SIM_LIB="${XCFRAMEWORK}/ios-arm64_x86_64-simulator/liborbital_signal.a"

CONFIG="${CONFIGURATION:-}"

# --- 1. Artefacts present ---------------------------------------------------
if [ ! -f "${DEVICE_LIB}" ] || [ ! -f "${SIM_LIB}" ]; then
  echo "error: OrbitalSignal xcframework not found. Run: npm run build:rust:ios[:release]"
  if [ ! -f "${DEVICE_LIB}" ]; then echo "note: missing device slice ${DEVICE_LIB}"; fi
  if [ ! -f "${SIM_LIB}" ]; then echo "note: missing simulator slice ${SIM_LIB}"; fi
  exit 1
fi

# --- 2. Marker present and in the digest format -----------------------------
if [ ! -f "${MARKER}" ]; then
  echo "error: Rust provenance marker ${MARKER} is missing. The xcframework was built by an old/raw ubrn invocation, or an interrupted build removed it — rebuild via npm: npm run build:rust:ios[:release]"
  exit 1
fi

MARKER_BODY=""
if ! MARKER_BODY="$(cat "${MARKER}")"; then
  echo "error: could not read Rust provenance marker ${MARKER} — rebuild via npm: npm run build:rust:ios[:release]"
  exit 1
fi

# Split on the first newline with bash parameter expansion rather than
# head/tail, so no pipeline status can be swallowed (#790).
PROFILE="${MARKER_BODY%%$'\n'*}"
PROFILE="${PROFILE//[[:space:]]/}"
if [ "${MARKER_BODY}" = "${PROFILE}" ] || [ "${MARKER_BODY}" = "${MARKER_BODY%%$'\n'*}" ]; then
  MARKER_DIGEST=""
else
  MARKER_DIGEST="${MARKER_BODY#*$'\n'}"
fi

if [ -z "${MARKER_DIGEST//[[:space:]]/}" ]; then
  echo "error: Rust provenance marker ${MARKER} holds a profile but no input digest. The xcframework was built by an old/raw ubrn invocation — rebuild via npm: npm run build:rust:ios[:release]"
  exit 1
fi

# Rebuild hint matching the marker's own profile.
if [ "${PROFILE}" = "release" ]; then
  REBUILD_CMD="npm run build:rust:ios:release"
else
  REBUILD_CMD="npm run build:rust:ios"
fi

# --- 3. Release builds require release-profile Rust -------------------------
if [ "${CONFIG}" = "Release" ] && [ "${PROFILE}" != "release" ]; then
  echo "error: OrbitalSignal xcframework was built with Rust profile '${PROFILE}', not 'release'. Run: npm run build:rust:ios:release"
  exit 1
fi

# --- 4. Content freshness, every configuration ------------------------------
CURRENT_DIGEST=""
if ! CURRENT_DIGEST="$(bash "${DIGEST_SCRIPT}")"; then
  echo "error: could not compute the Rust input digest (see rust-input-digest errors above). Refusing to link an unverified OrbitalSignal xcframework."
  exit 1
fi

if [ "${CURRENT_DIGEST}" = "${MARKER_DIGEST}" ]; then
  exit 0
fi

# Mismatch: diff the two path->hash maps and name what moved. O(n^2) over ~20
# inputs. Paths carry no spaces, and shasum hashes are hex, so splitting each
# line on its first double space is safe.
CHANGED=""
ADDED=""
REMOVED=""

while IFS= read -r cur_line; do
  [ -n "${cur_line}" ] || continue
  cur_path="${cur_line#*  }"
  match=""
  while IFS= read -r mk_line; do
    [ -n "${mk_line}" ] || continue
    if [ "${mk_line#*  }" = "${cur_path}" ]; then
      match="${mk_line}"
      break
    fi
  done <<<"${MARKER_DIGEST}"
  if [ -z "${match}" ]; then
    ADDED="${ADDED}    added:   ${cur_path}
"
  elif [ "${match}" != "${cur_line}" ]; then
    CHANGED="${CHANGED}    changed: ${cur_path}
"
  fi
done <<<"${CURRENT_DIGEST}"

while IFS= read -r mk_line; do
  [ -n "${mk_line}" ] || continue
  mk_path="${mk_line#*  }"
  match=""
  while IFS= read -r cur_line; do
    [ -n "${cur_line}" ] || continue
    if [ "${cur_line#*  }" = "${mk_path}" ]; then
      match="${cur_line}"
      break
    fi
  done <<<"${CURRENT_DIGEST}"
  if [ -z "${match}" ]; then
    REMOVED="${REMOVED}    removed: ${mk_path}
"
  fi
done <<<"${MARKER_DIGEST}"

echo "error: OrbitalSignal xcframework is STALE — Rust inputs changed since it was built (profile '${PROFILE}')."
if [ -n "${CHANGED}" ]; then printf '%s' "${CHANGED}"; fi
if [ -n "${ADDED}" ]; then printf '%s' "${ADDED}"; fi
if [ -n "${REMOVED}" ]; then printf '%s' "${REMOVED}"; fi
if [ -z "${CHANGED}${ADDED}${REMOVED}" ]; then
  echo "    (digest text differs but no per-path delta resolved — the marker is malformed)"
fi
echo "Run: ${REBUILD_CMD}"
exit 1
