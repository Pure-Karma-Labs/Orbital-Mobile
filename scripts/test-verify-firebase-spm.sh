#!/usr/bin/env bash
# Fixture harness for scripts/verify-firebase-spm.rb (issue #769).
# Run from repo root: bash scripts/test-verify-firebase-spm.sh
#   or via: npm run test:firebase-spm
#
# Tests:
#   F1   Good pbxproj + good Package.resolved                                  → exit 0
#   F2   Zero XCRemoteSwiftPackageReference entries                             → exit 1
#   F3   Two XCRemoteSwiftPackageReference entries                              → exit 1
#   F4   upToNextMajorVersion requirement (not exactVersion)                    → exit 1
#   F5   pbxproj version 12.19.2 (not 12.18.0)                                 → exit 1
#   F6   Wrong URL in pbxproj                                                   → exit 1
#   F7   FirebaseCore XCSwiftPackageProductDependency absent                    → exit 1
#   F8   Package.resolved absent                                                → exit 1
#   F9   Package.resolved firebase-ios-sdk version != expected                  → exit 1
#   F10  A pin location on gitlab.com (not github.com)                         → exit 1
#   F11  --bootstrap + zero references + absent Package.resolved               → exit 0 (2 warnings)
#   F12  --bootstrap + wrong URL in pbxproj                                    → exit 1
#   F13  Full probe pbxproj (if exists at the expected path)                   → exit 0 (optional)
#
# This harness never touches ios/ or any real repo file.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="${REPO_ROOT}/scripts/verify-firebase-spm.rb"
FIXTURE_DIR="${REPO_ROOT}/scripts/fixtures/firebase-spm"
GOOD_PBXPROJ="${FIXTURE_DIR}/good.pbxproj"
GOOD_RESOLVED="${FIXTURE_DIR}/good.Package.resolved"

# The ruby binary to use (allow override via RUBY env for the Homebrew test)
RUBY_BIN="${RUBY:-ruby}"

EXPECTED_URL="https://github.com/firebase/firebase-ios-sdk.git"
EXPECTED_VER="12.18.0"
APP_TARGET="OrbitalMobile"

PASS=0
FAIL=0

TMPDIR_BASE=$(mktemp -d)
cleanup() { rm -rf "$TMPDIR_BASE"; }
trap cleanup EXIT

run_test() {
  local label="$1"
  local expected_exit="$2"
  shift 2
  local output exit_code
  set +e
  output=$("$@" 2>&1)
  exit_code=$?
  set -e
  if [ "${exit_code}" -eq "${expected_exit}" ]; then
    echo "PASS ${label}"
    PASS=$((PASS + 1))
  else
    echo "FAIL ${label}: exit=${exit_code} (expected ${expected_exit})"
    echo "  output: ${output}"
    FAIL=$((FAIL + 1))
  fi
}

base_args=(
  "$RUBY_BIN" "$SCRIPT"
  --expected-url "$EXPECTED_URL"
  --expected-version "$EXPECTED_VER"
  --app-target "$APP_TARGET"
)

# ---------------------------------------------------------------------------
# F1: Good fixtures → exit 0
# ---------------------------------------------------------------------------
run_test F1 0 \
  "${base_args[@]}" \
  --pbxproj "$GOOD_PBXPROJ" \
  --resolved "$GOOD_RESOLVED"

# ---------------------------------------------------------------------------
# F2: Zero XCRemoteSwiftPackageReference → exit 1
# ---------------------------------------------------------------------------
T="${TMPDIR_BASE}/f2"; mkdir -p "$T"
sed '/XCRemoteSwiftPackageReference/d' "$GOOD_PBXPROJ" > "$T/f2.pbxproj"
# Also remove the isa line so no SPM block remains
python3 -c "
import re, sys
content = open('$T/f2.pbxproj').read()
# Remove the entire XCRemoteSwiftPackageReference object
content = re.sub(r'\t\t[0-9A-F]{24} /\* XCRemoteSwiftPackageReference.*?\*/.*?;[\r\n]', '', content, flags=re.DOTALL)
open('$T/f2.pbxproj','w').write(content)
"
run_test F2 1 \
  "${base_args[@]}" \
  --pbxproj "$T/f2.pbxproj" \
  --resolved "$GOOD_RESOLVED"

# ---------------------------------------------------------------------------
# F3: Two XCRemoteSwiftPackageReference entries → exit 1
# ---------------------------------------------------------------------------
T="${TMPDIR_BASE}/f3"; mkdir -p "$T"
# Duplicate the XCRemoteSwiftPackageReference section
python3 -c "
content = open('$GOOD_PBXPROJ').read()
extra = '''
\t\tAABBCCDD00112233AABBCCDD /* XCRemoteSwiftPackageReference \"other-sdk\" */ = {
\t\t\tisa = XCRemoteSwiftPackageReference;
\t\t\trepositoryURL = \"https://github.com/other/other-sdk.git\";
\t\t\trequirement = {
\t\t\t\tkind = exactVersion;
\t\t\t\tversion = 1.0.0;
\t\t\t};
\t\t};'''
content = content.replace('/* End XCRemoteSwiftPackageReference section */', extra + '\n/* End XCRemoteSwiftPackageReference section */')
open('$T/f3.pbxproj','w').write(content)
"
run_test F3 1 \
  "${base_args[@]}" \
  --pbxproj "$T/f3.pbxproj" \
  --resolved "$GOOD_RESOLVED"

# ---------------------------------------------------------------------------
# F4: upToNextMajorVersion (not exactVersion) → exit 1
# ---------------------------------------------------------------------------
T="${TMPDIR_BASE}/f4"; mkdir -p "$T"
sed 's/kind = exactVersion;/kind = upToNextMajorVersion;/' "$GOOD_PBXPROJ" > "$T/f4.pbxproj"
run_test F4 1 \
  "${base_args[@]}" \
  --pbxproj "$T/f4.pbxproj" \
  --resolved "$GOOD_RESOLVED"

# ---------------------------------------------------------------------------
# F5: version 12.19.2 in pbxproj → exit 1
# ---------------------------------------------------------------------------
T="${TMPDIR_BASE}/f5"; mkdir -p "$T"
sed 's/version = 12.18.0;/version = 12.19.2;/' "$GOOD_PBXPROJ" > "$T/f5.pbxproj"
run_test F5 1 \
  "${base_args[@]}" \
  --pbxproj "$T/f5.pbxproj" \
  --resolved "$GOOD_RESOLVED"

# ---------------------------------------------------------------------------
# F6: Wrong URL in pbxproj → exit 1
# ---------------------------------------------------------------------------
T="${TMPDIR_BASE}/f6"; mkdir -p "$T"
sed 's|https://github.com/firebase/firebase-ios-sdk.git|https://github.com/attacker/firebase-ios-sdk.git|' "$GOOD_PBXPROJ" > "$T/f6.pbxproj"
run_test F6 1 \
  "${base_args[@]}" \
  --pbxproj "$T/f6.pbxproj" \
  --resolved "$GOOD_RESOLVED"

# ---------------------------------------------------------------------------
# F7: Missing FirebaseCore XCSwiftPackageProductDependency → exit 1
# ---------------------------------------------------------------------------
T="${TMPDIR_BASE}/f7"; mkdir -p "$T"
python3 -c "
content = open('$GOOD_PBXPROJ').read()
# Remove the XCSwiftPackageProductDependency section entirely
import re
content = re.sub(r'/\* Begin XCSwiftPackageProductDependency section \*/.*?/\* End XCSwiftPackageProductDependency section \*/', '', content, flags=re.DOTALL)
# Also remove the productRef PBXBuildFile line
content = re.sub(r'.*productRef = B93B4D599DF94549D6E65E93.*\n', '', content)
# Remove from packageProductDependencies
content = re.sub(r'\s*B93B4D599DF94549D6E65E93 /\* FirebaseCore \*/,\n', '\n', content)
open('$T/f7.pbxproj','w').write(content)
"
run_test F7 1 \
  "${base_args[@]}" \
  --pbxproj "$T/f7.pbxproj" \
  --resolved "$GOOD_RESOLVED"

# ---------------------------------------------------------------------------
# F8: Package.resolved absent → exit 1
# ---------------------------------------------------------------------------
T="${TMPDIR_BASE}/f8"; mkdir -p "$T"
# Just point resolved at a non-existent path
run_test F8 1 \
  "${base_args[@]}" \
  --pbxproj "$GOOD_PBXPROJ" \
  --resolved "$T/no-such-file.json"

# ---------------------------------------------------------------------------
# F9: Package.resolved firebase version != expected → exit 1
# ---------------------------------------------------------------------------
T="${TMPDIR_BASE}/f9"; mkdir -p "$T"
python3 -c "
import json
data = json.load(open('$GOOD_RESOLVED'))
for p in data['pins']:
    if p['identity'] == 'firebase-ios-sdk':
        p['state']['version'] = '12.19.2'
json.dump(data, open('$T/f9.resolved','w'), indent=2)
"
run_test F9 1 \
  "${base_args[@]}" \
  --pbxproj "$GOOD_PBXPROJ" \
  --resolved "$T/f9.resolved"

# ---------------------------------------------------------------------------
# F10: A pin location on gitlab.com → exit 1
# ---------------------------------------------------------------------------
T="${TMPDIR_BASE}/f10"; mkdir -p "$T"
python3 -c "
import json
data = json.load(open('$GOOD_RESOLVED'))
data['pins'][0]['location'] = 'https://gitlab.com/evil/package.git'
json.dump(data, open('$T/f10.resolved','w'), indent=2)
"
run_test F10 1 \
  "${base_args[@]}" \
  --pbxproj "$GOOD_PBXPROJ" \
  --resolved "$T/f10.resolved"

# ---------------------------------------------------------------------------
# F11: --bootstrap + zero references + absent Package.resolved → exit 0 (warnings)
# ---------------------------------------------------------------------------
T="${TMPDIR_BASE}/f11"; mkdir -p "$T"
# Create a pbxproj with no XCRemoteSwiftPackageReference
python3 -c "
import re
content = open('$GOOD_PBXPROJ').read()
content = re.sub(r'/\* Begin XCRemoteSwiftPackageReference section \*/.*?/\* End XCRemoteSwiftPackageReference section \*/', '', content, flags=re.DOTALL)
content = re.sub(r'/\* Begin XCSwiftPackageProductDependency section \*/.*?/\* End XCSwiftPackageProductDependency section \*/', '', content, flags=re.DOTALL)
content = re.sub(r'\s*B93B4D599DF94549D6E65E93 /\* FirebaseCore \*/,\n', '\n', content)
content = re.sub(r'.*productRef = B93B4D599DF94549D6E65E93.*\n', '', content)
open('$T/f11.pbxproj','w').write(content)
"
run_test F11 0 \
  "${base_args[@]}" \
  --pbxproj "$T/f11.pbxproj" \
  --resolved "$T/no-such-file.json" \
  --bootstrap

# ---------------------------------------------------------------------------
# F12: --bootstrap + wrong URL in pbxproj → exit 1 (URL check is never bootstrap-tolerant)
# ---------------------------------------------------------------------------
T="${TMPDIR_BASE}/f12"; mkdir -p "$T"
sed 's|https://github.com/firebase/firebase-ios-sdk.git|https://github.com/attacker/firebase-ios-sdk.git|' "$GOOD_PBXPROJ" > "$T/f12.pbxproj"
run_test F12 1 \
  "${base_args[@]}" \
  --pbxproj "$T/f12.pbxproj" \
  --resolved "$GOOD_RESOLVED" \
  --bootstrap

# ---------------------------------------------------------------------------
# F13: Full probe pbxproj (optional — skipped if probe path does not exist)
# ---------------------------------------------------------------------------
PROBE_PBXPROJ="/private/tmp/claude-501/-Users-alexg-Documents-GitHub-Orbital/2d2c4b96-2a5a-41f5-98ca-9cf8f9a60950/scratchpad/probe-769/ios/OrbitalMobile.xcodeproj/project.pbxproj"
PROBE_RESOLVED="/private/tmp/claude-501/-Users-alexg-Documents-GitHub-Orbital/2d2c4b96-2a5a-41f5-98ca-9cf8f9a60950/scratchpad/probe-769/ios/OrbitalMobile.xcworkspace/xcshareddata/swiftpm/Package.resolved"
if [ -f "$PROBE_PBXPROJ" ] && [ -f "$PROBE_RESOLVED" ]; then
  run_test "F13 (full probe pbxproj)" 0 \
    "${base_args[@]}" \
    --pbxproj "$PROBE_PBXPROJ" \
    --resolved "$PROBE_RESOLVED"
else
  echo "SKIP F13 (probe pbxproj not present at expected path)"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
TOTAL=$((PASS + FAIL))
echo ""
echo "Results: ${PASS}/${TOTAL} passed, ${FAIL} failed"
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
exit 0
