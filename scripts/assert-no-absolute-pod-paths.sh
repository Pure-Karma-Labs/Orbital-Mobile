#!/usr/bin/env bash
# Assert no absolute, machine-specific paths leaked into the pod graph (issue #767).
# Pairs with the Podfile guard added in #768.
#
# MECHANICS (verified in node_modules/@sentry/react-native 8.22.0):
# In xcframework mode, RNSentry.podspec calls ensure_sentry_xcframework (downloads
# Sentry.xcframework.zip into ~/Library/Caches/sentry-react-native/xcframeworks/<ver>/;
# SHA256 verified on FIRST download only — sentry_utils.rb:116 returns early when
# Info.plist exists) then stage_sentry_xcframework_in_pods (symlinks
# Pods/sentry-xcframeworks/<ver>/Sentry.xcframework into the cache; returns
# "$(PODS_ROOT)/..."). On nil return (outside a real install, or ANY exception,
# reported only via Pod::UI.warn) the absolute $HOME cache path is interpolated into
# per-SDK FRAMEWORK_SEARCH_PATHS in both pod_target_xcconfig and user_target_xcconfig,
# landing in Pods/Local Podspecs/RNSentry.podspec.json (-> $HOME-dependent RNSentry
# SPEC CHECKSUM in Podfile.lock), the RNSentry xcconfigs, AND the aggregate
# Pods-OrbitalMobile.{debug,release}.xcconfig.
#
# WHY NOT BARE '/Library/':
# hermes-engine legitimately uses ${PODS_ROOT}/hermes-engine/destroot/Library/Frameworks/universal
# in FRAMEWORK_SEARCH_PATHS, so bare '/Library/' would produce a false positive on
# every clean install.
#
# WHY NOT '\|' IN THE ERE PATTERN:
# BSD grep (macOS) treats '\|' as a literal two-character sequence, not alternation.
# ERE alternation is plain '|'. Using '\|' would silently skip the second and third
# clauses, causing the assertion to never fire for /Library/Caches/ or the
# FRAMEWORK_SEARCH_PATHS clause.
#
# WHY FIVE FILES ARE REQUIRED:
# A vacuous pass (e.g. pod install failed silently leaving no xcconfigs, or the
# Pods/ dir doesn't exist) would be invisible without an explicit non-vacuity check.
# The five required files are what a successful pod install always produces:
# RNSentry.podspec.json and the four target xcconfigs. Missing any of them on a
# success outcome means either pod install failed or CocoaPods moved its output paths.
#
# Usage: bash scripts/assert-no-absolute-pod-paths.sh [PODS_DIR]
#   PODS_DIR defaults to <repo>/ios/Pods
#   POD_INSTALL_OUTCOME env (default "success"): set to "failure" to skip xcconfig checks

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PODS_DIR="${1:-${REPO_ROOT}/ios/Pods}"
OUTCOME="${POD_INSTALL_OUTCOME:-success}"

# ERE. Never '\|' (BSD grep -E reads it as a literal). Never bare '/Library/'
# (hermes-engine: "${PODS_ROOT}/hermes-engine/destroot/Library/Frameworks/universal").
# Third clause: any quoted absolute path in a FRAMEWORK_SEARCH_PATHS value,
# xcconfig form ("/...) or podspec-JSON form (\"/...).
PATTERN='/Users/|/Library/Caches/|FRAMEWORK_SEARCH_PATHS.*\\?"/'

PODSPEC="${PODS_DIR}/Local Podspecs/RNSentry.podspec.json"
REQUIRED_XCCONFIGS=(
  "${PODS_DIR}/Target Support Files/RNSentry/RNSentry.debug.xcconfig"
  "${PODS_DIR}/Target Support Files/RNSentry/RNSentry.release.xcconfig"
  "${PODS_DIR}/Target Support Files/Pods-OrbitalMobile/Pods-OrbitalMobile.debug.xcconfig"
  "${PODS_DIR}/Target Support Files/Pods-OrbitalMobile/Pods-OrbitalMobile.release.xcconfig"
)

fail() { echo "ERROR: $1 (#767)"; shift; printf '%s\n' "$@"; exit 1; }

[ -f "$PODSPEC" ] || fail "$PODSPEC not found" \
  "pod install writes it while fetching :path sources, so either pod install died before" \
  "that point (see the step above) or CocoaPods moved 'Local Podspecs'."

# Non-vacuity is carried by the required-file checks above and below: the
# RNSentry podspec JSON guarantees at least one JSON, and the four required
# xcconfigs guarantee at least four xcconfigs, so no separate count guard is needed.
FILES=()
while IFS= read -r -d '' f; do FILES+=("$f"); done < <(find "${PODS_DIR}/Local Podspecs" -name '*.json' -print0)

if [ "$OUTCOME" = "success" ]; then
  for f in "${REQUIRED_XCCONFIGS[@]}"; do
    [ -f "$f" ] || fail "$f not found after a successful pod install" \
      "Check the path against ios/Pods/Target Support Files/ -- this assertion must not pass vacuously."
  done
  while IFS= read -r -d '' f; do FILES+=("$f"); done < <(find "${PODS_DIR}/Target Support Files" -name '*.xcconfig' -print0)
else
  echo "pod install outcome=${OUTCOME}; checking podspec JSON only (xcconfigs are not generated)."
fi

# grep status is handled explicitly so the gate can never fail OPEN: 0 = a
# match (leak), 1 = clean, >=2 = grep itself failed (unreadable file, broken
# symlink -- exactly what a dangling Pods/sentry-xcframeworks link looks like).
set +e
MATCHES=$(grep -nE "$PATTERN" "${FILES[@]}" 2>&1)
RC=$?
set -e
if [ "$RC" -eq 0 ]; then
  printf '%s\n' "$MATCHES"
  fail "a pod leaked an absolute, machine-specific path into the pod graph" \
    "For RNSentry: stage_sentry_xcframework_in_pods returned nil, so RNSentry.podspec fell back" \
    "to the \$HOME cache path (~/Library/Caches/sentry-react-native) for FRAMEWORK_SEARCH_PATHS." \
    "That leaks into the RNSentry SPEC CHECKSUM in Podfile.lock and the generated xcconfigs." \
    "Look for a '[Sentry] Could not link' warning in the pod install output above."
elif [ "$RC" -ne 1 ]; then
  printf '%s\n' "$MATCHES"
  fail "grep exited $RC while scanning the pod graph -- refusing to pass on an error" \
    "A file under Pods/ could not be read (a broken symlink, e.g. Pods/sentry-xcframeworks/<ver>" \
    "pointing at a cache dir that does not exist on this machine). Fix the install; do not ignore."
fi
echo "OK: no absolute paths in ${#FILES[@]} podspec JSON / xcconfig files under ${PODS_DIR}."
