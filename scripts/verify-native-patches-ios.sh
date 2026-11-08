#!/usr/bin/env bash
# Invoked by the Podfile script_phase '[Orbital] Verify native patches' (#971).
#
# Gates the INSTALLED tree, which is the half no tracked-content check can see.
# scripts/check-security-invariants.mjs rule 28 proves the patch is committed
# and well formed; build.yml re-checks it after `npm ci`; this phase is what
# covers a build driven from Xcode.app — including Product > Archive, where no
# npm or CI step runs and a stale node_modules would otherwise ship the
# unpatched picker.
#
# What goes wrong without it: react-native-image-picker 8.2.1 calls one JS
# callback twice and RCTTurboModule aborts the process (Sentry
# ORBITAL-MOBILE-R). patches/react-native-image-picker+8.2.1.patch fixes that by
# giving every launch its own callback context; patch-package applies it from
# the root `postinstall`. If someone installs with --ignore-scripts, hand-edits
# node_modules, or restores an older node_modules, the app compiles and crashes
# at runtime. Two checks, mirroring rule 28's installed-tree equivalents:
#
#   1. The marker ORBITAL-PATCH(#971) is present  -> the patch was applied.
#   2. No raw `self.callback(` call remains       -> it is the CURRENT patch,
#      not an older one: every upstream double-call site read that shared
#      property, and the patch removes all ten.
#
# Paths derive from this script's own location, so the check works from Xcode
# (where SRCROOT is ios/) and from a plain shell. Status checks use
# `grep -q PATTERN FILE` with no pipeline, per security invariant rule 16
# (#790): a `| grep -q` would swallow the reader's exit status. -F because both
# patterns contain regex metacharacters.
#
# Unlike the Rust gate this runs on every configuration and has no escape
# hatch. If it fires, run `npm ci` (or `npm install`) to re-apply the patch.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PICKER_MM="${REPO_ROOT}/node_modules/react-native-image-picker/ios/ImagePickerManager.mm"
PATCH_MARKER='ORBITAL-PATCH(#971)'
BANNED_CALL='self.callback('

if [ ! -f "${PICKER_MM}" ]; then
  echo "error: ${PICKER_MM} not found — react-native-image-picker is not installed, so the #971 double-callback patch cannot be verified. Run: npm ci"
  exit 1
fi

if ! grep -qF "${PATCH_MARKER}" "${PICKER_MM}"; then
  echo "error: the installed react-native-image-picker carries no ${PATCH_MARKER} marker — patches/react-native-image-picker+8.2.1.patch was NOT applied, so this build would ship the double-callback abort (#971). Re-install so the postinstall runs: npm ci"
  exit 1
fi

if grep -qF "${BANNED_CALL}" "${PICKER_MM}"; then
  echo "error: the installed react-native-image-picker still calls back through the shared \`${BANNED_CALL}\` property — node_modules holds a partially applied or outdated patch (#971). Re-install so the postinstall runs: npm ci"
  exit 1
fi

exit 0
