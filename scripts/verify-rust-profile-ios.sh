#!/usr/bin/env bash
# Invoked by the Podfile script_phase '[Orbital] Verify Rust release profile';
# unit-tested by scripts/test-rust-profile-gate-ios.sh (#550).
#
# Active only for Release builds (including Product > Archive). Reads
# packages/orbital-signal/rust-profile-ios.txt to verify the xcframework was
# compiled with the release cargo profile; fails the Xcode build if not.
#
# Marker path is derived from this script's own location so the check works
# both from Xcode (SRCROOT-relative) and from the test harness (repo-relative).
# CONFIGURATION is read with ${CONFIGURATION:-} (set -u safe: unset env passes).

set -u

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MARKER="${REPO_ROOT}/packages/orbital-signal/rust-profile-ios.txt"

# Only gate Release builds; Debug/Simulator builds may use debug-profile Rust.
if [ "${CONFIGURATION:-}" != "Release" ]; then
  exit 0
fi

PROFILE=$(cat "${MARKER}" 2>/dev/null || echo missing)
if [ "${PROFILE}" != "release" ]; then
  echo "error: OrbitalSignal xcframework was built with Rust profile '${PROFILE}', not 'release'. Run: npm run build:rust:ios:release"
  exit 1
fi
