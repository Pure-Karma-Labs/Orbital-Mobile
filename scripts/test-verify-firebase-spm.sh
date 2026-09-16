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
#   F13  Committed ios/ pbxproj + Package.resolved (fixture-drift check)        → exit 0
#   F14  Package.resolved pin under a github.com org outside the allow-list   → exit 1
#   F15  Package.resolved pin with a non-40-hex revision                      → exit 1
#   F16  Package.resolved format version 2                                     → exit 1
#   F17  Second package reference with a lowercase-hex object id               → exit 1
#   F18  Pin location with path traversal (google/../../evil)                  → exit 1
#   F19  mirrors.json in the workspace swiftpm/configuration dir              → exit 1
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
# Deleting every line that names the class removes the object header, its isa
# line and the packageReferences entry; the orphaned requirement lines that
# remain carry no isa, so the verifier sees zero references.
sed '/XCRemoteSwiftPackageReference/d' "$GOOD_PBXPROJ" > "$T/f2.pbxproj"
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
# F13: The committed real project + Package.resolved (fixture-drift check).
# good.pbxproj is an excerpt of ios/OrbitalMobile.xcodeproj/project.pbxproj; this
# case proves the verifier's regexes give the same answer on the full generated
# file. Skipped only when the harness runs outside the repo (no ios/ present).
# ---------------------------------------------------------------------------
REAL_PBXPROJ="${REPO_ROOT}/ios/OrbitalMobile.xcodeproj/project.pbxproj"
REAL_RESOLVED="${REPO_ROOT}/ios/OrbitalMobile.xcworkspace/xcshareddata/swiftpm/Package.resolved"
if [ -f "$REAL_PBXPROJ" ] && [ -f "$REAL_RESOLVED" ]; then
  run_test "F13 (committed pbxproj + Package.resolved)" 0 \
    "${base_args[@]}" \
    --pbxproj "$REAL_PBXPROJ" \
    --resolved "$REAL_RESOLVED"
else
  echo "SKIP F13 (ios/ not present — harness running outside the repo)"
fi

# ---------------------------------------------------------------------------
# F14: github.com location under an org outside the allow-list → exit 1
# ---------------------------------------------------------------------------
T="${TMPDIR_BASE}/f14"; mkdir -p "$T"
sed 's#https://github.com/google/promises.git#https://github.com/notallowed/promises.git#' "$GOOD_RESOLVED" > "$T/f14.Package.resolved"
grep -q 'github.com/notallowed/' "$T/f14.Package.resolved" || { echo "FAIL F14 fixture: substitution did not apply"; FAIL=$((FAIL + 1)); }
run_test F14 1 \
  "${base_args[@]}" \
  --pbxproj "$GOOD_PBXPROJ" \
  --resolved "$T/f14.Package.resolved"

# ---------------------------------------------------------------------------
# F15: a pin whose revision is not a 40-hex commit SHA → exit 1
# ---------------------------------------------------------------------------
T="${TMPDIR_BASE}/f15"; mkdir -p "$T"
python3 -c "
import json
d = json.load(open('$GOOD_RESOLVED'))
d['pins'][0]['state']['revision'] = 'deadbeef'
json.dump(d, open('$T/f15.Package.resolved', 'w'), indent=2)
"
run_test F15 1 \
  "${base_args[@]}" \
  --pbxproj "$GOOD_PBXPROJ" \
  --resolved "$T/f15.Package.resolved"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
TOTAL=$((PASS + FAIL))
# ---------------------------------------------------------------------------
# F16: Package.resolved format version 2 → exit 1
# ---------------------------------------------------------------------------
T="${TMPDIR_BASE}/f16"; mkdir -p "$T"
python3 -c "
import json
d = json.load(open('$GOOD_RESOLVED')); d['version'] = 2
json.dump(d, open('$T/f16.Package.resolved', 'w'), indent=2)
"
run_test F16 1 \
  "${base_args[@]}" \
  --pbxproj "$GOOD_PBXPROJ" \
  --resolved "$T/f16.Package.resolved"

# ---------------------------------------------------------------------------
# F17: second XCRemoteSwiftPackageReference written with a lowercase-hex id → exit 1
# (an id-anchored uppercase-only scan would not see it; the isa count must)
# ---------------------------------------------------------------------------
T="${TMPDIR_BASE}/f17"; mkdir -p "$T"
printf '\t\tdeadbeefdeadbeefdeadbeef /* XCRemoteSwiftPackageReference "evil" */ = {\n\t\t\tisa = XCRemoteSwiftPackageReference;\n\t\t\trepositoryURL = "https://github.com/evil/evil.git";\n\t\t\trequirement = {\n\t\t\t\tkind = upToNextMajorVersion;\n\t\t\t\tminimumVersion = 1.0.0;\n\t\t\t};\n\t\t};\n' > "$T/extra.txt"
awk -v extra="$T/extra.txt" '/End XCRemoteSwiftPackageReference section/ { while ((getline line < extra) > 0) print line } { print }' "$GOOD_PBXPROJ" > "$T/f17.pbxproj"
grep -q 'deadbeefdeadbeefdeadbeef' "$T/f17.pbxproj" || { echo "FAIL F17 fixture: insertion did not apply"; FAIL=$((FAIL + 1)); }
run_test F17 1 \
  "${base_args[@]}" \
  --pbxproj "$T/f17.pbxproj" \
  --resolved "$GOOD_RESOLVED"

# ---------------------------------------------------------------------------
# F18: pin location with path traversal → exit 1
# ---------------------------------------------------------------------------
T="${TMPDIR_BASE}/f18"; mkdir -p "$T"
sed 's#https://github.com/google/promises.git#https://github.com/google/../../evil/promises.git#' "$GOOD_RESOLVED" > "$T/f18.Package.resolved"
grep -q 'google/\.\./\.\./evil' "$T/f18.Package.resolved" || { echo "FAIL F18 fixture: substitution did not apply"; FAIL=$((FAIL + 1)); }
run_test F18 1 \
  "${base_args[@]}" \
  --pbxproj "$GOOD_PBXPROJ" \
  --resolved "$T/f18.Package.resolved"

# ---------------------------------------------------------------------------
# F19: mirrors.json beside Package.resolved (swiftpm/configuration) → exit 1
# ---------------------------------------------------------------------------
T="${TMPDIR_BASE}/f19/swiftpm"; mkdir -p "$T/configuration"
cp "$GOOD_RESOLVED" "$T/Package.resolved"
echo '{"object":[{"original":"https://github.com/firebase/firebase-ios-sdk.git","mirror":"https://evil.example/x.git"}],"version":1}' > "$T/configuration/mirrors.json"
run_test F19 1 \
  "${base_args[@]}" \
  --pbxproj "$GOOD_PBXPROJ" \
  --resolved "$T/Package.resolved"

echo ""
echo "Results: ${PASS}/${TOTAL} passed, ${FAIL} failed"
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
exit 0
