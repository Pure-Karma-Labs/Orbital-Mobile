/**
 * check-security-invariants.mjs
 *
 * Static analysis invariant checks that complement ESLint and Semgrep.
 * These rules are cross-file or context-sensitive — hard to express in
 * per-file linting or pattern-matching tools.
 *
 * Exit 0 = clean, Exit 1 = violations found.
 * Uses only Node.js built-ins (no external dependencies).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { exit } from 'node:process';

const SRC = 'src';
const violations = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function walkSync(dir, ext, results = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkSync(full, ext, results);
    } else if (ext.some((e) => full.endsWith(e))) {
      results.push(full);
    }
  }
  return results;
}

function report(file, lineNum, rule, snippet) {
  const rel = relative('.', file);
  violations.push(`  ${rel}:${lineNum}  [${rule}]  ${snippet}`);
}

const allFiles = walkSync(SRC, ['.ts', '.tsx']);

// ---------------------------------------------------------------------------
// 1. Insecure URL literals (http:// or ws:// to non-localhost domains)
// ---------------------------------------------------------------------------

const INSECURE_URL_RE = /['"`]((?:http|ws):\/\/)([^/'"`:]+)/g;
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '10.0.2.2']);
const URL_SKIP_PATTERNS = [
  '__tests__/',
  '.test.ts',
  '.test.tsx',
  'src/config/env.ts',
  'src/components/EmojiText.tsx',
  'src/services/media/imageSanitizer.ts',
  // Holds XMP packet signatures for test fixtures -- same reason as imageSanitizer.ts above.
  'src/services/testUtils/imageFixtures.ts',
  // Same again (#925): `svgHead()` builds the bytes of an SVG document head so
  // the content sniffer has something it must refuse. The w3.org xmlns inside
  // it is DATA in a fixture, never a request target. Named as a FILE, not a
  // directory, so a future module in testUtils/ does not inherit the exemption.
  'src/services/metaImport/testUtils/builders.ts',
];

for (const file of allFiles) {
  const rel = relative('.', file);
  if (URL_SKIP_PATTERNS.some((p) => rel.includes(p))) continue;

  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    INSECURE_URL_RE.lastIndex = 0;
    while ((m = INSECURE_URL_RE.exec(line)) !== null) {
      const host = m[2].split(':')[0]; // strip port
      if (!ALLOWED_HOSTS.has(host)) {
        report(file, i + 1, 'insecure-url', `${m[1]}${m[2]}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Keychain ACCESSIBLE constants outside secureStorage.ts
// ---------------------------------------------------------------------------

const KEYCHAIN_ACCESSOR_FILE = join(SRC, 'services', 'secure-storage', 'secureStorage.ts');
const ACCESSIBLE_RE = /ACCESSIBLE\./;

for (const file of allFiles) {
  const rel = relative('.', file);
  if (rel.includes('__tests__/') || rel.includes('.test.ts') || rel.includes('.test.tsx')) continue;
  if (file === KEYCHAIN_ACCESSOR_FILE) continue;

  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (ACCESSIBLE_RE.test(lines[i])) {
      report(file, i + 1, 'keychain-constant-outside-secureStorage', lines[i].trim());
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Test-only function imports outside __tests__/ directories
// ---------------------------------------------------------------------------

const TEST_FN_IMPORT_RE = /import\s.*(?:resetDatabaseForTesting|resetMMKVForTesting)/;

for (const file of allFiles) {
  const rel = relative('.', file);
  if (rel.includes('__tests__/')) continue;
  if (rel.includes('.test.ts') || rel.includes('.test.tsx')) continue;
  // Allow re-exports in barrel files
  if (rel.endsWith('index.ts')) continue;
  // Allow test utility directories
  if (rel.includes('testUtils/')) continue;

  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (TEST_FN_IMPORT_RE.test(lines[i])) {
      report(file, i + 1, 'test-only-import', lines[i].trim());
    }
  }
}

// ---------------------------------------------------------------------------
// 4. createMMKV without encryptionKey
// ---------------------------------------------------------------------------

const CREATE_MMKV_RE = /createMMKV\s*\(/;
const ENCRYPTION_KEY_RE = /encryptionKey/;
const FOR_TESTING_FN_RE = /ForTesting/;

for (const file of allFiles) {
  const content = readFileSync(file, 'utf8');
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!CREATE_MMKV_RE.test(lines[i])) continue;

    // Check if this is inside a ForTesting function — scan up for function name
    let inTestingFn = false;
    for (let j = i; j >= Math.max(0, i - 10); j--) {
      if (FOR_TESTING_FN_RE.test(lines[j])) {
        inTestingFn = true;
        break;
      }
    }
    if (inTestingFn) continue;

    // Check the call and the next few lines for encryptionKey
    const block = lines.slice(i, Math.min(i + 5, lines.length)).join('\n');
    if (!ENCRYPTION_KEY_RE.test(block)) {
      report(file, i + 1, 'mmkv-no-encryptionKey', lines[i].trim());
    }
  }
}

// ---------------------------------------------------------------------------
// 5. launchCamera must not appear in src/ (camera path removed)
// ---------------------------------------------------------------------------

const LAUNCH_CAMERA_RE = /launchCamera/;

for (const file of allFiles) {
  const rel = relative('.', file);
  if (rel.includes('__tests__/') || rel.includes('.test.ts') || rel.includes('.test.tsx')) continue;

  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (LAUNCH_CAMERA_RE.test(lines[i])) {
      report(file, i + 1, 'camera-import-banned', lines[i].trim());
    }
  }
}

// ---------------------------------------------------------------------------
// 6. Sanitizer presence and picker import restriction
// ---------------------------------------------------------------------------

// mediaUploadService.ts must contain sanitizeStillImage( and verifyNoGpsAtoms(
const UPLOAD_SERVICE = join(SRC, 'services', 'mediaUploadService.ts');
const AVATAR_SERVICE = join(SRC, 'services', 'avatarService.ts');

try {
  const uploadContent = readFileSync(UPLOAD_SERVICE, 'utf8');
  if (!uploadContent.includes('sanitizeStillImage(')) {
    violations.push(`  ${relative('.', UPLOAD_SERVICE)}:0  [sanitizer-missing]  mediaUploadService must call sanitizeStillImage`);
  }
  if (!uploadContent.includes('verifyNoGpsAtoms(') && !uploadContent.includes('prepareVideoForUpload(')) {
    violations.push(`  ${relative('.', UPLOAD_SERVICE)}:0  [sanitizer-missing]  mediaUploadService must call verifyNoGpsAtoms or prepareVideoForUpload`);
  }
} catch {
  violations.push(`  ${relative('.', UPLOAD_SERVICE)}:0  [file-missing]  mediaUploadService.ts not found`);
}

try {
  const avatarContent = readFileSync(AVATAR_SERVICE, 'utf8');
  if (!avatarContent.includes('sanitizeStillImage(')) {
    violations.push(`  ${relative('.', AVATAR_SERVICE)}:0  [sanitizer-missing]  avatarService must call sanitizeStillImage`);
  }
} catch {
  violations.push(`  ${relative('.', AVATAR_SERVICE)}:0  [file-missing]  avatarService.ts not found`);
}

// react-native-image-picker imports restricted to useMediaPicker.ts, which since
// #971 is the SOLE launch path: it owns the app-wide in-flight lock, and
// launchLibraryOnce is the only wrapper allowed to call launchImageLibrary.
// EditProfileScreen.tsx was exempt until #971 moved it onto the hook; leaving
// that exemption in place would let a direct import reopen the re-entrant
// launch this issue fixed, which is exactly the double-callback abort's trigger.
const ALLOWED_PICKER_FILES = new Set([join(SRC, 'hooks', 'useMediaPicker.ts')]);

const PICKER_IMPORT_RE = /from\s+['"]react-native-image-picker['"]/;

for (const file of allFiles) {
  const rel = relative('.', file);
  if (rel.includes('__tests__/') || rel.includes('.test.ts') || rel.includes('.test.tsx')) continue;
  if (ALLOWED_PICKER_FILES.has(file)) continue;

  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (PICKER_IMPORT_RE.test(lines[i])) {
      report(file, i + 1, 'picker-import-restricted', `react-native-image-picker import outside allowed files`);
    }
  }
}

// ---------------------------------------------------------------------------
// 7. orbital-media-transcoder imports restricted to the two sanitizer callers
// ---------------------------------------------------------------------------

// reencodeImage() drops metadata as a side effect of re-encoding, which makes
// it look like a sanitizer. It is not: imageSanitizer's byte-level strip plus
// verifyNoImageMetadata are the authoritative fail-closed layer. Restricting
// the import keeps a future caller from reaching for the native module
// directly and skipping that layer.
const ALLOWED_TRANSCODER_FILES = new Set([
  join(SRC, 'services', 'media', 'imageSanitizer.ts'),
  join(SRC, 'services', 'media', 'videoProcessing.ts'),
]);

const TRANSCODER_IMPORT_RE = /from\s+['"]orbital-media-transcoder['"]/;

for (const file of allFiles) {
  const rel = relative('.', file);
  if (rel.includes('__tests__/') || rel.includes('.test.ts') || rel.includes('.test.tsx')) continue;
  if (ALLOWED_TRANSCODER_FILES.has(file)) continue;

  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (TRANSCODER_IMPORT_RE.test(lines[i])) {
      report(file, i + 1, 'transcoder-import-restricted', 'orbital-media-transcoder import outside allowed files');
    }
  }
}

// ---------------------------------------------------------------------------
// 8. media3 version lockstep + ExoPlayer streaming-parser opt-outs
// ---------------------------------------------------------------------------

// Two independent Gradle files consume media3 (ExoPlayer): react-native-video
// resolves `rootProject.ext.media3Version`, and the transcoder module declares
// its own `def media3Version`. A skew between them puts two media3 versions in
// one dependency graph — a media-parsing stack with real CVE history, so the
// resolved version must be the one that was actually reviewed.
//
// Both anchors are REQUIRED to exist: a missing declaration is a violation, not
// a vacuous pass (that is the failure mode this check exists to prevent).
const APP_GRADLE = join('android', 'build.gradle');
const TRANSCODER_GRADLE = join(
  'packages',
  'orbital-media-transcoder',
  'android',
  'build.gradle',
);

function readMedia3Version(path, re) {
  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    violations.push(`  ${path}:0  [media3-lockstep]  file not found — cannot verify media3 pin`);
    return null;
  }
  const m = content.match(re);
  if (m === null) {
    violations.push(`  ${path}:0  [media3-lockstep]  no media3Version declaration found (anchor missing)`);
    return null;
  }
  return m[1];
}

const appMedia3 = readMedia3Version(APP_GRADLE, /^\s*media3Version\s*=\s*"([^"]+)"/m);
const transcoderMedia3 = readMedia3Version(
  TRANSCODER_GRADLE,
  /^\s*def\s+media3Version\s*=\s*"([^"]+)"/m,
);

if (appMedia3 !== null && transcoderMedia3 !== null && appMedia3 !== transcoderMedia3) {
  violations.push(
    `  ${APP_GRADLE}:0  [media3-lockstep]  media3Version ${appMedia3} != ${TRANSCODER_GRADLE} ${transcoderMedia3} — bump both together (#639)`,
  );
}

// react-native-video's own android/gradle.properties DEFAULTS
// SmoothStreaming/DASH/HLS to true, so these root-ext overrides are what keep
// the network manifest/segment parsers out of the build. Playback is local
// file:// MP4 only; deleting a line here silently ships a parser.
const PARSER_OPT_OUT_FLAGS = [
  'useExoplayerSmoothStreaming',
  'useExoplayerDash',
  'useExoplayerHls',
  'useExoplayerRtsp',
  'useExoplayerIMA',
];

try {
  const appGradle = readFileSync(APP_GRADLE, 'utf8');
  for (const flag of PARSER_OPT_OUT_FLAGS) {
    // Groovy: safeExtGet(flag)?.toBoolean() — only the exact string "false"
    // (or "FALSE"/"False") coerces to false. Anything else is a violation.
    const m = appGradle.match(new RegExp(`^\\s*${flag}\\s*=\\s*(.+)$`, 'm'));
    if (m === null) {
      violations.push(
        `  ${APP_GRADLE}:0  [media3-parser-optout]  ${flag} is not declared — react-native-video defaults it ON`,
      );
      continue;
    }
    if (!/^"false"$/i.test(m[1].trim())) {
      violations.push(
        `  ${APP_GRADLE}:0  [media3-parser-optout]  ${flag} must be the string "false", found: ${m[1].trim()}`,
      );
    }
  }
} catch {
  // The file-not-found case is already reported by readMedia3Version above.
}

// ---------------------------------------------------------------------------
// 9. react-native-video imports confined to ActiveVideoPage.tsx
// ---------------------------------------------------------------------------

// The player is the first place peer-authored bytes reach a native demuxer.
// Keeping the import in exactly one file keeps that surface reviewable and
// stops a future caller from mounting a player outside the active-page gate
// (which is what bounds the download and guarantees teardown).
const RNV_ALLOWED_FILE = join(SRC, 'components', 'ActiveVideoPage.tsx');
const RNV_IMPORT_RE = /from\s+['"]react-native-video['"]/;

for (const file of allFiles) {
  const rel = relative('.', file);
  if (rel.includes('__tests__/') || rel.includes('.test.ts') || rel.includes('.test.tsx')) continue;
  if (file === RNV_ALLOWED_FILE) continue;

  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (RNV_IMPORT_RE.test(lines[i])) {
      report(file, i + 1, 'rnv-import-restricted', 'react-native-video import outside ActiveVideoPage.tsx');
    }
  }
}

// Non-vacuity: if the allowlisted file stops importing react-native-video (or
// is renamed away), the rule above would pass trivially. Assert the anchor.
try {
  const allowed = readFileSync(RNV_ALLOWED_FILE, 'utf8');
  if (!RNV_IMPORT_RE.test(allowed)) {
    violations.push(
      `  ${relative('.', RNV_ALLOWED_FILE)}:0  [rnv-import-restricted]  allowlisted file no longer imports react-native-video — update the allowlist instead of leaving a vacuous rule`,
    );
  }
} catch {
  violations.push(
    `  ${relative('.', RNV_ALLOWED_FILE)}:0  [rnv-import-restricted]  allowlisted file not found — the confinement rule would pass vacuously`,
  );
}

// ---------------------------------------------------------------------------
// 10. New Architecture required while react-native-video is a dependency
// ---------------------------------------------------------------------------

// react-native-video 6.x has no Fabric component, so it renders through RN's
// legacy ViewManager interop. Its imperative commands (seek included) are
// dispatched by VideoManagerModule via UIManagerHelper with
// UIManagerType.FABRIC, which is selected from the app's `newArchEnabled`
// gradle property. Turning that off does not fall back to a paper path — it
// resolves no view and every player command silently no-ops, so the custom
// scrubber (#662) would render and do nothing.
//
// Anchored on the dependency: if react-native-video is ever removed, this rule
// must be deleted rather than left to pass vacuously.
const PKG_JSON = 'package.json';
const GRADLE_PROPS = join('android', 'gradle.properties');

try {
  const pkg = JSON.parse(readFileSync(PKG_JSON, 'utf8'));
  if (pkg.dependencies?.['react-native-video'] === undefined) {
    violations.push(
      `  ${PKG_JSON}:0  [rnv-newarch-required]  react-native-video is no longer a dependency — delete this rule instead of leaving a vacuous check`,
    );
  } else {
    let gradleProps;
    try {
      gradleProps = readFileSync(GRADLE_PROPS, 'utf8');
    } catch {
      gradleProps = null;
      violations.push(
        `  ${GRADLE_PROPS}:0  [rnv-newarch-required]  file not found — cannot verify newArchEnabled`,
      );
    }
    if (gradleProps !== null && !/^\s*newArchEnabled\s*=\s*true\s*$/m.test(gradleProps)) {
      violations.push(
        `  ${GRADLE_PROPS}:0  [rnv-newarch-required]  newArchEnabled=true is required while react-native-video ships — without it every player command (seek) silently no-ops`,
      );
    }
  }
} catch {
  violations.push(
    `  ${PKG_JSON}:0  [rnv-newarch-required]  package.json unreadable — cannot verify the react-native-video anchor`,
  );
}

// ---------------------------------------------------------------------------
// 11. Player content-escape props pinned off
// ---------------------------------------------------------------------------

// Decrypted family video must not leave the device's screen. With #662 the
// native player chrome is gone, which also removed the visible AirPlay button
// that the smoke runbook used to eyeball — so these props are now the only
// thing standing between a decrypted clip and an external display, the lock
// screen, background audio, or a floating PiP window that outlives the
// lightbox. `controls` is pinned too: the native controller is what drove
// #663's layout collapse and re-exposed an AirPlay route, and leaving it at
// the library default made it unenforceable.
//
// The match is scoped to the props of the <Video ... /> element with comment
// lines stripped. Whole-file matching was satisfiable by a prop merely NAMED
// in a comment, which is exactly the vacuity this rule exists to prevent.
const ESCAPE_PINS = [
  'allowsExternalPlayback',
  'playInBackground',
  'playWhenInactive',
  'showNotificationControls',
  'enterPictureInPictureOnLeave',
  'controls',
];

try {
  const activePage = readFileSync(RNV_ALLOWED_FILE, 'utf8');
  const elementMatch = activePage.match(/<Video\b[\s\S]*?\n\s*\/>/);
  if (elementMatch === null) {
    violations.push(
      `  ${relative('.', RNV_ALLOWED_FILE)}:0  [rnv-content-escape-pins]  no <Video ... /> element found — the content-escape rule would pass vacuously`,
    );
  } else {
    const videoProps = elementMatch[0]
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join('\n');
    for (const prop of ESCAPE_PINS) {
      // \b prevents `controls` from being satisfied by `controlsStyles`.
      if (!new RegExp(`\\b${prop}=\\{false\\}`).test(videoProps)) {
        violations.push(
          `  ${relative('.', RNV_ALLOWED_FILE)}:0  [rnv-content-escape-pins]  ${prop}={false} missing on the <Video> element`,
        );
      }
    }
  }
} catch {
  violations.push(
    `  ${relative('.', RNV_ALLOWED_FILE)}:0  [rnv-content-escape-pins]  player file not found — the content-escape rule would pass vacuously`,
  );
}

// ---------------------------------------------------------------------------
// 12. Firebase resolves via Swift Package Manager with dynamic frameworks (#769)
// ---------------------------------------------------------------------------

// @react-native-firebase >= 26 resolves Firebase via Swift Package Manager and
// requires dynamic frameworks (#769). Rationale has ONE home: the comment above
// `use_frameworks!` in ios/Podfile. This static check guards the Podfile lines
// the runtime guards (Podfile post_install + scripts/verify-firebase-spm.rb,
// ci.yml SPM log + pbxproj diff + Package.resolved gate) depend on.
// Anchored on the dependency: if @react-native-firebase/app is ever removed,
// delete this rule rather than leave it to pass vacuously.

try {
  const pkg = JSON.parse(readFileSync(PKG_JSON, 'utf8'));
  if (pkg.dependencies?.['@react-native-firebase/app'] === undefined) {
    violations.push(
      `  ${PKG_JSON}:0  [rnfb-spm-dynamic]  @react-native-firebase/app is no longer a dependency — delete this rule instead of leaving a vacuous check`,
    );
  } else {
    let podfile;
    try {
      podfile = readFileSync(join('ios', 'Podfile'), 'utf8');
    } catch {
      podfile = null;
      violations.push(
        `  ios/Podfile:0  [rnfb-spm-dynamic]  ios/Podfile not found — cannot verify Firebase SPM configuration`,
      );
    }
    if (podfile !== null) {
      if (/^\s*\$RNFirebaseDisableSPM\s*=/m.test(podfile)) {
        violations.push(`  ios/Podfile:0  [rnfb-spm-dynamic]  ios/Podfile must not assign $RNFirebaseDisableSPM — Firebase is SPM-resolved since #769`);
      }
      if (!/^use_frameworks! :linkage => :dynamic\s*$/m.test(podfile)) {
        violations.push(`  ios/Podfile:0  [rnfb-spm-dynamic]  ios/Podfile must declare "use_frameworks! :linkage => :dynamic" at top level — see #769`);
      }
      if (!/^ORBITAL_FIREBASE_SPM_URL = 'https:\/\/github\.com\/firebase\/firebase-ios-sdk\.git'\s*$/m.test(podfile)) {
        violations.push(`  ios/Podfile:0  [rnfb-spm-dynamic]  ios/Podfile must pin ORBITAL_FIREBASE_SPM_URL to the canonical firebase-ios-sdk URL — see #769`);
      }
    }
  }
} catch {
  violations.push(
    `  ${PKG_JSON}:0  [rnfb-spm-dynamic]  package.json unreadable — cannot verify the @react-native-firebase/app anchor`,
  );
}

// ---------------------------------------------------------------------------
// 13. iOS CI/build cache-step parity
// ---------------------------------------------------------------------------

// ci.yml and build.yml must carry identical path: and key: for the three iOS
// cache steps (CocoaPods, Sentry xcframework, Swift package clones). A drift
// between the two files silently breaks reproducibility: one machine fetches
// stale pods while the other hits a good cache. Anchored on the step names
// existing in both files; a missing name is itself a violation.
// (◆ agreed at #800, implemented in #769.)

const CI_YML = join('.github', 'workflows', 'ci.yml');
const BUILD_YML = join('.github', 'workflows', 'build.yml');

const PARITY_STEPS = [
  'Cache CocoaPods',
  'Cache Sentry xcframework download',
  'Cache Swift package clones',
];

function extractCacheStep(yamlText, stepName) {
  // Find the step block by name, then extract path: and key: values.
  // Uses line-based extraction: find "- name: <stepName>" then scan forward
  // for path: and key: lines until the next "- name:" or "- uses:" or end.
  const lines = yamlText.split('\n');
  let inStep = false;
  let depth = null;
  const result = { path: null, key: null, restoreKeys: null };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nameMatch = line.match(/^(\s*)- name:\s*(.+)$/);
    if (nameMatch) {
      if (inStep) break; // left the step
      if (nameMatch[2].trim() === stepName) {
        inStep = true;
        depth = nameMatch[1].length;
        continue;
      }
    }
    if (!inStep) continue;
    // Stop at the next step-level list item
    if (line.match(/^\s{0,}(-\s+(name|uses|run|if|id):)/)) {
      const indent = line.match(/^(\s*)/)[1].length;
      if (indent <= depth) break;
    }
    const pathMatch = line.match(/^\s+path:\s*\|?\s*$/);
    if (pathMatch) {
      // Multi-line path: collect subsequent indented lines
      let paths = [];
      let j = i + 1;
      while (j < lines.length && lines[j].match(/^\s{4,}/) && !lines[j].match(/^\s+[\w-]+:/)) {
        paths.push(lines[j].trim());
        j++;
      }
      result.path = paths.length > 0 ? paths.join('\n') : null;
      continue;
    }
    const pathInlineMatch = line.match(/^\s+path:\s*(.+)$/);
    if (pathInlineMatch) { result.path = pathInlineMatch[1].trim(); continue; }
    const keyMatch = line.match(/^\s+key:\s*(.+)$/);
    if (keyMatch) { result.key = keyMatch[1].trim(); continue; }
    const rkMatch = line.match(/^\s+restore-keys:\s*\|?\s*(.*)$/);
    if (rkMatch) {
      // Collect the VALUES (block scalar lines or the inline value) so a
      // restore-keys drift is a real mismatch, not just presence/absence.
      const values = rkMatch[1].trim() ? [rkMatch[1].trim()] : [];
      let j = i + 1;
      while (j < lines.length && lines[j].match(/^\s{4,}/) && !lines[j].match(/^\s+[\w-]+:/)) {
        values.push(lines[j].trim());
        j++;
      }
      result.restoreKeys = values.join('\n');
      continue;
    }
  }
  return inStep ? result : null;
}

let ciYaml = null;
let buildYaml = null;
try { ciYaml = readFileSync(CI_YML, 'utf8'); } catch { violations.push(`  ${CI_YML}:0  [ios-cache-parity]  ci.yml not found`); }
try { buildYaml = readFileSync(BUILD_YML, 'utf8'); } catch { violations.push(`  ${BUILD_YML}:0  [ios-cache-parity]  build.yml not found`); }

if (ciYaml !== null && buildYaml !== null) {
  for (const stepName of PARITY_STEPS) {
    const ci = extractCacheStep(ciYaml, stepName);
    const build = extractCacheStep(buildYaml, stepName);
    if (ci === null) {
      violations.push(`  ${CI_YML}:0  [ios-cache-parity]  step "${stepName}" not found in ci.yml`);
    }
    if (build === null) {
      violations.push(`  ${BUILD_YML}:0  [ios-cache-parity]  step "${stepName}" not found in build.yml`);
    }
    if (ci !== null && build !== null) {
      if (ci.path !== build.path) {
        violations.push(`  ${CI_YML}:0  [ios-cache-parity]  step "${stepName}" path: differs between ci.yml (${ci.path}) and build.yml (${build.path})`);
      }
      if (ci.key !== build.key) {
        violations.push(`  ${CI_YML}:0  [ios-cache-parity]  step "${stepName}" key: differs between ci.yml (${ci.key}) and build.yml (${build.key})`);
      }
      if ((ci.restoreKeys || '') !== (build.restoreKeys || '')) {
        violations.push(`  ${CI_YML}:0  [ios-cache-parity]  step "${stepName}" restore-keys differ between ci.yml (${JSON.stringify(ci.restoreKeys)}) and build.yml (${JSON.stringify(build.restoreKeys)})`);
      }
      // Sentry xcframework download must have no restore-keys in either file
      if (stepName === 'Cache Sentry xcframework download') {
        if (ci.restoreKeys) {
          violations.push(`  ${CI_YML}:0  [ios-cache-parity]  "Cache Sentry xcframework download" must have no restore-keys in ci.yml`);
        }
        if (build.restoreKeys) {
          violations.push(`  ${BUILD_YML}:0  [ios-cache-parity]  "Cache Sentry xcframework download" must have no restore-keys in build.yml`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 14. iOS UIScene lifecycle adoption (#815)
// ---------------------------------------------------------------------------

// iOS 27 refuses to launch an app built against the iOS 27 SDK that has no
// UIApplicationSceneManifest ("UIScene life cycle is required for apps built
// with this SDK"). CI compiles on the Xcode 26.x pin and therefore cannot
// observe that refusal, so this static check is the only PR-time detector for
// the three plain-text facts that keep the app launchable: the manifest, the
// scene-delegate class name, and SceneDelegate.swift being in the Sources
// build phase. React Native 0.82 ships no scene support, so SceneDelegate.swift
// hand-ports facebook/react-native#57700; its header carries the grep condition
// under which the whole shim can be deleted.
//
// UIApplicationSupportsMultipleScenes stays false (Xcode's "Supports multiple
// windows" checkbox flips it silently): one RN host per process. The full
// rationale, including the sequential disconnect/reconnect case the flag does
// NOT cover, lives in the SceneDelegate.swift header — one home, do not
// duplicate it here.
//
// The last two assertions pin the facts that bound scene(_:openURLContexts:),
// which forwards any URL iOS hands the scene into RCTLinkingManager with no
// scheme check: only the `orbital` scheme is declared, and no document /
// file-sharing keys exist, so iOS cannot deliver file:// or foreign schemes.
// If either assertion has to change, validate the scheme at the consumer (see
// the forwarder's comment in SceneDelegate.swift).
//
// Anchored on the files existing: a missing SceneDelegate.swift or a missing
// manifest is itself a violation, so the rule cannot pass vacuously.

const IOS_INFO_PLIST = join('ios', 'OrbitalMobile', 'Info.plist');
const SCENE_DELEGATE = join('ios', 'OrbitalMobile', 'SceneDelegate.swift');
const PBXPROJ = join('ios', 'OrbitalMobile.xcodeproj', 'project.pbxproj');

try {
  const infoPlist = readFileSync(IOS_INFO_PLIST, 'utf8');
  if (!infoPlist.includes('<key>UIApplicationSceneManifest</key>')) {
    violations.push(
      `  ${IOS_INFO_PLIST}:0  [ios-scene-lifecycle]  UIApplicationSceneManifest missing — iOS 27 refuses to launch apps built with the iOS 27 SDK without it (#815)`,
    );
  }
  if (!/<key>UIApplicationSupportsMultipleScenes<\/key>\s*<false\/>/.test(infoPlist)) {
    violations.push(
      `  ${IOS_INFO_PLIST}:0  [ios-scene-lifecycle]  UIApplicationSupportsMultipleScenes must be <false/> — a second scene would start a second RN host in this process (#815)`,
    );
  }
  if (
    !/<key>UISceneDelegateClassName<\/key>\s*<string>\$\(PRODUCT_MODULE_NAME\)\.SceneDelegate<\/string>/.test(
      infoPlist,
    )
  ) {
    violations.push(
      `  ${IOS_INFO_PLIST}:0  [ios-scene-lifecycle]  UISceneDelegateClassName must be $(PRODUCT_MODULE_NAME).SceneDelegate — a hardcoded module name fails at launch because PRODUCT_NAME is Orbital (#815)`,
    );
  }
  // The delegate entry only loads under the application window-scene role; a
  // renamed or misplaced role key passes the string checks above and iOS never
  // instantiates SceneDelegate.
  if (!/<key>UIWindowSceneSessionRoleApplication<\/key>\s*<array>/.test(infoPlist)) {
    violations.push(
      `  ${IOS_INFO_PLIST}:0  [ios-scene-lifecycle]  UISceneConfigurations must declare the UIWindowSceneSessionRoleApplication role array — SceneDelegate is not loaded under any other role (#815)`,
    );
  }
  // Deep-link containment facts (see SceneDelegate.swift scene(_:openURLContexts:)).
  const schemeArrays = [...infoPlist.matchAll(/<key>CFBundleURLSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/g)];
  const schemes = schemeArrays.flatMap((m) => [...m[1].matchAll(/<string>([^<]*)<\/string>/g)].map((x) => x[1].trim()));
  if (schemes.length !== 1 || schemes[0] !== 'orbital') {
    violations.push(
      `  ${IOS_INFO_PLIST}:0  [ios-scene-lifecycle]  CFBundleURLSchemes must declare exactly one scheme, "orbital" (found: ${JSON.stringify(schemes)}) — SceneDelegate forwards inbound URLs unvalidated on that assumption (#815)`,
    );
  }
  for (const key of ['CFBundleDocumentTypes', 'UIFileSharingEnabled', 'LSSupportsOpeningDocumentsInPlace']) {
    if (infoPlist.includes(`<key>${key}</key>`)) {
      violations.push(
        `  ${IOS_INFO_PLIST}:0  [ios-scene-lifecycle]  ${key} must not be declared — it would let iOS hand file:// or foreign URLs to the unvalidated scene(_:openURLContexts:) forwarder; validate the scheme at the consumer first (#815)`,
      );
    }
  }
} catch {
  violations.push(
    `  ${IOS_INFO_PLIST}:0  [ios-scene-lifecycle]  Info.plist not found — cannot verify the UIScene manifest that keeps the app launchable on iOS 27 (#815)`,
  );
}

try {
  const sceneDelegate = readFileSync(SCENE_DELEGATE, 'utf8');
  if (!/^class SceneDelegate\b.*UIWindowSceneDelegate/m.test(sceneDelegate)) {
    violations.push(
      `  ${SCENE_DELEGATE}:0  [ios-scene-lifecycle]  SceneDelegate must declare "class SceneDelegate ... UIWindowSceneDelegate" — the Info.plist delegate class must resolve at launch (#815)`,
    );
  }
} catch {
  violations.push(
    `  ${SCENE_DELEGATE}:0  [ios-scene-lifecycle]  SceneDelegate.swift not found — iOS 27 launch refusal returns without it (#815)`,
  );
}

try {
  const pbxproj = readFileSync(PBXPROJ, 'utf8');
  if (!/\/\* SceneDelegate\.swift in Sources \*\//.test(pbxproj)) {
    violations.push(
      `  ${PBXPROJ}:0  [ios-scene-lifecycle]  SceneDelegate.swift is not in the OrbitalMobile Sources build phase — the scene delegate class would be absent from the binary and iOS 27 would refuse to launch (#815)`,
    );
  }
} catch {
  violations.push(
    `  ${PBXPROJ}:0  [ios-scene-lifecycle]  project.pbxproj not found — cannot verify that SceneDelegate.swift compiles into the app (#815)`,
  );
}

// ---------------------------------------------------------------------------
// 15. Sentry privacy hooks (#746)
// ---------------------------------------------------------------------------

// The Sentry payload boundary is four plain-text facts spread over four files,
// and three of them are unobservable from a unit test: an option the SDK only
// forwards to native, a breadcrumb category drop, and a prop on a wrapper the
// test renderer never mounts. If any one is reverted the app keeps working and
// keeps reporting — it just starts shipping request URLs, touch labels
// (`Thread: ${title}` and friends, i.e. DECRYPTED content), console arguments
// or the thrower's own error object to a server we do not control.
//
// Each check locates a WINDOW (the options literal, the drop block, the wrap
// call, the capture call) and strips comment lines before matching. Whole-file
// matching was satisfiable by a pin merely NAMED in a comment, which is
// exactly the vacuity these rules exist to prevent. A missing window or a
// missing file is itself a violation, so nothing here can pass vacuously.
//
// Every window regex is ^-anchored under /m. Without the anchor, commenting
// out the window's opening line left the match STARTING mid-line, so the
// comment-strip filter no longer saw a leading `//` and the pins on that line
// still satisfied the rule — verified by mutation test.

const SENTRY_INIT_FILE = join(SRC, 'sentryInit.ts');
const TELEMETRY_SCRUB_FILE = join(SRC, 'services', 'telemetryScrub.ts');
const TELEMETRY_FILE = join(SRC, 'services', 'telemetry.ts');
const APP_FILE = join(SRC, 'App.tsx');

/**
 * Assert every pin appears inside a window of `file`, with comment lines
 * stripped. A missing file or a window the regex cannot find is a violation.
 *
 * @param forbidden - Substrings that must NOT appear in the comment-stripped
 *   window. Required pins say "this defence is present"; forbidden substrings
 *   say "this bypass is absent", which is what catches a defence that is kept
 *   AND then overridden on the next line (#783).
 * @param issue - Issue suffix on the violation line. Defaults to the Sentry
 *   privacy-hook issue the helper was written for, so existing callers are
 *   unchanged.
 * @param strip - Optional comment stripper for languages this helper does not
 *   know. Without it the window is located in the RAW text and only C-style
 *   comments are removed from the window, which is what every caller before
 *   #920 relies on. WITH it the whole file is stripped BEFORE the window is
 *   located, so a `#`-commented pin cannot satisfy the rule and a `#`-commented
 *   section header cannot open a window — pass `stripShellComments` for TOML or
 *   YAML. Mutation 29-18 is why this parameter exists.
 */
function checkWindowedPins(
  file,
  rule,
  windowRe,
  windowLabel,
  pins,
  forbidden = [],
  issue = '#746',
  strip = null,
) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    violations.push(
      `  ${relative('.', file)}:0  [${rule}]  file not found — ${windowLabel} cannot be verified and the rule would pass vacuously`,
    );
    return;
  }
  if (strip) text = strip(text);
  const match = text.match(windowRe);
  if (match === null) {
    violations.push(
      `  ${relative('.', file)}:0  [${rule}]  ${windowLabel} not found — the rule would pass vacuously`,
    );
    return;
  }
  const body = strip
    ? match[0]
    : match[0]
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
        // Trailing comments too: `enableNetworkBreadcrumbs: true, // was: false`
        // must not satisfy the pin (PR #837 review). None of these windows holds
        // a `//` inside a string literal, so a plain strip is safe.
        .map((line) => line.replace(/\s\/\/.*$/, ''))
        .join('\n');
  for (const pin of pins) {
    if (!body.includes(pin)) {
      violations.push(
        `  ${relative('.', file)}:0  [${rule}]  "${pin}" missing from ${windowLabel} (${issue})`,
      );
    }
  }
  for (const banned of forbidden) {
    if (body.includes(banned)) {
      violations.push(
        `  ${relative('.', file)}:0  [${rule}]  "${banned}" must not appear in ${windowLabel} (${issue})`,
      );
    }
  }
}

// The Sentry.init() options literal. `console: false` is the breadcrumbs
// integration override; `enableNetworkBreadcrumbs: false` is the cocoa-only
// flag that is the ONLY defence for hard native crash reports, because
// wrapper.js strips beforeSend/beforeBreadcrumb from the native options.
checkWindowedPins(
  SENTRY_INIT_FILE,
  'sentry-privacy-hooks',
  /^const options:[\s\S]*?\n\};/m,
  'the Sentry.init() options literal',
  [
    'beforeBreadcrumb: filterBreadcrumb',
    'beforeSend: scrubEvent',
    'enableNetworkBreadcrumbs: false',
    'enableJsHangTracking: false',
    'console: false',
    'xhr: false',
    'sendDefaultPii: false',
    'enableMemoryIntrospection: false',
    'maxBreadcrumbs:',
  ],
);

// The breadcrumb drop block: the dropped-category set through the end of
// filterBreadcrumb. This is the PRIMARY touch-label defence (App.tsx's props
// are secondary) and the only thing that removes native http crumbs, which
// are merged into the event after beforeBreadcrumb has already run.
checkWindowedPins(
  TELEMETRY_SCRUB_FILE,
  'sentry-privacy-hooks',
  /^const DROPPED_CATEGORIES[\s\S]*?\n^export function filterBreadcrumb[\s\S]*?\n\}/m,
  'the filterBreadcrumb drop block',
  ["'http'", "'touch'", "'ui.multiClick'", "'console'"],
);

// The single approved capture path. Without this pin the Semgrep allowlist
// entry for telemetry.ts could sit over a function that captures the
// thrower's own object.
checkWindowedPins(
  TELEMETRY_FILE,
  'sentry-privacy-hooks',
  /^export function captureError[\s\S]*?\n\}/m,
  'the captureError body',
  ['Sentry.captureException(toReportableError('],
);

// TouchEventBoundary props: secondary defence for labels that interpolate
// decrypted titles, orbit names and display names.
checkWindowedPins(
  APP_FILE,
  'sentry-privacy-hooks',
  /^export default Sentry\.wrap\(App,[\s\S]*?\n\}\);/m,
  'the Sentry.wrap(App, …) call',
  ['extractTextFromChildren: false'],
);

// ---------------------------------------------------------------------------
// 16. No `| grep -q` pipelines in scripts/*.sh (#790)
// ---------------------------------------------------------------------------

// Under `set -euo pipefail`, a producer piped into an early-exiting consumer
// (grep -q, -qF, -qE, etc.) returns SIGPIPE (141) once the output exceeds the
// pipe buffer: 16 KB on macOS, 64 KB on Linux. That silently turns a pass into
// a fail — or, for a negative check, a fail into a pass. The repo-wide fix
// (#790) uses `contains "$output" "needle"` instead.
//
// Scope: guards the `| grep -q` shape only, on single lines, in *.sh files
// under scripts/ (recursive), skipping `#` comment lines. `||` is not a pipe.
// NOT covered: other early-exiting consumers (`| head`, `grep -m`), pipelines
// continued onto the next line, and workflow run: blocks — those still need
// review-time care.

const SCRIPTS_DIR = 'scripts';
const PIPE_GREP_Q_RE = /(?<!\|)\|(?!\|)[^#\n]*\bgrep\b[^#\n]*-[a-zA-Z]*q/;

let shFiles = [];
try {
  shFiles = walkSync(SCRIPTS_DIR, ['.sh']);
} catch {
  violations.push(`  ${SCRIPTS_DIR}:0  [no-pipeline-grep-q]  scripts/ directory not found — cannot verify the no-pipeline-grep-q invariant`);
}

for (const file of shFiles) {
  let lines;
  try {
    lines = readFileSync(file, 'utf8').split('\n');
  } catch {
    violations.push(`  ${file}:0  [no-pipeline-grep-q]  could not read file`);
    continue;
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip bash comment lines.
    if (/^\s*#/.test(line)) continue;
    if (PIPE_GREP_Q_RE.test(line)) {
      report(file, i + 1, 'no-pipeline-grep-q', line.trim());
    }
  }
}

// ---------------------------------------------------------------------------
// 17. timestampUnits imports confined to the two ms repositories (#844)
// ---------------------------------------------------------------------------

// src/database/timestampUnits.ts exports toMillis, the tolerant seconds-or-ms
// read for orbital_threads/orbital_replies. The Signal key stores and the
// items table hold epoch SECONDS (and the signed-pre-key rotation clock is a
// seconds value compared in JS) — applying toMillis there would 1000x key
// ages and force rotation on every launch. The JSDoc fence is not a guard;
// this rule is. Tests are exempt.
const TSU_ALLOWED_FILES = new Set([
  join(SRC, 'database', 'repositories', 'threadRepository.ts'),
  join(SRC, 'database', 'repositories', 'replyRepository.ts'),
]);
const TSU_IMPORT_RE = /from\s+['"][^'"]*timestampUnits['"]/;

for (const file of allFiles) {
  const rel = relative('.', file);
  if (rel.includes('__tests__/') || rel.includes('.test.ts') || rel.includes('.test.tsx')) continue;
  if (TSU_ALLOWED_FILES.has(file)) continue;

  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (TSU_IMPORT_RE.test(lines[i])) {
      report(file, i + 1, 'timestamp-units-import-restricted', 'timestampUnits import outside threadRepository/replyRepository — seconds-unit tables must never pass through toMillis');
    }
  }
}

// Non-vacuity: both allowlisted repositories must still import the helper.
for (const allowedFile of TSU_ALLOWED_FILES) {
  try {
    if (!TSU_IMPORT_RE.test(readFileSync(allowedFile, 'utf8'))) {
      violations.push(
        `  ${relative('.', allowedFile)}:0  [timestamp-units-import-restricted]  allowlisted repository no longer imports timestampUnits — update the allowlist instead of leaving a vacuous rule`,
      );
    }
  } catch {
    violations.push(
      `  ${relative('.', allowedFile)}:0  [timestamp-units-import-restricted]  allowlisted repository not found — the confinement rule would pass vacuously`,
    );
  }
}

// ---------------------------------------------------------------------------
// 18. Rust provenance: every cargo invocation is --locked, every cargo install
//     is version-pinned, cargo audit reads the committed lock, both crates are
//     actually tested, neither reaches outside its own digested input set, and
//     the two freshness gates share one input list (#812/#813/#920)
// ---------------------------------------------------------------------------

// Cargo re-resolves a drifted Cargo.lock SILENTLY unless --locked is passed.
// The lock is what anchors the single-curve25519-dalek provenance guard
// (security.yml), `cargo audit --file Cargo.lock` and the BIS derivation log,
// so a CI run on a re-resolved graph tests a dependency tree nobody reviewed.
// `cargo install` without @<version> is the same hazard for the toolchain that
// cuts shipped Android binaries (scripts/build-android.sh).
//
// TWO matching strengths, deliberately:
//
//   PERMISSIVE (CARGO_RE) decides the --locked and @<version> rules. It fires
//   on any `cargo build|test|clippy|install` token in a non-comment segment,
//   including prose such as the libsignal-bump issue body, because a runbook
//   that tells a developer to run an unlocked cargo command is itself the bug.
//
//   EXECUTABLE (EXEC_CARGO_RE) decides the non-vacuity assertions and the
//   `cargo audit --file` rule. It requires the segment to START with the cargo
//   invocation (optionally behind a YAML `run:`), which is what a real command
//   looks like after splitting on `&&`/`||`/`;`/`|`.
//
// The split is the PR #859 blocking fix. When the assertions counted permissive
// matches, the libsignal-bump issue body's "- Run cargo test --locked … and
// cargo clippy --locked …" line supplied test +1 and clippy +1 all by itself,
// so the entire rust-test job could be deleted and this invariant stayed
// green. Mutation-proven: replacing the real rust-test `run:` steps with
// `run: true` fires "found none" violations.
//
// Since #920 the non-vacuity assertions are PER CRATE, not per file: each
// expected invocation is matched together with the `working-directory:` of the
// YAML step that carries it. Two crates in one workflow made file-wide count
// floors unsound in both directions — raising security.yml's `test` floor to 2
// would have been satisfied by two `cargo test`s in the SAME crate (so the
// archive job could be deleted whole), and the archive job alone satisfies a
// floor of 1 after the orbital_signal job is deleted.
//
// `cargo audit` is excluded from CARGO_RE on purpose — cargo-audit has no
// --locked flag — and gets its own `--file Cargo.lock` clause instead. That
// clause is EXECUTABLE-only because `- name: cargo audit (blocking)` is a step
// label, not a command, and demanding a flag on it would be nonsense.
//
// KNOWN GAPS, all latent today, none silently:
//   - `cargo ndk … build` (cargo-ndk's own subcommand wrapper) is invisible to
//     both regexes: the token after `cargo` is `ndk`. scripts/build-android.sh
//     drives cargo through ubrn today, so no such line exists; one added later
//     would need its own clause. The cargo-ndk INSTALL is covered.
//   - A cargo invocation continued onto the next line with a trailing `\` is
//     seen only up to the break, so flags after it are invisible. There are
//     none today.
//   - A prose `cargo audit` escapes the --file clause (see above).

const RUST_PROV = 'rust-provenance-locked';
const CARGO_RE = /\bcargo(\s+\+[\w.-]+)?\s+(build|test|clippy|install)\b/g;
const EXEC_CARGO_RE = /^\s*(?:run:\s*)?cargo(?:\s+\+[\w.-]+)?\s+(build|test|clippy|install|audit)\b/;
const CARGO_INSTALL_PIN_RE = /\bcargo\s+install\s+([\w.-]+)@([\w.+-]+)/g;
const PKG_REL = 'packages/orbital-signal';
const CRATE_REL = 'packages/orbital-signal/rust/orbital_signal';
const ARCHIVE_PKG_REL = 'packages/orbital-archive-reader';
const ARCHIVE_CRATE_REL = 'packages/orbital-archive-reader/rust/orbital_archive_reader';

// The ONE app-side module permitted to reach the archive reader (#920).
// Spelled once here, before its first use: rule 24d's label allowlist, rule
// 24e's localWipe wiring and rule 29a's import restriction all name it, and a
// second spelling is how the three would drift apart after the file moves.
const ARCHIVE_ACCESS = join(SRC, 'services', 'metaImport', 'archiveAccess.ts');
// The archive-reader issue number, cited by rules 18, 24d, 24e, 29 and 29a.
const AR_ISSUE = '#920';

// A GitHub Actions step starts with `- <one of these keys>:`. Prose bullets
// inside a `run: |` block (the libsignal-bump issue body is full of them) do
// not match, which is what keeps them out of the working-directory lookup.
const STEP_KEY_RE =
  /^(\s*)-\s+(name|uses|run|id|if|with|env|shell|working-directory|timeout-minutes|continue-on-error):/;

/**
 * The `working-directory:` of the YAML step containing line `idx`, or null.
 * The step block runs from its first key to the next key at the same-or-lower
 * indentation, so the lookup cannot leak into a NEIGHBOURING step's
 * working-directory regardless of key order within the step.
 */
function stepWorkingDirectory(lines, idx) {
  let start = -1;
  for (let i = idx; i >= 0; i--) {
    if (STEP_KEY_RE.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const indent = lines[start].search(/\S/);
  let end = lines.length;
  for (let j = start + 1; j < lines.length; j++) {
    if (!lines[j].trim()) continue;
    const col = lines[j].search(/\S/);
    if (col < indent || (col === indent && STEP_KEY_RE.test(lines[j]))) {
      end = j;
      break;
    }
  }
  for (let j = start; j < end; j++) {
    const wd = /^\s*working-directory:\s*(.+?)\s*$/.exec(lines[j]);
    if (wd) return wd[1].replace(/^['"]|['"]$/g, '');
  }
  return null;
}

function cargoSegments(rawLine) {
  if (/^\s*#/.test(rawLine)) return [];
  // Strip a trailing shell/YAML comment (` #…`), keeping `#` inside tokens.
  const hashAt = rawLine.search(/\s#/);
  const line = hashAt >= 0 ? rawLine.slice(0, hashAt) : rawLine;
  return line.split(/&&|\|\||;|\|/);
}

// Collected across every scanned file so a crate pinned in two places can be
// checked for version parity.
const cargoInstallPins = new Map(); // crate -> Map<version, string[] sites>

// Every executable cargo invocation, with the crate directory its step runs
// in. Feeds the per-crate non-vacuity assertions below.
const cargoInvocations = []; // { file, line, sub, dir }

function checkCargoFile(file, label) {
  const empty = { build: 0, test: 0, clippy: 0, install: 0, audit: 0 };
  let lines;
  try {
    lines = readFileSync(file, 'utf8').split('\n');
  } catch {
    violations.push(`  ${file}:0  [${RUST_PROV}]  ${label} not found — the cargo --locked rule would pass vacuously`);
    return empty;
  }
  const counts = { ...empty };
  for (let i = 0; i < lines.length; i++) {
    const snippet = lines[i].trim();
    for (const segment of cargoSegments(lines[i])) {
      const exec = EXEC_CARGO_RE.exec(segment);

      // --- Non-vacuity: executable invocations only.
      if (exec) {
        counts[exec[1]] += 1;
        cargoInvocations.push({
          file,
          line: i + 1,
          sub: exec[1],
          dir: stepWorkingDirectory(lines, i),
        });
      }

      // --- cargo audit must read the COMMITTED lock. cargo-audit has no
      // --locked flag; without --file it generates a lock from Cargo.toml and
      // audits a graph nobody tested.
      if (exec && exec[1] === 'audit' && !/--file\s+Cargo\.lock\b/.test(segment)) {
        report(file, i + 1, RUST_PROV, `\`cargo audit\` without \`--file Cargo.lock\`: ${snippet}`);
      }

      // --- --locked / @<version>: permissive, prose included.
      CARGO_RE.lastIndex = 0;
      let m;
      while ((m = CARGO_RE.exec(segment)) !== null) {
        const sub = m[2];
        if (!/(^|\s)--locked(\s|$)/.test(segment)) {
          report(file, i + 1, RUST_PROV, `\`cargo ${sub}\` without --locked: ${snippet}`);
        }
        if (sub === 'install' && !/\bcargo\s+install\s+[\w.-]+@\d/.test(segment)) {
          report(file, i + 1, RUST_PROV, `\`cargo install\` without an @<version> pin: ${snippet}`);
        }
      }

      // --- Record every pinned install for cross-file version parity.
      CARGO_INSTALL_PIN_RE.lastIndex = 0;
      let pin;
      while ((pin = CARGO_INSTALL_PIN_RE.exec(segment)) !== null) {
        const [, crate, version] = pin;
        if (!cargoInstallPins.has(crate)) cargoInstallPins.set(crate, new Map());
        const byVersion = cargoInstallPins.get(crate);
        if (!byVersion.has(version)) byVersion.set(version, []);
        byVersion.get(version).push(`${relative('.', file)}:${i + 1}`);
      }
    }
  }
  return counts;
}

const CARGO_SCAN_FILES = [];
try {
  for (const entry of readdirSync('.github/workflows')) {
    if (entry.endsWith('.yml') || entry.endsWith('.yaml')) {
      CARGO_SCAN_FILES.push(join('.github/workflows', entry));
    }
  }
} catch {
  violations.push(`  .github/workflows:0  [${RUST_PROV}]  workflows directory not found — the cargo --locked rule would pass vacuously`);
}
try {
  CARGO_SCAN_FILES.push(...walkSync(SCRIPTS_DIR, ['.sh']));
} catch {
  violations.push(`  ${SCRIPTS_DIR}:0  [${RUST_PROV}]  scripts/ directory not found — the cargo --locked rule would pass vacuously`);
}

const cargoCounts = new Map();
for (const file of CARGO_SCAN_FILES) {
  cargoCounts.set(file, checkCargoFile(file, file));
}

// --- Per-file non-vacuity: the gating invocations must still EXIST as
// commands. A coarse repo-wide "at least one cargo line" check would survive
// deleting the whole rust-test job, which is the regression this guards.
//
// Every row is PER-CRATE as of #920 (F12): the pair (subcommand,
// working-directory) with a minimum count. A file-wide count floor is what
// build.yml used to carry, and with two crates in one workflow it proves
// nothing about coverage — four `cargo build` lines all pointing at
// orbital_signal satisfy a floor of 4 while the archive crate is never
// cross-compiled at all. The per-crate count is what preserves the property
// the old floor was really about: `rust-apple-targets` cross-compiles TWO
// Apple slices per crate (device release + simulator debug) from one step and
// one directory, so they are indistinguishable by working-directory alone and
// only the count separates "both slices" from "one".
//
// `min` defaults to 1, which is what every security.yml row wants: one
// invocation per crate per subcommand, full stop.
const CARGO_CRATE_EXPECTED = [
  ['.github/workflows/security.yml', 'test', CRATE_REL, 'the rust-test job no longer runs cargo test in orbital_signal'],
  ['.github/workflows/security.yml', 'clippy', CRATE_REL, 'the rust-test job no longer runs cargo clippy in orbital_signal'],
  ['.github/workflows/security.yml', 'audit', CRATE_REL, 'the rust-audit job no longer audits orbital_signal — the standing RUSTSEC gate'],
  ['.github/workflows/security.yml', 'test', ARCHIVE_CRATE_REL, 'the rust-test-archive job no longer runs cargo test — the ~5,000-mutant hostile-archive sweep would stop running (#920)'],
  ['.github/workflows/security.yml', 'clippy', ARCHIVE_CRATE_REL, 'the rust-test-archive job no longer runs cargo clippy in orbital_archive_reader (#920)'],
  ['.github/workflows/security.yml', 'audit', ARCHIVE_CRATE_REL, 'the rust-audit job no longer audits orbital_archive_reader — its flate2/miniz_oxide decompressor would be outside RUSTSEC coverage (#920)'],
  ['.github/workflows/build.yml', 'build', CRATE_REL, 'rust-apple-targets no longer cross-compiles both Apple slices of orbital_signal', 2],
  ['.github/workflows/build.yml', 'build', ARCHIVE_CRATE_REL, 'rust-apple-targets no longer cross-compiles both Apple slices of orbital_archive_reader, so an Apple-only compile break in the hostile-input parser would reach main unseen (#920)', 2],
];
for (const [file, sub, dir, why, min = 1] of CARGO_CRATE_EXPECTED) {
  if (!cargoCounts.has(file)) {
    violations.push(`  ${file}:0  [${RUST_PROV}]  expected cargo-bearing file was not scanned — ${why}`);
    continue;
  }
  const hits = cargoInvocations.filter(
    (inv) => inv.file === file && inv.sub === sub && inv.dir === dir,
  ).length;
  if (hits < min) {
    violations.push(`  ${file}:0  [${RUST_PROV}]  found ${hits} executable \`cargo ${sub}\` step(s) with \`working-directory: ${dir}\`, expected >=${min} — ${why}`);
  }
}

// --- Neither crate may reach outside its own digested input set.
//
// Both freshness gates (Android mtime, iOS sha256 digest) hash a LITERAL,
// fixed per-crate input list: that crate's Cargo.toml, Cargo.lock,
// rust-toolchain.toml and src/. A `path = "…"` dependency makes source OUTSIDE
// that list part of the binary, so editing it leaves a stale .a/.xcframework
// looking fresh to both gates and to `cargo --locked` (a path dep's content is
// not recorded in the lock). `[patch]` is the same trap by another spelling,
// and it is also how the curve25519-dalek fork came back in #634.
//
// `git =` is forbidden in the ARCHIVE crate only. orbital_signal's libsignal
// dependency is a git dep and always will be (Signal publishes no crates), and
// it is sound there because the lock records the resolved rev — content-
// addressed, so the digest covers it. The archive crate has no such need: it
// is four crates.io dependencies, and a git dep appearing there would mean
// something unreviewed is being pulled into a hostile-input parser.
//
// The key bans are ANCHORED REGEXES, not substrings: `path = "…"` is equally
// a dependency at the start of a line, after `{ `, or after `,` with no space
// at all (`{path="../x"}`), and a `path =` substring check misses two of those
// three. `[patch` stays a literal — it is a section header, and `[patch]`,
// `[patch.crates-io]` and `[patch."https://…"]` all start with it.
//
// Three spellings beyond the bare key, all probe-proven evasions (PR #977
// re-review): the DOTTED key `libc.path = "../x"` (legal TOML, equivalent to a
// `[dependencies.libc]` table), the QUOTED key `"path" = …` / `'git' = …`, and
// a plain `path = …` inside a `[dependencies.<crate>]` long-form table body —
// the last of which the line-anchored `^` already covers. Hence `.` in the
// leading class and an optional quote on each side. A key merely ENDING in the
// word (`exclude_path = "x"`) is still a non-match: `_` is not in the class.
const TOML_PATH_KEY_RE = /(^|[\s{,.])["']?path["']?\s*=/m;
const TOML_GIT_KEY_RE = /(^|[\s{,.])["']?git["']?\s*=/m;
const CARGO_TOML_BANS = [
  [`${CRATE_REL}/Cargo.toml`, 'orbital_signal', [['path =', TOML_PATH_KEY_RE], ['[patch', '[patch']]],
  [
    `${ARCHIVE_CRATE_REL}/Cargo.toml`,
    'orbital_archive_reader',
    [['path =', TOML_PATH_KEY_RE], ['git =', TOML_GIT_KEY_RE], ['[patch', '[patch']],
  ],
];
for (const [file, label, banned] of CARGO_TOML_BANS) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    violations.push(`  ${file}:0  [${RUST_PROV}]  ${label}'s Cargo.toml not found — the path/patch dependency rule would pass vacuously`);
    continue;
  }
  // Comments are prose: every one of these Cargo.toml files DOCUMENTS the ban
  // in a `#` comment, and that must not be mistaken for a violation. TOML uses
  // shell comment syntax, so the shell stripper is the right one.
  const code = stripShellComments(text);
  for (const [name, matcher] of banned) {
    const hit = typeof matcher === 'string' ? code.includes(matcher) : matcher.test(code);
    if (hit) {
      violations.push(`  ${file}:0  [${RUST_PROV}]  \`${name}\` appears in ${label}'s Cargo.toml — source outside the crate's literal freshness-input set would be linked into the binary while both staleness gates still read "fresh"`);
    }
  }
}

// --- One toolchain pin, at the repo root, for both crates.
// A `rust-toolchain.toml` under packages/ would silently build one crate with
// a different compiler. The two static libraries are linked into ONE app
// process and export ~1,805 shared uniffi/JNI symbols between them; a
// toolchain split there is an ODR-style mismatch nobody would see until a
// device crash. The root pin is also an input to both freshness gates, so a
// per-crate override would additionally be undigested.
const ROOT_TOOLCHAIN = 'rust-toolchain.toml';
try {
  statSync(ROOT_TOOLCHAIN);
} catch {
  violations.push(`  ${ROOT_TOOLCHAIN}:0  [${RUST_PROV}]  the repo-root Rust toolchain pin is missing — every cargo invocation would use whatever toolchain the host defaults to`);
}
// `target/` and `node_modules/` are build output, not sources, and walking
// them is both slow and meaningless here.
function findStrayToolchainPins(dir, found = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === 'target' || entry.name === 'node_modules') continue;
      findStrayToolchainPins(join(dir, entry.name), found);
    } else if (entry.name.startsWith('rust-toolchain')) {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}
for (const stray of findStrayToolchainPins('packages')) {
  violations.push(`  ${stray}:0  [${RUST_PROV}]  per-package Rust toolchain pin — one repo-root rust-toolchain.toml must cover both crates (the two static libraries share ~1,805 exported symbols in one process)`);
}

// --- Both crates' locks must resolve the SAME uniffi.
// uniffi's generated scaffolding and the bindings produced by
// uniffi-bindgen-react-native must come from one version: the metadata format
// and the UNIFFI_META symbol layout are version-coupled, and both crates'
// bindings are generated by ONE pinned ubrn. A split resolves green on CI and
// fails at runtime (or, on Android, during symbol extraction).
function lockedUniffiVersion(lockPath) {
  let text;
  try {
    text = readFileSync(lockPath, 'utf8');
  } catch {
    violations.push(`  ${lockPath}:0  [${RUST_PROV}]  Cargo.lock not found — the cross-crate uniffi parity check would pass vacuously`);
    return null;
  }
  const m = /^name = "uniffi"\nversion = "([^"]+)"/m.exec(text);
  if (!m) {
    violations.push(`  ${lockPath}:0  [${RUST_PROV}]  no resolved \`uniffi\` package — the cross-crate uniffi parity check would pass vacuously`);
    return null;
  }
  return m[1];
}
const SIGNAL_UNIFFI = lockedUniffiVersion(`${CRATE_REL}/Cargo.lock`);
const ARCHIVE_UNIFFI = lockedUniffiVersion(`${ARCHIVE_CRATE_REL}/Cargo.lock`);
if (SIGNAL_UNIFFI !== null && ARCHIVE_UNIFFI !== null && SIGNAL_UNIFFI !== ARCHIVE_UNIFFI) {
  violations.push(`  ${ARCHIVE_CRATE_REL}/Cargo.lock:0  [${RUST_PROV}]  uniffi resolves to ${ARCHIVE_UNIFFI} here but ${SIGNAL_UNIFFI} in ${CRATE_REL}/Cargo.lock — one pinned uniffi-bindgen-react-native generates bindings for both crates, so the versions must be identical (#920)`);
}

// --- A crate installed in more than one place must be pinned to ONE version.
// cargo-ndk is installed by both build.yml (hosted Android job) and
// scripts/build-android.sh (the local path that cuts SHIPPED builds); a split
// would compile store binaries with a linker nobody tested in CI.
for (const [crate, byVersion] of cargoInstallPins) {
  if (byVersion.size > 1) {
    const detail = [...byVersion.entries()]
      .map(([version, sites]) => `${version} (${sites.join(', ')})`)
      .join(' vs ');
    violations.push(`  ${[...byVersion.values()][0][0]}  [${RUST_PROV}]  \`cargo install ${crate}\` is pinned to more than one version: ${detail}`);
  }
}

// --- ubrn's own cargo passthrough must carry --locked on BOTH platforms, in
// EVERY ubrn config. Defence in depth: ubrn 0.31.0-2 runs an unlocked
// `cargo metadata` first, so the raw workflow lines above remain the real gate.
//
// A LIST since #920, not one path: with two packages a single-file check says
// nothing about the second, and the second is the one whose binary parses
// hostile bytes. Each row also carries the files `--and-generate` must not
// overwrite — `noOverwrite` is the only thing standing between a routine
// regeneration and the silent deletion of hand-written code:
//
//   OrbitalArchiveReaderPackage.kt   registers BOTH TurboModules; ubrn's
//     template registers only its own, so a regeneration without this entry
//     makes the hand-written glue module "not found" at runtime, with nothing
//     in the build log.
//   AndroidManifestNew.xml           the AGP 8+ manifest the GENERATED gradle
//     points `manifest.srcFile` at, and the one asserted permission-free by
//     rule 29. ubrn does not render it today; listed so a future ubrn that
//     starts cannot replace it with a `package=`-bearing default.
//   OrbitalArchiveReader.podspec     hand-edited `s.frameworks` (UIKit,
//     UniformTypeIdentifiers) for the glue module. ubrn's template has no
//     frameworks line, so a regeneration drops the link flags and the pod
//     fails to link UTTypeZIP.
//
// COMMENTS ARE STRIPPED FIRST, and that is load-bearing twice over: this very
// config documents all three noOverwrite entries in a `#` comment block
// immediately above the list, and a `# cargoExtras: ["--locked"]` line would
// otherwise satisfy the --locked pin while the real key was gone (the same trap
// as rule 29's mutation 29-18). YAML uses shell comment syntax.
const UBRN_CONFIGS = [
  [`${PKG_REL}/ubrn.config.yaml`, 'orbital_signal', []],
  [
    `${ARCHIVE_PKG_REL}/ubrn.config.yaml`,
    'orbital_archive_reader',
    [
      'OrbitalArchiveReaderPackage.kt',
      'AndroidManifestNew.xml',
      'OrbitalArchiveReader.podspec',
    ],
  ],
];
for (const [config, crate, noOverwrite] of UBRN_CONFIGS) {
  let ubrnText;
  try {
    ubrnText = stripShellComments(readFileSync(config, 'utf8'));
  } catch {
    violations.push(`  ${config}:0  [${RUST_PROV}]  ${crate}'s ubrn config not found — cannot verify cargoExtras`);
    continue;
  }
  for (const platform of ['ios', 'android']) {
    // Platform block = from `^<platform>:` to the next top-level key, or to
    // the absolute end of file — `(?![\s\S])`, since JS has no \Z and `$`
    // under /m would stop at the first newline.
    const block = new RegExp(`^${platform}:\\n([\\s\\S]*?)(?=^\\S|(?![\\s\\S]))`, 'm').exec(ubrnText);
    if (!block) {
      violations.push(`  ${config}:0  [${RUST_PROV}]  no \`${platform}:\` block — cannot verify its cargoExtras`);
      continue;
    }
    const extras = /^\s+cargoExtras:\s*(.+)$/m.exec(block[1]);
    if (!extras) {
      violations.push(`  ${config}:0  [${RUST_PROV}]  \`${platform}:\` block has no cargoExtras — ubrn would cargo build unlocked`);
    } else if (!extras[1].includes('--locked')) {
      violations.push(`  ${config}:0  [${RUST_PROV}]  \`${platform}: cargoExtras\` does not contain --locked: ${extras[1].trim()}`);
    }
  }
  if (noOverwrite.length === 0) continue;
  const list = /^noOverwrite:\n([\s\S]*?)(?=^\S|(?![\s\S]))/m.exec(ubrnText);
  if (!list) {
    violations.push(`  ${config}:0  [${RUST_PROV}]  no \`noOverwrite:\` list — \`ubrn build --and-generate\` would rewrite ${crate}'s hand-written package files (${AR_ISSUE})`);
    continue;
  }
  for (const name of noOverwrite) {
    if (!list[1].includes(name)) {
      violations.push(`  ${config}:0  [${RUST_PROV}]  \`noOverwrite\` no longer lists \`${name}\` — the next \`ubrn build --and-generate\` overwrites it with the template version (${AR_ISSUE})`);
    }
  }
}

// --- Freshness-input parity between the two staleness gates. They are
// deliberately ASYMMETRIC in mechanism (Android: mtime vs the oldest .a, with
// the `orbital.autoRebuildRust` auto-rebuild hatch; iOS: sha256 digest, fail
// closed, no hatch) but must agree on WHICH inputs make a binary stale.
// ubrn.config.yaml and packages/orbital-signal/package.json are iOS-only
// inputs: they select the xcframework slices and pin the ubrn toolchain, and
// Android has no equivalent, so neither is required on the Android side.
//
// Comments are stripped FIRST. Before that (PR #859 review) the raw-text
// includes() was satisfied by each gate's own header comment, so deleting
// `Cargo.lock` from the digest script's FIXED_INPUTS stayed green. The two
// EXEC_ANCHORS below make the same point for the comparison code itself:
// gutting the gradle gate's staleness arithmetic, or the digest script's
// hashing, now fires even though the path literals survive.
//
// SCOPE: this proves both gates NAME the inputs in executable code. That they
// USE them is proven behaviourally by scripts/test-rust-profile-gate-ios.sh
// (F1-F7, F15-F18) on the iOS side; the Android harness is profile-only, so
// Android's USE is unproven — see the follow-up candidate on PR #859.
function stripShellComments(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => {
      const hashAt = line.search(/\s#/);
      return hashAt >= 0 ? line.slice(0, hashAt) : line;
    })
    .join('\n');
}

function stripCStyleComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

// Comment stripper for GROOVY (.gradle), where stripCStyleComments is actively
// unsafe and was silently eating most of this repo's Android freshness gate.
//
// Groovy has two constructs C does not: the slashy regex literal
// (it.name ==~ /(assemble|bundle)\w*Release\w*/) and Ant-style glob strings
// (include '**' + '/*.rs'). The glob contains a slash-star, and the slashy
// literal ENDS in a star-slash, so the non-greedy block-comment regex opened at
// the first glob (line 96) and closed at the next regex literal (line 173) —
// blanking 77 lines of EXECUTABLE code in between, which included the whole
// second task's input list. The #920 archive rows failed on a file that plainly
// named every input; that is how this was found. Nothing in the file is written
// as a JSDoc block here for the same reason: a star-slash inside the prose
// closes the comment early.
//
// So: block comments are recognised only in the shape every gradle file in this
// repo actually writes them — a line whose first non-space characters open the
// comment, closed by a line containing the terminator — and `//` starts a
// comment only at the beginning of a line or after whitespace, never mid-token.
function stripGroovyComments(text) {
  const out = [];
  let inBlock = false;
  for (const line of text.split('\n')) {
    if (inBlock) {
      if (line.includes('*/')) inBlock = false;
      out.push('');
      continue;
    }
    if (/^\s*\/\*/.test(line)) {
      if (!line.includes('*/')) inBlock = true;
      out.push('');
      continue;
    }
    out.push(line.replace(/(^|\s)\/\/.*$/, '$1'));
  }
  return out.join('\n');
}

const FRESHNESS_GATES = [
  {
    file: 'android/check-rust-freshness.gradle',
    label: 'Android mtime gate',
    strip: stripGroovyComments,
    // The gradle gate composes its src path from a projectRoot variable, so
    // match the tail rather than the full relpath.
    names: ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'orbital_signal/src'],
    execAnchors: [
      ["tasks.register('checkRustBinaries')", 'the signal crate has no gradle staleness task at all'],
      ['staleFiles.add', 'it no longer records any stale input'],
      ['lastModified', 'it no longer compares timestamps'],
    ],
  },
  {
    file: 'scripts/rust-input-digest.sh',
    label: 'iOS digest gate',
    strip: stripShellComments,
    names: ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', `${CRATE_REL}/src`, 'ubrn.config.yaml', `${PKG_REL}/package.json`],
    execAnchors: [['shasum -a 256', 'it no longer hashes anything']],
  },
  // --- The second crate, #920. Its two gates are a MATCHED PAIR and the rows
  // below name the SAME SIX inputs on both sides, which is the whole point:
  // the iOS digest and the Android mtime task must agree on what makes
  // orbital_archive_reader's binaries stale, or one platform ships a .a built
  // from source nobody is looking at any more.
  //
  // Full relpaths here, not tails: unlike the signal rows (whose `Cargo.toml`
  // tail would be satisfied by EITHER crate's path) these have to pin the
  // archive crate specifically, now that two crates' paths are in play.
  //
  // The archive pair is deliberately STRONGER than signal's: it also watches
  // the package's ubrn.config.yaml (target list + cargoExtras) and package.json
  // (the exact ubrn pin and the build command lines), either of which changes
  // the compiled .a with no .rs edit at all. Widening signal's narrower
  // historical set to match is DEBT-408, not this PR.
  {
    file: 'android/check-rust-freshness.gradle',
    label: 'Android mtime gate (archive crate)',
    strip: stripGroovyComments,
    names: [
      `${ARCHIVE_CRATE_REL}/src`,
      `${ARCHIVE_CRATE_REL}/Cargo.toml`,
      `${ARCHIVE_CRATE_REL}/Cargo.lock`,
      'rust-toolchain.toml',
      `${ARCHIVE_PKG_REL}/ubrn.config.yaml`,
      `${ARCHIVE_PKG_REL}/package.json`,
    ],
    execAnchors: [
      ["tasks.register('checkArchiveRustBinaries')", 'the second crate has no gradle staleness task at all'],
      ['staleFiles.add', 'it no longer records any stale input'],
      ['lastModified', 'it no longer compares timestamps'],
    ],
  },
  {
    file: 'scripts/rust-input-digest-archive.sh',
    label: 'iOS digest gate (archive crate)',
    strip: stripShellComments,
    names: [
      `${ARCHIVE_CRATE_REL}/src`,
      `${ARCHIVE_CRATE_REL}/Cargo.toml`,
      `${ARCHIVE_CRATE_REL}/Cargo.lock`,
      'rust-toolchain.toml',
      `${ARCHIVE_PKG_REL}/ubrn.config.yaml`,
      `${ARCHIVE_PKG_REL}/package.json`,
    ],
    execAnchors: [['shasum -a 256', 'it no longer hashes anything']],
  },
];

for (const gate of FRESHNESS_GATES) {
  let text;
  try {
    text = readFileSync(gate.file, 'utf8');
  } catch {
    violations.push(`  ${gate.file}:0  [${RUST_PROV}]  ${gate.label} not found — freshness-input parity cannot be verified`);
    continue;
  }
  const code = gate.strip(text);
  for (const needle of gate.names) {
    if (!code.includes(needle)) {
      violations.push(`  ${gate.file}:0  [${RUST_PROV}]  ${gate.label} does not name the freshness input \`${needle}\` in executable code (comments stripped) — the two gates have drifted apart`);
    }
  }
  for (const [anchor, why] of gate.execAnchors) {
    if (!code.includes(anchor)) {
      violations.push(`  ${gate.file}:0  [${RUST_PROV}]  ${gate.label} no longer contains \`${anchor}\` — ${why}, so its input list would be decorative`);
    }
  }
}

// --- One marker writer, exercised on a PR. The writer previously existed in
// three copies (both npm scripts + the harness fake tree) and build-ios is
// main-only, so drift between them was invisible until after merge.
const MARKER_WRITER = 'scripts/write-rust-marker-ios.sh';
// Each row is [file, scriptKeyFilter, needles[], why].
//
// `scriptKeyFilter` is non-null for package.json callers and it is load-bearing:
// a whole-file `includes('write-rust-marker-ios.sh')` was satisfied by BOTH
// packages' own `comment:marker` script, which is prose describing the writer.
// Replacing the real `build:ios` command with a hand-rolled `echo release > …`
// left this check green (found by the #920 mutation sweep, row M1). So only the
// values of the scripts whose KEY matches are searched, and a filter matching
// no key at all is itself a violation.
//
// The needles carry the CRATE SELECTOR, not just the writer name, and they are
// END-ANCHORED (next token is end-of-command or a shell operator) in BOTH
// directions. The archive package must call `… <profile> archive`: without the
// selector the writer defaults to signal (F13 keeps the argument optional so
// every pre-#920 call site still works), so an archive build would overwrite
// the SIGNAL marker with the archive digest. The anchor is what catches the
// MIRROR mistake: a bare `… debug` substring is a prefix of `… debug archive`,
// so without it, adding `archive` to the SIGNAL package's build:ios read as
// green while signal builds wrote the archive crate's marker (#920 sweep, M5).
const MARKER_WRITER_CALLERS = [
  [
    `${PKG_REL}/package.json`,
    /^build:ios/,
    [
      ['write-rust-marker-ios.sh debug', /write-rust-marker-ios\.sh debug(?=\s*($|&&|\|\||;))/m],
      ['write-rust-marker-ios.sh release', /write-rust-marker-ios\.sh release(?=\s*($|&&|\|\||;))/m],
    ],
    'the build:ios[:release] scripts no longer call the shared marker writer for the SIGNAL crate (no selector, or the archive one)',
  ],
  [
    `${ARCHIVE_PKG_REL}/package.json`,
    /^build:ios/,
    [
      ['write-rust-marker-ios.sh debug archive', /write-rust-marker-ios\.sh debug archive(?=\s*($|&&|\|\||;))/m],
      ['write-rust-marker-ios.sh release archive', /write-rust-marker-ios\.sh release archive(?=\s*($|&&|\|\||;))/m],
    ],
    "the archive package's build:ios[:release] scripts no longer call the shared marker writer with its `archive` selector, so its marker would describe the wrong crate (or carry no digest at all, which verify-rust-profile-ios.sh archive reads as stale)",
  ],
  [
    'scripts/test-rust-profile-gate-ios.sh',
    null,
    [['write-rust-marker-ios.sh', /write-rust-marker-ios\.sh/]],
    'the harness no longer exercises the real marker writer, so writer drift would not surface on a PR',
  ],
];
try {
  statSync(MARKER_WRITER);
  for (const [caller, keyFilter, needles, why] of MARKER_WRITER_CALLERS) {
    let haystack;
    try {
      const text = readFileSync(caller, 'utf8');
      if (keyFilter === null) {
        haystack = text;
      } else {
        const scripts = JSON.parse(text).scripts ?? {};
        const matched = Object.keys(scripts).filter((k) => keyFilter.test(k));
        if (matched.length === 0) {
          violations.push(`  ${caller}:0  [${RUST_PROV}]  no script key matching ${keyFilter} — ${why}`);
          continue;
        }
        haystack = matched.map((k) => scripts[k]).join('\n');
      }
    } catch {
      violations.push(`  ${caller}:0  [${RUST_PROV}]  expected marker-writer caller not found or unreadable — ${why}`);
      continue;
    }
    for (const [label, needle] of needles) {
      if (!needle.test(haystack)) {
        violations.push(`  ${caller}:0  [${RUST_PROV}]  no executable \`${label}\` call — ${why}`);
      }
    }
  }
} catch {
  violations.push(`  ${MARKER_WRITER}:0  [${RUST_PROV}]  the shared iOS marker writer is missing — build:ios and the harness would each need their own copy again`);
}

// ---------------------------------------------------------------------------
// 19. Pre-bootstrap modules stay pure (#771)
// ---------------------------------------------------------------------------

// index.js calls registerBackgroundPushHandlers() at bundle load, so
// backgroundPush.ts and EVERYTHING IT REACHES synchronously execute BEFORE
// bootstrap: encrypted MMKV is not open, the database is not initialized, and
// on Android the background message handler can run in a headless JS context
// where the React tree never mounts. A store, MMKV, keychain, database, API,
// SQLCipher or telemetry import anywhere in that closure either throws at
// module init (dropping every killed-state push, including the
// identity_key_reset security tripwire) or — the quieter failure — reads
// uninitialized state: zustand/persist hydrates from an empty MMKV, so the
// module sees default prefs and can later clobber the real persisted state.
// The module headers say so; this rule is what enforces it.
//
// The closure today is FOUR app modules:
//   src/services/backgroundPush.ts        the entry point (root of the walk)
//   src/services/notificationConstants.ts titles/channel + pure payload helpers
//   src/navigation/navigationRef.ts       module-scope createNavigationContainerRef()
//                                         plus the pending-payload queue
//   src/services/websocket/lruSet.ts      a pure data structure, zero imports
//
// Rather than trust that list, the check WALKS the closure: starting at
// backgroundPush.ts it follows first-party relative value imports
// transitively, requires every reached src/ module to be in
// PRE_BOOTSTRAP_PURE, and scans each one for forbidden imports. Both
// directions fire: a module reached but not allowlisted is a violation (so
// adding an import to this graph is a deliberate, reviewed act), and an
// allowlisted module no longer reachable from the root is a violation too (so
// the allowlist cannot rot into decoration).
//
// KNOWN GAPS, latent but not silent:
//   - Third-party packages are judged by specifier only (PB_FORBIDDEN). A
//     package that itself opens MMKV or SQLite is invisible here; the notifee,
//     RNFB and @react-navigation imports in the closure today are native-module
//     façades that touch neither.
//   - A require()/import() with a non-literal specifier is invisible. There
//     are none in the closure.
//   - `import { type A } from 'x'` is treated as a value import — deliberately
//     conservative; hoist it to `import type` to silence it.
const PB_RULE = 'pre-bootstrap-pure';
const PB_ROOT = join(SRC, 'services', 'backgroundPush.ts');
const PRE_BOOTSTRAP_PURE = new Set([
  PB_ROOT,
  join(SRC, 'services', 'notificationConstants.ts'),
  join(SRC, 'navigation', 'navigationRef.ts'),
  join(SRC, 'services', 'websocket', 'lruSet.ts'),
]);

// Matched against the module specifier of every executing import/require.
// Each path pattern ends on slash-or-END so the barrel form ('../stores',
// '../database', './api') cannot walk past it — that bypass was the blocking
// finding on PR #860, and `from '../stores'` is the dominant idiom in this
// repo. `api` is matched on any segment rather than as `services/api/` so the
// intra-services relative form ('./api', './api/tokenManager') is covered too.
const PB_FORBIDDEN = [
  [/(^|\/)stores(\/|$)/, 'a Zustand store module'],
  [/useAppStore/, 'the app store'],
  [/(^|\/)database(\/|$)/, 'the SQLCipher database layer'],
  [/(^|\/)(?<!types\/)api(\/|$)/, 'the API client layer'], // types/api.ts is the pure wire-type contract, not the client
  [/^react-native-mmkv$/, 'encrypted MMKV'],
  [/^react-native-keychain$/, 'the keychain'],
  [/^@op-engineering\/op-sqlite$/, 'SQLCipher via op-sqlite'],
  [/secure-storage/, 'secure storage'],
  [/telemetry/i, 'telemetry'], // case-insensitive: ./uploadTelemetry must fire
];

// `import type … from 'x'` and `export type … from 'x'` are erased, so they
// cannot execute anything. Every other form can — including `export { x } from
// 'y'` and `export * from 'y'`, which evaluate the target module just as an
// import does. Specifiers may be single-quoted, double-quoted or backticked.
const PB_SPEC = String.raw`['"\x60]([^'"\x60]+)['"\x60]`;
const pbRe = (body, flags = 'gm') => new RegExp(body, flags);
const PB_IMPORT_RES = [
  // [0] type-only import — recorded, then skipped.
  pbRe(String.raw`(?:^|;)[ \t]*import\s+type\s[\s\S]*?from\s*` + PB_SPEC),
  // executing forms
  pbRe(String.raw`(?:^|;)[ \t]*import\s[\s\S]*?from\s*` + PB_SPEC),
  pbRe(String.raw`(?:^|;)[ \t]*import\s*` + PB_SPEC),
  // re-exports: only `export *`/`export * as ns`/`export { … }` forms, which
  // excludes `export type { … } from` without needing a skip entry.
  pbRe(String.raw`(?:^|;)[ \t]*export\s+(?:\*(?:\s+as\s+\w+)?|\{[\s\S]*?\})\s*from\s*` + PB_SPEC),
  pbRe(String.raw`\brequire\s*\(\s*` + PB_SPEC + String.raw`\s*\)`, 'g'),
  pbRe(String.raw`\bimport\s*\(\s*` + PB_SPEC + String.raw`\s*\)`, 'g'),
];

// Blank out comments while preserving line numbering — the module headers
// discuss imports in prose (including the bare side-effect import form that
// Metro's inlineRequires makes unsafe), and that prose must not be scanned as
// code.
function blankComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/[^\n]*/gm, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

/** Executing imports in `source` as specifier -> first line, type-only excluded. */
function pbExecutingImports(source) {
  const typeOnly = new Set();
  const found = new Map();
  for (let r = 0; r < PB_IMPORT_RES.length; r++) {
    const re = new RegExp(PB_IMPORT_RES[r].source, PB_IMPORT_RES[r].flags);
    let m;
    while ((m = re.exec(source)) !== null) {
      const spec = m[1];
      const line = source.slice(0, m.index).split('\n').length;
      if (r === 0) {
        typeOnly.add(`${spec}:${line}`);
      } else if (!typeOnly.has(`${spec}:${line}`) && !found.has(spec)) {
        found.set(spec, line);
      }
    }
  }
  return found;
}

/** Resolve a relative specifier to a .ts/.tsx file, or null. */
function pbResolve(importer, spec) {
  const base = join(dirname(importer), spec);
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (!/\.tsx?$/.test(cand)) continue;
    try {
      if (statSync(cand).isFile()) return cand;
    } catch {
      /* next candidate */
    }
  }
  return null;
}

const pbSeen = new Set();
const pbQueue = [PB_ROOT];
while (pbQueue.length > 0) {
  const file = pbQueue.shift();
  if (pbSeen.has(file)) continue;
  pbSeen.add(file);

  let source;
  try {
    source = blankComments(readFileSync(file, 'utf8'));
  } catch {
    // Non-vacuity: a renamed or deleted module in the closure must not make
    // the purity rule pass by scanning nothing.
    violations.push(
      `  ${relative('.', file)}:0  [${PB_RULE}]  pre-bootstrap module not found — update PRE_BOOTSTRAP_PURE instead of leaving a vacuous rule`,
    );
    continue;
  }

  for (const [spec, line] of pbExecutingImports(source)) {
    // First match only — several patterns can describe one specifier
    // ('../stores/useAppStore' is both), and one import is one violation.
    const hit = PB_FORBIDDEN.find(([re]) => re.test(spec));
    if (hit) {
      report(
        file,
        line,
        PB_RULE,
        `pre-bootstrap module imports ${hit[1]} ('${spec}') — it runs before bootstrap (no MMKV, no database) and may run headless`,
      );
    }
    if (!spec.startsWith('.')) continue; // third-party: specifier check only

    const target = pbResolve(file, spec);
    if (target === null) {
      report(
        file,
        line,
        PB_RULE,
        `first-party import '${spec}' does not resolve to a .ts/.tsx module — the pre-bootstrap closure cannot be verified through it`,
      );
    } else if (!PRE_BOOTSTRAP_PURE.has(target)) {
      report(
        file,
        line,
        PB_RULE,
        `pulls ${relative('.', target)} into the pre-bootstrap closure but it is not in PRE_BOOTSTRAP_PURE — add it there (and keep it pure) or drop the import`,
      );
    } else {
      pbQueue.push(target);
    }
  }
}

// Non-vacuity: every allowlisted module must still be reachable from the root,
// so the allowlist cannot outlive the closure it describes.
for (const file of PRE_BOOTSTRAP_PURE) {
  if (!pbSeen.has(file)) {
    violations.push(
      `  ${relative('.', file)}:0  [${PB_RULE}]  allowlisted but no longer reachable from ${relative('.', PB_ROOT)} — prune the allowlist entry instead of leaving it as decoration`,
    );
  }
}

// Non-vacuity: the allowlist only describes reality while index.js still
// reaches backgroundPush.ts at bundle load. If that call goes away, this rule
// is guarding modules that are no longer pre-bootstrap, and the allowlist
// should be deleted rather than left as decoration.
try {
  const entry = blankComments(readFileSync('index.js', 'utf8'));
  if (!/registerBackgroundPushHandlers\s*\(\s*\)/.test(entry)) {
    violations.push(
      `  index.js:0  [${PB_RULE}]  index.js no longer calls registerBackgroundPushHandlers() — the pre-bootstrap purity allowlist no longer describes the entry path`,
    );
  }
} catch {
  violations.push(
    `  index.js:0  [${PB_RULE}]  entry point not found — cannot verify the pre-bootstrap purity allowlist still describes the entry path`,
  );
}

// ---------------------------------------------------------------------------
// 20. Validation messages come from the client's allowlist, never the server
//     (#783)
// ---------------------------------------------------------------------------

// A 400/422 body carries both a machine-readable `details.code` and a free-text
// `message` written for developers. The client shows copy IT owns, selected by
// the code; the server's text stays in `serverMessage`, which is __DEV__-only.
//
// Every plausible regression here is a one-line edit that leaves the app
// working and the tests mostly green, while putting server text — or a value
// reached through the prototype chain — on a user's screen:
//   - `super(JSON.parse(rawBody).message, …)` or a later `this.message = …`
//     override: the specific error now shows, so the feature looks MORE
//     correct, which is exactly why no screen test catches it.
//   - an allowlist weakened to `typeof code === 'string'`, or a truthy
//     `MESSAGES[code]` lookup: `__proto__`/`constructor`/`toString` then index
//     the map and render `[object Object]` or a function body.
//   - `serverMessage ?? message` anywhere on the path, which re-opens the
//     __DEV__ gate for the one error class a user sees most often.
//   - a screen reading `e.serverMessage` directly, bypassing this layer.
//
// The first four are window pins on errors.ts; the last is a cross-file scan.
// Unit tests cover the behaviour for inputs we thought of — these pins cover
// the SHAPE, so a future edit cannot quietly reintroduce the 2026-09-06 class
// of bug (#777) by a different route.

const VMP_RULE = 'validation-message-provenance';
const ERRORS_FILE = join(SRC, 'services', 'api', 'errors.ts');
const VMP_ISSUE = '#783';

// Window A — the ValidationError class. Short, independent pins: the message
// must be chosen by indexing the client's own map, and the no-code fallback
// must still be the generic string. Forbidden: any body parsing or message
// assignment inside the class (parsing belongs to parseValidationReason, which
// returns an allowlisted enum, not text), and any expression that could put the
// raw body in the message position. The constructor parameter is `rawBody`, so
// the forbidden list names that identifier: `rawBody ?? 'Invalid request'` and
// `cond ? rawBody : …` are the realistic one-line leaks. The legitimate uses —
// `rawBody?: string`, `parseValidationReason(rawBody)` and the bare `rawBody,`
// pass-through to ApiError — contain none of these substrings.
checkWindowedPins(
  ERRORS_FILE,
  VMP_RULE,
  /^export class ValidationError extends ApiError \{[\s\S]*?\n\}/m,
  'the ValidationError class',
  ['VALIDATION_REASON_MESSAGES[', "'Invalid request'"],
  ['.message =', 'JSON.parse(', 'rawBody ?', 'rawBody |', '? rawBody', ': rawBody'],
  VMP_ISSUE,
);

// Window B — the body parser. It may parse, but every candidate code must pass
// the allowlist before it can be returned.
checkWindowedPins(
  ERRORS_FILE,
  VMP_RULE,
  /^function parseValidationReason[\s\S]*?\n\}/m,
  'the parseValidationReason body',
  ['isValidationReason('],
  [],
  VMP_ISSUE,
);

// Window B2 — the allowlist test itself. `hasOwnProperty.call` on the map is
// the whole defence: `in`, a truthy lookup, or a bare typeof check all accept
// prototype keys.
checkWindowedPins(
  ERRORS_FILE,
  VMP_RULE,
  /^function isValidationReason[\s\S]*?\n\}/m,
  'the isValidationReason body',
  ['hasOwnProperty.call(VALIDATION_REASON_MESSAGES'],
  [],
  VMP_ISSUE,
);

// Windows B3/B4 — the SAME allowlist discipline for the 409 `REWRAP_REFUSED`
// refusal code (#912). The shape is identical to Windows B/B2 and so is the
// leak: the code is reported as the `group_key_refusal` Sentry tag and routes
// the self-heal state machine, so an unknown value must become the client's own
// `'unrecognized'` sentinel rather than the server's string, and the membership
// test must be `hasOwnProperty.call` so `__proto__`/`constructor`/`toString`
// cannot pass as refusal codes.
const RRC_ISSUE = '#912';

checkWindowedPins(
  ERRORS_FILE,
  VMP_RULE,
  /^function parseRefusalCode[\s\S]*?\n\}/m,
  'the parseRefusalCode body',
  ['isRewrapRefusalCode(', "'unrecognized'"],
  [],
  RRC_ISSUE,
);

checkWindowedPins(
  ERRORS_FILE,
  VMP_RULE,
  /^function isRewrapRefusalCode[\s\S]*?\n\}/m,
  'the isRewrapRefusalCode body',
  ['hasOwnProperty.call(REWRAP_REFUSAL_CODES'],
  [],
  RRC_ISSUE,
);

// Window C — the __DEV__ gate on the raw body, for every error class. Curated
// copy is only safe to show because the server's own text never leaves dev.
checkWindowedPins(
  ERRORS_FILE,
  VMP_RULE,
  /^export class ApiError extends Error \{[\s\S]*?\n\}/m,
  'the ApiError class (serverMessage __DEV__ gate)',
  ['this.serverMessage = __DEV__ ? serverMessage : undefined'],
  [],
  VMP_ISSUE,
);

// Cross-file clause — `serverMessage` is readable only inside errors.ts. The
// bare identifier is matched (not just `.serverMessage`) so destructuring
// (`const { serverMessage } = e`) and bracket access (`e['serverMessage']`)
// are caught too.
// Comments are blanked first (not skipped by line) because three modules
// discuss the field in prose: telemetry.ts, telemetryScrub.ts and
// notificationSettingsSync.ts all name `ApiError.serverMessage` while
// explaining why they do not read it, and that prose must not be scanned as
// code. Tests are out of scope: they assert the __DEV__ behaviour, which means
// reading the field is their job.
const VMP_SERVER_MESSAGE_RE = /\bserverMessage\b/;

for (const file of allFiles) {
  if (file === ERRORS_FILE) continue;
  if (file.includes('__tests__') || file.includes('.test.')) continue;

  let lines;
  try {
    lines = blankComments(readFileSync(file, 'utf8')).split('\n');
  } catch {
    violations.push(`  ${relative('.', file)}:0  [${VMP_RULE}]  could not read file`);
    continue;
  }
  for (let i = 0; i < lines.length; i++) {
    if (VMP_SERVER_MESSAGE_RE.test(lines[i])) {
      report(
        file,
        i + 1,
        VMP_RULE,
        `reads ApiError.serverMessage outside errors.ts — it holds raw server text and is __DEV__-only, so this is empty in release builds; route on the error class (or ValidationError.reason) and render e.message instead (${VMP_ISSUE})`,
      );
    }
  }
}

// Non-vacuity anchor for the scan: the one allowed reader must still exist and
// must still hold the assignment. Without this, deleting or renaming errors.ts
// would make the cross-file clause pass by scanning a field nobody sets.
try {
  if (!VMP_SERVER_MESSAGE_RE.test(blankComments(readFileSync(ERRORS_FILE, 'utf8')))) {
    violations.push(
      `  ${relative('.', ERRORS_FILE)}:0  [${VMP_RULE}]  no serverMessage assignment left in errors.ts — the "only errors.ts may read it" carve-out describes nothing and the cross-file scan would pass vacuously (${VMP_ISSUE})`,
    );
  }
} catch {
  violations.push(
    `  ${relative('.', ERRORS_FILE)}:0  [${VMP_RULE}]  errors.ts not found — the validation-message provenance rules cannot be verified (${VMP_ISSUE})`,
  );
}

// ---------------------------------------------------------------------------
// 21. Media export: native write pins (#878)
// ---------------------------------------------------------------------------

// packages/orbital-media-export writes decrypted media OUT of the app, to the
// photo library and to a user-chosen destination. Four properties of that
// writer are plain text in two native files, are invisible to every JS test,
// and each one fails SILENTLY (the save still works) while changing what the
// app does to user data or to its App Store privacy posture:
//
//   1. `asCopy:YES` on the document picker. With asCopy:NO the picker hands
//      the FILE to the destination provider instead of a copy, and a provider
//      may move it — out of MEDIA_DIR, which is the app's durable archive
//      because the server may evict the ciphertext after confirmArchived.
//   2. Add-only photo access. PHAccessLevelReadWrite (or the deprecated
//      no-argument -authorizationStatus / -requestAuthorization:) prompts for
//      FULL library access: read of every photo the user owns, for a feature
//      that only ever adds. That is also the difference between needing
//      NSPhotoLibraryAddUsageDescription and needing the read usage string.
//   3. `shouldMoveFile`. PHAssetResourceCreationOptions can MOVE the source
//      into the library, deleting it. One line, no error, archive gone.
//   4. Required-reason APIs. The module calls none, which is the entire
//      argument for leaving ios/OrbitalMobile/PrivacyInfo.xcprivacy alone
//      (plan-review finding 7). A single -attributesOfItemAtPath: or statfs()
//      added later would make the shipped privacy manifest wrong, and App
//      Review catches that at submission, not here.
//
// On Android the property is "never touch the source": the writer copies into
// MediaStore (or the public directory on API 24-28) and must not delete or
// rename what it read.
//
// Both files are read as NAMED files — a missing one is a violation, not a
// pass — and the window is anchored on the file's own first line so that
// EVERY function, including the static helpers above @implementation, is
// scanned. checkWindowedPins strips comment lines and trailing comments, so a
// pin can never be satisfied by prose (this file's own header comment names
// every forbidden API, and that must not count as calling one).

const MEDIA_EXPORT_PKG = join('packages', 'orbital-media-export');
const MEDIA_EXPORT_MM = join(MEDIA_EXPORT_PKG, 'ios', 'OrbitalMediaExport.mm');
const MEDIA_EXPORT_KT = join(
  MEDIA_EXPORT_PKG,
  'android',
  'src',
  'main',
  'java',
  'com',
  'orbital',
  'mediaexport',
  'OrbitalMediaExportModule.kt',
);
const ME_ISSUE = '#878';
const ME_NATIVE_RULE = 'media-export-native-pins';

checkWindowedPins(
  MEDIA_EXPORT_MM,
  ME_NATIVE_RULE,
  /^#import "OrbitalMediaExport\.h"[\s\S]*/m,
  'OrbitalMediaExport.mm',
  [
    // The picker exports COPIES.
    'asCopy:YES',
    // Add-only on both the query and the request. Pinning the level to each
    // call site is what stops a decorative PHAccessLevelAddOnly elsewhere in
    // the file from satisfying the rule while the real call asks for more.
    'authorizationStatusForAccessLevel:PHAccessLevelAddOnly',
    'requestAuthorizationForAccessLevel:PHAccessLevelAddOnly',
    // The add path stays PhotoKit asset CREATION (no library mutation API).
    'PHAssetCreationRequest',
    // Aliasing is copy-on-write, not a byte copy of up to 50 MB per item.
    'clonefile(',
    // The picker is presented from RN's own top-most controller, which is what
    // lets it appear over the lightbox Modal.
    'RCTPresentedViewController()',
    // The staging directory NAME, pinned on the native side too (#879 review).
    // JS owns the sweep — localWipe and cleanupOrphanedChunks delete
    // `Caches/orbital-export` whole, pinned by `media-export-wipe-wired` — but
    // NATIVE owns the writes into it. Renaming it here alone would leave every
    // aliased plaintext copy in a directory no sweep looks at, surviving
    // logout and account deletion, and nothing else in the tree would notice.
    // checkWindowedPins strips comments, so the prose above cannot satisfy it.
    'orbital-export',
  ],
  [
    // 1-3 above. `setShouldMoveFile` is a SEPARATE pin because `includes()` is
    // case-sensitive: `[options setShouldMoveFile:YES]` is the exact semantic
    // equivalent of `options.shouldMoveFile = YES`, and the capital S after
    // `set` means the property-form pin does not match it. Found by mutation
    // test (case 5), not by reading the code — the same trap applies to every
    // ObjC property below.
    'shouldMoveFile',
    'setShouldMoveFile',
    'PHAccessLevelReadWrite',
    'requestAuthorization:',
    'authorizationStatus]',
    // 4: the required-reason API list from Apple's "File timestamp",
    // "Disk space", "System boot time" and "User defaults" categories that a
    // file writer would plausibly reach for. `stat(` also covers fstat(/lstat(
    // and `getattrlist` covers getattrlistbulk/fgetattrlist. The NSURL*Key
    // spellings are the -getResourceValue:forKey: route to the same data, and
    // the capitalised `VolumeAvailableCapacity` catches
    // NSURLVolumeAvailableCapacityKey (and the …ForImportantUsage variant),
    // which the camelCase pin alone would miss.
    'attributesOfItemAtPath',
    'NSFileSize',
    'NSFileCreationDate',
    'NSFileModificationDate',
    'NSURLCreationDateKey',
    'NSURLContentModificationDateKey',
    'getattrlist',
    'statfs',
    'statvfs',
    'NSFileSystemFreeSize',
    'volumeAvailableCapacity',
    'VolumeAvailableCapacity',
    'NSUserDefaults',
    'stat(',
  ],
  ME_ISSUE,
);

checkWindowedPins(
  MEDIA_EXPORT_KT,
  ME_NATIVE_RULE,
  /^package com\.orbital\.mediaexport[\s\S]*/m,
  'OrbitalMediaExportModule.kt',
  [
    // The three destinations the plan committed to: Pictures/Orbital,
    // Movies/Orbital, Download/Orbital (never DCIM, which is what
    // @react-native-camera-roll/camera-roll does on API 29+).
    'Environment.DIRECTORY_PICTURES',
    'Environment.DIRECTORY_MOVIES',
    'Environment.DIRECTORY_DOWNLOADS',
    // A half-written export is never visible in the gallery.
    'IS_PENDING',
    // API 24-28 placement depends on the scanner; without it the file exists
    // but no gallery shows it.
    'MediaScannerConnection.scanFile',
  ],
  [
    // Never delete or rename the source. Scope is honest: this catches the
    // realistic one-liners on the variable the writer actually holds
    // (`sourceFile`) and on a freshly constructed File(sourcePath). An alias
    // through a third variable would evade it — the code review and the
    // residue checks in the smoke matrix are the backstop there.
    'sourceFile.delete(',
    'sourceFile.renameTo(',
    'File(sourcePath).delete(',
    'File(sourcePath).renameTo(',
  ],
  ME_ISSUE,
);

// ---------------------------------------------------------------------------
// 22. iOS photo-library ADD usage description (#878)
// ---------------------------------------------------------------------------

// Without NSPhotoLibraryAddUsageDescription, -requestAuthorizationForAccessLevel:
// does not prompt — it CRASHES the app the first time a user taps Save. The
// existing NSPhotoLibraryUsageDescription does not cover the add-only level.
// Nothing in JS or in a unit test can observe the key, and CI never runs the
// app, so this static check is the only PR-time detector.
//
// XML comments are stripped first: a commented-out key must not satisfy it.

/**
 * Strip XML comments until none are left. One pass is not enough: removing
 * `<!-- a -->` from `<!<!-- a -->-- key -->` leaves a fresh `<!-- key -->`,
 * so a single replace can surface a comment it was meant to remove
 * (CodeQL js/incomplete-multi-character-sanitization). Shared by rules 22-23.
 */
function meStripXmlComments(text) {
  let previous;
  do {
    previous = text;
    text = text.replace(/<!--[\s\S]*?-->/g, '');
  } while (text !== previous);
  return text;
}

const ME_INFO_PLIST = join('ios', 'OrbitalMobile', 'Info.plist');
const ME_PLIST_RULE = 'ios-photo-add-usage';
const ME_PLIST_KEY = 'NSPhotoLibraryAddUsageDescription';

try {
  const plistText = meStripXmlComments(readFileSync(ME_INFO_PLIST, 'utf8'));
  const usage = plistText.match(
    new RegExp(`<key>${ME_PLIST_KEY}</key>\\s*<string>([\\s\\S]*?)</string>`),
  );
  if (usage === null) {
    violations.push(
      `  ${ME_INFO_PLIST}:0  [${ME_PLIST_RULE}]  no <key>${ME_PLIST_KEY}</key> followed by a <string> — the first add-only photo permission request crashes instead of prompting (${ME_ISSUE})`,
    );
  } else if (usage[1].trim().length === 0) {
    violations.push(
      `  ${ME_INFO_PLIST}:0  [${ME_PLIST_RULE}]  ${ME_PLIST_KEY} is empty — App Review rejects an empty purpose string, and iOS shows the user no reason (${ME_ISSUE})`,
    );
  }
} catch {
  violations.push(
    `  ${ME_INFO_PLIST}:0  [${ME_PLIST_RULE}]  Info.plist not found — the photo-library add usage string cannot be verified and the rule would pass vacuously (${ME_ISSUE})`,
  );
}

// ---------------------------------------------------------------------------
// 23. Android storage permissions stay scoped to API 24-28 (#878)
// ---------------------------------------------------------------------------

// The gallery save on Android 7-9 needs WRITE_EXTERNAL_STORAGE. Unscoped, that
// same declaration on API 29+ is a Play Data Safety problem (broad access to
// all shared storage) for a feature that only writes its own files, and the
// implied READ it drags in would let the app read every photo on the device.
// @dr.pogodin/react-native-fs declares WRITE unscoped, so the app manifest's
// maxSdkVersion + tools:replace is the only thing keeping the shipped manifest
// narrow — and a merge conflict there is silent.
//
// This rule reads the SOURCE manifest. The merged-manifest gate in
// .github/workflows/build.yml is the shipped-artefact check (it also proves
// the implied READ really was suppressed). Comments are stripped so a
// commented-out declaration cannot satisfy the rule.

const ME_APP_MANIFEST = join('android', 'app', 'src', 'main', 'AndroidManifest.xml');
const ME_MANIFEST_RULE = 'android-storage-scoped';
const ME_SCOPED_PERMISSIONS = [
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.READ_EXTERNAL_STORAGE',
];
// Permissions that must never be declared: each one widens the app past
// "write the files the user asked us to save".
const ME_FORBIDDEN_PERMISSIONS = [
  'READ_MEDIA_IMAGES',
  'READ_MEDIA_VIDEO',
  'READ_MEDIA_VISUAL_USER_SELECTED',
  'MANAGE_EXTERNAL_STORAGE',
];

try {
  const manifestText = meStripXmlComments(readFileSync(ME_APP_MANIFEST, 'utf8'));
  const elements = manifestText.match(/<uses-permission[\s\S]*?\/?>/g) ?? [];

  for (const permission of ME_SCOPED_PERMISSIONS) {
    const declarations = elements.filter((el) => el.includes(`"${permission}"`));
    if (declarations.length === 0) {
      violations.push(
        `  ${ME_APP_MANIFEST}:0  [${ME_MANIFEST_RULE}]  ${permission} is not declared — the API 24-28 gallery save needs it, and declaring it only in a library manifest makes it UNSCOPED in the merged manifest (${ME_ISSUE})`,
      );
      continue;
    }
    for (const declaration of declarations) {
      if (!/android:maxSdkVersion\s*=\s*"28"/.test(declaration)) {
        violations.push(
          `  ${ME_APP_MANIFEST}:0  [${ME_MANIFEST_RULE}]  ${permission} is declared without android:maxSdkVersion="28" — on API 29+ this is broad shared-storage access the app does not use (${ME_ISSUE})`,
        );
      }
    }
  }

  for (const permission of ME_FORBIDDEN_PERMISSIONS) {
    if (manifestText.includes(permission)) {
      violations.push(
        `  ${ME_APP_MANIFEST}:0  [${ME_MANIFEST_RULE}]  ${permission} must not be declared — saving writes only the app's own files and never reads shared storage (${ME_ISSUE})`,
      );
    }
  }
} catch {
  violations.push(
    `  ${ME_APP_MANIFEST}:0  [${ME_MANIFEST_RULE}]  app AndroidManifest.xml not found — the storage-permission scope cannot be verified and the rule would pass vacuously (${ME_ISSUE})`,
  );
}

// ---------------------------------------------------------------------------
// 24. Media export: the service/UI half (#878) — rules 1, 2, 3 and 7
// ---------------------------------------------------------------------------
//
// Kept as FIVE separate rules rather than folded into rule 21: the rule name is
// what the violation line prints, and "native-pins" must not start meaning
// "anything to do with export".
//
//   media-export-import-restricted  — only src/services/mediaExportService.ts
//                                     imports 'orbital-media-export', plus a
//                                     non-vacuity check that it still does.
//   media-export-disclosure-gate    — performExport() is the only native-WRITE
//                                     site, asserts the disclosure before that
//                                     write, and every exported entry point's
//                                     FIRST await is ensureExportDisclosure().
//   media-export-no-name-logging    — the service, the two pure leaves
//                                     (media/exportFileName.ts,
//                                     media/contentType.ts), the abort helper
//                                     (media/abortable.ts), the bulk runner
//                                     (media/bulkExportRunner.ts) and the
//                                     package's src/index.tsx +
//                                     src/NativeOrbitalMediaExport.ts carry no
//                                     file_name|fileName|displayName|localPath|
//                                     sourcePath|mediaId on a log or Sentry
//                                     line; the two pure leaves carry no
//                                     console/captureError/Sentry call AT ALL;
//                                     the normalizer never interpolates
//                                     the native message; the .mm/.kt contain
//                                     no NSLog|os_log|android.util.Log.
//   media-export-wipe-wired         — localWipe aborts exports before deleting
//                                     MEDIA_DIR, resets the bulk runner and
//                                     sweeps the staging dir;
//                                     cleanupOrphanedChunks sweeps it too; and
//                                     the BODIES of cancelAllExports and
//                                     resetBulkExportState are pinned, so an
//                                     emptied one cannot satisfy a call site.
//                                     #921 folds the Meta import teardown into
//                                     the same rule: localWipe calls
//                                     deleteAllImportJobs(, and
//                                     releaseAllPersistedParts( now runs ABOVE
//                                     the preserveIdentity branch (both paths),
//                                     while fullCryptoWipe drops import_jobs
//                                     inside its BEGIN IMMEDIATE transaction.
//   media-export-single-label-site  — buildExportFileName(, reconcileExportLabel(
//                                     and sniffExportHead( appear EXACTLY once
//                                     in mediaExportService.ts, all three inside
//                                     resolveExportLabel(), and none inside
//                                     performExport(); plus a TREE-WIDE importer
//                                     allowlist, so no second module can label
//                                     for itself (#881 Low).

const ME_SERVICE = join(SRC, 'services', 'mediaExportService.ts');
const ME_EXPORT_NAMES = join(SRC, 'services', 'media', 'exportFileName.ts');
const ME_CONTENT_TYPE = join(SRC, 'services', 'media', 'contentType.ts');
const ME_ABORTABLE = join(SRC, 'services', 'media', 'abortable.ts');
const ME_BULK_RUNNER = join(SRC, 'services', 'media', 'bulkExportRunner.ts');
const ME_IMAGE_SANITIZER = join(SRC, 'services', 'media', 'imageSanitizer.ts');
const ME_PKG_INDEX = join(MEDIA_EXPORT_PKG, 'src', 'index.tsx');
const ME_PKG_SPEC = join(MEDIA_EXPORT_PKG, 'src', 'NativeOrbitalMediaExport.ts');
const ME_AUTH_SERVICE = join(SRC, 'services', 'authService.ts');
const ME_UPLOAD_SERVICE = join(SRC, 'services', 'mediaUploadService.ts');
// #921: the OTHER wipe. `localWipe` is the account-level teardown;
// `fullCryptoWipe` is the key-generation teardown, and rule 24e's third arm
// pins the import-table drop inside its transaction.
const MIT_KEY_GEN_SERVICE = join(SRC, 'services', 'crypto', 'keyGenerationService.ts');
// #921: the THIRD teardown site. Key recovery runs `fullCryptoWipe` without
// ever going through `localWipe`, so the archive teardown has to be wired
// there separately — and pinned here, or the two paths drift apart.
const MIT_RECOVERY_SERVICE = join(SRC, 'services', 'keyRecoveryService.ts');

/**
 * The bulk runner (PR 2) is a REQUIRED file here, not an optional one.
 *
 * It was scanned-if-present through PR 1, because a file that exists in only
 * half of a two-PR delivery cannot be required without failing the first half.
 * PR 2 shipped it, so the conditional is gone: a missing file is now a
 * violation, which is the point — a rule that passes because its subject was
 * deleted is exactly the vacuity these checks exist to prevent.
 */

/** Read a file, recording a violation and returning null when it is missing. */
// `issue` defaults to the media-export issue this helper was written for, so
// its original callers are unchanged; rule 29 (#920) passes its own.
function meRead(file, rule, why, issue = ME_ISSUE) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    violations.push(
      `  ${relative('.', file)}:0  [${rule}]  file not found — ${why} cannot be verified and the rule would pass vacuously (${issue})`,
    );
    return null;
  }
}

/**
 * Blank out comments, PRESERVING line count and byte offsets so the index
 * comparisons below stay meaningful.
 *
 * This is what stops a pin from being satisfied by prose: every one of these
 * files documents the very identifiers the rules forbid (this script does
 * too), and a mention must never count as a call.
 *
 * STRING-AWARE, and that is not cosmetic. The previous version blanked from
 * the first `//` ANYWHERE on a line, which is NOT fail-safe in the direction
 * its comment claimed: over-stripping also hides a FORBIDDEN substring, so
 *
 *     console.warn('[mediaExport]', 'file://' + fileName);
 *
 * had everything from `file://` onwards blanked and
 * `media-export-no-name-logging` passed on a line that logs a user's file
 * name. `file://` is the repo's own idiom for every local media URI, so this
 * was reachable, not theoretical (#879 review; proven below in the mutation
 * matrix). The scanner now tracks `'`, `"` and backtick state and only treats
 * `//` or an inline block comment as a comment outside a string.
 *
 * HONEST SCOPE: quote state does not carry ACROSS lines, so a multi-line
 * template literal containing `//` would still be mis-scanned. None of the
 * named files has one, and the failure mode there is over-stripping within
 * that literal only. Escapes are honoured (`'a\\'b'`), regex literals are not
 * parsed (a `//` cannot appear in one — an empty regex is not valid syntax).
 */
function meStripComments(text) {
  let inBlock = false;
  return text
    .split('\n')
    .map((rawLine) => {
      let line = rawLine;
      if (inBlock) {
        const end = line.indexOf('*/');
        if (end === -1) return ' '.repeat(line.length);
        inBlock = false;
        line = ' '.repeat(end + 2) + line.slice(end + 2);
      }

      let quote = null;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];

        if (quote !== null) {
          if (ch === '\\') {
            i += 1;
            continue;
          }
          if (ch === quote) quote = null;
          continue;
        }

        if (ch === "'" || ch === '"' || ch === '`') {
          quote = ch;
          continue;
        }

        if (ch === '/' && line[i + 1] === '/') {
          return line.slice(0, i) + ' '.repeat(line.length - i);
        }

        if (ch === '/' && line[i + 1] === '*') {
          const end = line.indexOf('*/', i + 2);
          if (end === -1) {
            inBlock = true;
            return line.slice(0, i) + ' '.repeat(line.length - i);
          }
          // Blank the inline block comment in place; length is unchanged, so
          // every offset after it still lines up with the raw file.
          line = line.slice(0, i) + ' '.repeat(end + 2 - i) + line.slice(end + 2);
          i = end + 1;
          continue;
        }
      }
      return line;
    })
    .join('\n');
}

/** 1-based line number of a byte offset, for a useful violation line. */
function meLineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

// ---------------------------------------------------------------------------
// 24a. media-export-import-restricted
// ---------------------------------------------------------------------------

// The package is the ONLY code in the app that writes decrypted bytes to a
// destination outside the app's own sandbox. Keeping its import to one module
// is what makes every other rule here checkable at all: the disclosure gate,
// the name-logging ban and the wipe wiring all reason about ONE file. A second
// importer — including a barrel re-export, which is why the pattern matches
// `export … from` as well — would route around all three.

const ME_IMPORT_RULE = 'media-export-import-restricted';
const ME_PKG_SPECIFIER_RE =
  /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]orbital-media-export(?:\/[^'"]*)?['"]/;

let meImporterSeen = false;
for (const file of allFiles) {
  const rel = relative('.', file);
  // Test files may import the jest mock (the moduleNameMapper target) to drive
  // error branches — the same test-path exemption rule 3 uses.
  if (rel.includes('__tests__/') || rel.includes('.test.ts') || rel.includes('.test.tsx')) {
    continue;
  }

  const lines = meStripComments(readFileSync(file, 'utf8')).split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!ME_PKG_SPECIFIER_RE.test(lines[i])) continue;
    if (file === ME_SERVICE) {
      meImporterSeen = true;
      continue;
    }
    report(file, i + 1, ME_IMPORT_RULE, lines[i].trim());
  }
}

if (!meImporterSeen) {
  violations.push(
    `  ${relative('.', ME_SERVICE)}:0  [${ME_IMPORT_RULE}]  the one permitted importer no longer imports 'orbital-media-export' — the rule would pass vacuously (${ME_ISSUE})`,
  );
}

// ---------------------------------------------------------------------------
// 24b. media-export-disclosure-gate
// ---------------------------------------------------------------------------

// Two properties, neither observable from a passing unit test:
//
//  1. There is exactly ONE place where decrypted bytes leave the app, and the
//     disclosure acknowledgement is asserted there, synchronously, before the
//     call. A second write site added anywhere else in the service would be
//     reachable without the user ever having been told that a saved copy
//     leaves end-to-end encryption, survives logout, and may be swept into
//     their cloud backup.
//  2. Every exported entry point ASKS first, before it does any work. Not just
//     "somewhere in the function": its FIRST await must be the disclosure, so
//     a download cannot start — and therefore plaintext cannot be written to
//     MEDIA_DIR — on behalf of a save the user then cancels.
//
// `saveToPhotoLibrary(`/`exportFiles(` are the two native WRITES. The add-only
// permission query (`requestPhotoAddPermission`) also reaches native and is
// deliberately NOT in this set: it writes nothing, returns no user data, and
// must run before the download so the user is never asked for photo access in
// order to fetch a file they will not be allowed to save.

const ME_GATE_RULE = 'media-export-disclosure-gate';
const ME_NATIVE_WRITES = ['saveToPhotoLibrary(', 'exportFiles('];

const meServiceRaw = meRead(ME_SERVICE, ME_GATE_RULE, 'the export disclosure gate');
if (meServiceRaw !== null) {
  const body = meStripComments(meServiceRaw);
  const chokeRe = /^async function performExport\([\s\S]*?\n\}/m;
  const choke = body.match(chokeRe);

  if (choke === null) {
    violations.push(
      `  ${relative('.', ME_SERVICE)}:0  [${ME_GATE_RULE}]  performExport() not found — the native-write choke point is gone and the rule would pass vacuously (${ME_ISSUE})`,
    );
  } else {
    const chokeStart = choke.index;
    const chokeEnd = chokeStart + choke[0].length;
    const chokeBody = choke[0];

    const assertIdx = chokeBody.indexOf('assertDisclosureAcknowledged(');
    if (assertIdx === -1) {
      violations.push(
        `  ${relative('.', ME_SERVICE)}:${meLineOf(body, chokeStart)}  [${ME_GATE_RULE}]  performExport() does not call assertDisclosureAcknowledged( (${ME_ISSUE})`,
      );
    }
    // A prompt from inside the write path would be a modal in the wrong place
    // AND would make the assertion above unreachable in practice.
    if (chokeBody.includes('ensureExportDisclosure(')) {
      violations.push(
        `  ${relative('.', ME_SERVICE)}:${meLineOf(body, chokeStart)}  [${ME_GATE_RULE}]  performExport() must ASSERT the disclosure, never prompt for it (${ME_ISSUE})`,
      );
    }

    for (const write of ME_NATIVE_WRITES) {
      const inside = chokeBody.indexOf(write);
      if (inside === -1) {
        violations.push(
          `  ${relative('.', ME_SERVICE)}:${meLineOf(body, chokeStart)}  [${ME_GATE_RULE}]  "${write}" missing from performExport() — the choke point no longer writes and the rule would pass vacuously (${ME_ISSUE})`,
        );
      } else if (assertIdx !== -1 && assertIdx > inside) {
        violations.push(
          `  ${relative('.', ME_SERVICE)}:${meLineOf(body, chokeStart)}  [${ME_GATE_RULE}]  assertDisclosureAcknowledged( must precede "${write}" in performExport() (${ME_ISSUE})`,
        );
      }

      // Any occurrence OUTSIDE the choke point is a second write site. The
      // import statement is excluded by construction: it has no `(`.
      for (let at = body.indexOf(write); at !== -1; at = body.indexOf(write, at + 1)) {
        if (at >= chokeStart && at < chokeEnd) continue;
        report(ME_SERVICE, meLineOf(body, at), ME_GATE_RULE, `native write "${write}" outside performExport()`);
      }
    }
  }

  // The WIPE guard inside the choke point, pinned separately from the
  // disclosure assertion above because PR 2 made it load-bearing in a second
  // way: the write lock is now contended, and a lock wait is unbounded (a
  // document picker waits for a human). An epoch comparison that is present
  // but only BEFORE the lock would satisfy a reader skimming the function and
  // still let a wipe be followed by a write. `checkWindowedPins` reports a
  // vacuity violation if performExport itself ever stops matching.
  checkWindowedPins(
    ME_SERVICE,
    ME_GATE_RULE,
    /^async function performExport\([\s\S]*?\n\}/m,
    'the native-write epoch guard in performExport()',
    ['epoch !== exportEpoch', 'nativeWriteLock.acquire('],
    [],
    ME_ISSUE,
  );

  // Exported entry points = exported async callables that reach the choke
  // point. Textual and mechanical on purpose: "contains performExport(" is a
  // property a reviewer can check by eye, and a new entry point that forgets
  // the disclosure necessarily contains it too.
  //
  // BOTH declaration forms are matched. The `export const … = async (…) =>`
  // form was added after a mutation proof showed the function-declaration
  // regex alone was blind to it: an arrow-const entry point that downloaded
  // before asking passed silently, which is precisely the property this clause
  // claims to enforce. (Converting the EXISTING entry point to an arrow would
  // have failed closed through `entryCount === 0`, so the rule could only ever
  // be extended past, never emptied — but "extended past" is enough.)
  const entryRes = [
    /^export async function (\w+)\([\s\S]*?\n\}/gm,
    /^export const (\w+) = async \([\s\S]*?\n\};/gm,
  ];
  let entryCount = 0;
  for (const entryRe of entryRes) {
    let entry;
    while ((entry = entryRe.exec(body)) !== null) {
      const [text, name] = entry;
      if (!text.includes('performExport(')) continue;
      entryCount += 1;

      const awaitIdx = text.search(/\bawait\b/);
      if (awaitIdx === -1) {
        violations.push(
          `  ${relative('.', ME_SERVICE)}:${meLineOf(body, entry.index)}  [${ME_GATE_RULE}]  ${name}() reaches performExport( with no await — unreviewable shape (${ME_ISSUE})`,
        );
        continue;
      }
      // The LINE of the first await must be the disclosure call. Anything else
      // awaited first (a download, a permission prompt, a DB round-trip) means
      // work happened before the user was asked.
      const lineStart = text.lastIndexOf('\n', awaitIdx) + 1;
      const lineEnd = text.indexOf('\n', awaitIdx);
      const firstAwaitLine = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
      if (!firstAwaitLine.includes('ensureExportDisclosure(')) {
        violations.push(
          `  ${relative('.', ME_SERVICE)}:${meLineOf(body, entry.index + awaitIdx)}  [${ME_GATE_RULE}]  ${name}()'s first await is not ensureExportDisclosure( — it is "${firstAwaitLine.trim()}" (${ME_ISSUE})`,
        );
      }
    }
  }
  if (entryCount === 0) {
    violations.push(
      `  ${relative('.', ME_SERVICE)}:0  [${ME_GATE_RULE}]  no exported entry point reaches performExport( — zero sites is a violation, not a pass (${ME_ISSUE})`,
    );
  }
}

// ---------------------------------------------------------------------------
// 24c. media-export-no-name-logging
// ---------------------------------------------------------------------------

// A peer supplies `file_name`, so an export file name is USER CONTENT from
// another device, and the local path names a decrypted file. Neither may reach
// a log line or Sentry: telemetryScrub is a safety net for messages we did not
// author, not a licence to pass content in deliberately. The design is that
// only the error CODE is ever reported — this rule is what keeps it that way
// after the next debugging session.
//
// Files are read as NAMED files: a missing one is a violation. Matching is
// line-windowed on the call, not whole-file, because every one of these files
// legitimately handles `displayName` and `sourcePath` on non-logging lines.

const ME_LOG_RULE = 'media-export-no-name-logging';
const ME_FORBIDDEN_IN_LOGS = [
  'file_name',
  'fileName',
  'displayName',
  'localPath',
  'sourcePath',
  'mediaId',
];
const ME_LOG_CALL_RE = /\b(?:console\.(?:log|warn|error|info|debug|trace)|captureError|Sentry\.\w+)\s*\(/;

const ME_REQUIRED_LOG_FILES = [
  ME_SERVICE,
  ME_EXPORT_NAMES,
  ME_CONTENT_TYPE,
  ME_ABORTABLE,
  ME_BULK_RUNNER,
  ME_PKG_INDEX,
  ME_PKG_SPEC,
];

/**
 * The two PURE leaves (#880). Every export label — the MIME, the extension and
 * the display name — is computed in these two modules from a peer-supplied
 * content type, a peer-supplied file name and the first bytes of a DECRYPTED
 * file. All three are user content, and none of them has a code to log in
 * place of itself, so the rule here is absolute rather than windowed: these
 * files contain NO console, captureError or Sentry call at all.
 *
 * This is what the windowed name check cannot do. A debugging line like
 * `console.warn('[sniff]', head)` carries none of the forbidden identifiers —
 * `head`, `stem`, `brand`, `data` are these modules' own idioms — so it would
 * pass the windowed check while printing the leading bytes of a decrypted
 * photo. Zero calls is the only form of this rule that binds.
 *
 * `media/imageSanitizer.ts` is held to the same bar for the same reason, even
 * though it is an UPLOAD module: it materializes whole images in memory as
 * `data` / `stripped` Uint8Arrays, and it is the one file in the media pipeline
 * where a debugging session is most tempting. It has no log call today, and
 * this is what keeps it that way.
 */
const ME_SILENT_FILES = [ME_EXPORT_NAMES, ME_CONTENT_TYPE, ME_IMAGE_SANITIZER];

for (const file of ME_SILENT_FILES) {
  const raw = meRead(file, ME_LOG_RULE, 'that it logs nothing at all');
  if (raw === null) continue;
  const lines = meStripComments(raw).split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!ME_LOG_CALL_RE.test(lines[i])) continue;
    report(
      file,
      i + 1,
      ME_LOG_RULE,
      'a console/captureError/Sentry call in a module that handles peer file names or decrypted image bytes — these files must log nothing at all',
    );
  }
}

for (const file of ME_REQUIRED_LOG_FILES) {
  const raw = meRead(file, ME_LOG_RULE, 'its log and Sentry lines');
  if (raw === null) continue;

  const lines = meStripComments(raw).split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!ME_LOG_CALL_RE.test(lines[i])) continue;
    // Extend until the call's parens balance, so a multi-line captureError()
    // cannot hide a name on its second line — or its fourteenth. Still capped,
    // so an unbalanced paren (or a `(` inside a string) cannot make this
    // quadratic; 40 lines is far past any realistic Sentry payload literal,
    // and the cap was raised from 12 after a mutation proof slipped a name
    // through on line 14.
    let depth = 0;
    let windowText = '';
    for (let j = i; j < Math.min(lines.length, i + 40); j++) {
      windowText += `${lines[j]}\n`;
      for (const ch of lines[j]) {
        if (ch === '(') depth += 1;
        else if (ch === ')') depth -= 1;
      }
      if (j > i && depth <= 0) break;
      if (j === i && depth <= 0) break;
    }
    for (const banned of ME_FORBIDDEN_IN_LOGS) {
      if (windowText.includes(banned)) {
        report(file, i + 1, ME_LOG_RULE, `"${banned}" on a log/Sentry line`);
      }
    }
  }
}

// The rejection normalizer is the one function with a native Error in hand. If
// it ever reads that error's message, every native diagnostic string — which
// on both platforms can contain a path — starts flowing into JS errors, stack
// traces and Sentry.
checkWindowedPins(
  ME_PKG_INDEX,
  ME_LOG_RULE,
  /^function toExportError\([\s\S]*?\n\}/m,
  'the toExportError normalizer',
  ['new MediaExportError(code)'],
  // Spelled WITHOUT the bound identifier wherever possible. A mutation proof
  // showed `String(e)`/`e.toString` were defeated by a TS cast — `String(e as
  // Error)`, `(e as Error).toString()` — and by a template literal, all three
  // of which leak the native reject message (Error.prototype.toString returns
  // "Error: <message>"). `.message` needed no change: it carries no identifier
  // and so already survived casting.
  ['.message', 'String(', 'JSON.stringify', 'toString', '${e}'],
  ME_ISSUE,
);

// The native halves are equally silent. os_log/NSLog write to the device
// console (readable by anyone with the device plugged in), and android.util.Log
// to logcat — both would carry the display name and the source path.
//
// The token lists are kept IDENTICAL to the archive glue's (29.6): same threat
// (user file names on their way to a log), same two languages, and a sibling
// with a shorter ban list is the one a temporary print survives in. The extra
// tokens were verified to have zero existing hits in either file when they
// were added (#982).
checkWindowedPins(
  MEDIA_EXPORT_MM,
  ME_LOG_RULE,
  /^#import "OrbitalMediaExport\.h"[\s\S]*/m,
  'OrbitalMediaExport.mm (logging ban)',
  [],
  // `printf` is a substring and so also covers snprintf/asprintf: same
  // reasoning as 29.6 — a formatted string in this file would be built out of
  // a file name. `RCTLog` as a prefix covers the macros and the import.
  ['NSLog', 'os_log', 'printf', 'fprintf', 'RCTLog'],
  ME_ISSUE,
);

checkWindowedPins(
  MEDIA_EXPORT_KT,
  ME_LOG_RULE,
  /^package com\.orbital\.mediaexport[\s\S]*/m,
  'OrbitalMediaExportModule.kt (logging ban)',
  [],
  [
    // `android.util.Log` is the clause that catches an aliased import; the
    // call bans do not. See the same note in 29.6.
    'android.util.Log',
    'Log.d(',
    'Log.e(',
    'Log.i(',
    'Log.w(',
    'Log.v(',
    'Log.wtf(',
    'println(',
    'System.out',
    'System.err',
    'printStackTrace',
  ],
  ME_ISSUE,
);

// ---------------------------------------------------------------------------
// 24d. media-export-single-label-site
// ---------------------------------------------------------------------------

// A second place that builds an export label is how `image/heic` ended up on
// JPEG bytes in the first place (#880): the upload branch relabelled, the
// export branch did not, and nothing failed. `resolveExportLabel()` is now the
// only labeller, and the kind is deliberately NOT one of its inputs — so a new
// entry point (PR 2's bulk runner) that builds its own name, or a label step
// that creeps into the native-write choke point where the kind is still in
// scope, is exactly what this rule refuses.
//
// Textual and mechanical, like the disclosure gate: "appears once, inside this
// function" is a property a reviewer can check by eye.

const ME_LABEL_RULE = 'media-export-single-label-site';
const ME_LABEL_CALLS = ['buildExportFileName(', 'reconcileExportLabel(', 'sniffExportHead('];

{
  const raw = meRead(ME_SERVICE, ME_LABEL_RULE, 'that it labels in exactly one place');
  if (raw !== null) {
    const body = meStripComments(raw);
    const labelRe = /^async function resolveExportLabel\([\s\S]*?\n\}/m;
    const label = body.match(labelRe);
    const choke = body.match(/^async function performExport\([\s\S]*?\n\}/m);

    if (label === null) {
      violations.push(
        `  ${relative('.', ME_SERVICE)}:0  [${ME_LABEL_RULE}]  resolveExportLabel() not found — the single label site is gone and the rule would pass vacuously (${ME_ISSUE})`,
      );
    } else {
      const labelStart = label.index;
      const labelEnd = labelStart + label[0].length;

      for (const call of ME_LABEL_CALLS) {
        // Occurrences of the CALL, never the declaration: `function sniffExportHead(`
        // is the definition, and an import line carries no `(` at all.
        const sites = [];
        for (let at = body.indexOf(call); at !== -1; at = body.indexOf(call, at + 1)) {
          const before = body.slice(Math.max(0, at - 9), at);
          if (before.endsWith('function ')) continue;
          sites.push(at);
        }

        if (sites.length !== 1) {
          violations.push(
            `  ${relative('.', ME_SERVICE)}:${sites.length ? meLineOf(body, sites[0]) : 0}  [${ME_LABEL_RULE}]  "${call}" is called ${sites.length} time(s) — exactly one call, inside resolveExportLabel(), is the whole rule (${ME_ISSUE})`,
          );
        }
        for (const at of sites) {
          if (at < labelStart || at >= labelEnd) {
            const why = `"${call}" called outside resolveExportLabel()`;
            report(ME_SERVICE, meLineOf(body, at), ME_LABEL_RULE, why);
          }
          if (choke !== null && at >= choke.index && at < choke.index + choke[0].length) {
            const why = `"${call}" called inside performExport() — the write path must not relabel`;
            report(ME_SERVICE, meLineOf(body, at), ME_LABEL_RULE, why);
          }
        }
      }
    }
  }
}

// The clause above is scoped to ONE file, and that was the gap #881 left open
// (its Low finding): "exactly one call inside resolveExportLabel()" says
// nothing about a SECOND MODULE importing the builders and labelling for
// itself. PR 2's bulk runner was the concrete candidate — it has a media id,
// a destination and every reason to want a file name — so the allowlist is
// enforced across the whole tree rather than trusted to review.
//
// Each name is pinned to the modules that may NAME it at all:
//  - the two label builders: their own definition file, plus the service,
//    whose `resolveExportLabel()` is the single site above;
//  - `sniffContentType`: its definition file, the service (export labelling),
//    `imageSanitizer` (the UPLOAD-side relabel that keeps this client's own
//    rows honest, #880), and — the FOURTH caller, which this comment said
//    would be a decision rather than a detail — `metaImport/archiveAccess.ts`.
//
//    THAT DECISION, recorded (#920, PR2): the archive reader's use is an
//    IMPORT-side magic-byte gate, not an export label. F1 settles "video bytes
//    under an image name" by sniffing the first 128 bytes BEFORE extraction and
//    again after, so a renamed .mp4 inside a Meta export is refused instead of
//    being imported as a photo; nothing it returns ever names a file or reaches
//    a destination outside the sandbox. It is allowlisted for the sniffer ONLY
//    — `buildExportFileName` and `reconcileExportLabel` stay at two files each,
//    so the "labels are computed in exactly one place" property is untouched.
//    A FIFTH caller of the sniffer is again a decision, not a detail.
//
// Test paths are exempt, like every other cross-file scan here.
{
  const ME_LABEL_IMPORT_ALLOW = new Map([
    ['buildExportFileName', new Set([ME_EXPORT_NAMES, ME_SERVICE])],
    ['reconcileExportLabel', new Set([ME_EXPORT_NAMES, ME_SERVICE])],
    [
      'sniffContentType',
      new Set([ME_CONTENT_TYPE, ME_SERVICE, ME_IMAGE_SANITIZER, ARCHIVE_ACCESS]),
    ],
  ]);

  /** Names seen inside their own allowlist — zero is a vacuous pass. */
  const meLabelNameSeen = new Map([...ME_LABEL_IMPORT_ALLOW.keys()].map((n) => [n, false]));

  for (const file of allFiles) {
    const rel = relative('.', file);
    if (rel.includes('__tests__/') || rel.includes('.test.ts') || rel.includes('.test.tsx')) {
      continue;
    }

    const lines = meStripComments(readFileSync(file, 'utf8')).split('\n');
    for (const [name, allowed] of ME_LABEL_IMPORT_ALLOW) {
      const nameRe = new RegExp(`\\b${name}\\b`);
      for (let i = 0; i < lines.length; i++) {
        if (!nameRe.test(lines[i])) continue;
        if (allowed.has(file)) {
          meLabelNameSeen.set(name, true);
          continue;
        }
        report(
          file,
          i + 1,
          ME_LABEL_RULE,
          `"${name}" is named outside its allowlist — export labels are computed in exactly one place (resolveExportLabel in mediaExportService.ts)`,
        );
      }
    }
  }

  for (const [name, seen] of meLabelNameSeen) {
    if (seen) continue;
    violations.push(
      `  ${relative('.', ME_SERVICE)}:0  [${ME_LABEL_RULE}]  "${name}" appears in none of its allowlisted files — the import allowlist would pass vacuously (${ME_ISSUE})`,
    );
  }
}

// ---------------------------------------------------------------------------
// 24e. media-export-wipe-wired
// ---------------------------------------------------------------------------

// Export is the only path that copies decrypted media to a destination a wipe
// cannot reach. Two things therefore have to be true of localWipe:
//
//  - `cancelAllExports()` runs BEFORE the MEDIA_DIR deletion. An export that
//    is mid-download when an account is deleted would otherwise finish, pass
//    every `signal.aborted` check it already cleared, and write a decrypted
//    file to the photo library of a device whose account no longer exists.
//    (It is synchronous for the same reason: an await here hands control
//    straight back to the export.)
//  - `clearExportDisclosureCache()` drops the in-memory disclosure mirror,
//    AFTER MMKV `clearAll()`. Logout clears MMKV but does not reload the JS
//    bundle, so without it the next account on the device saves without ever
//    seeing the disclosure; before clearAll(), a read could re-cache it.
//  - `clearMediaExportStaging()` sweeps `Caches/orbital-export/`. That
//    directory is the ONE media-pipeline residue in a SUBDIRECTORY, so the
//    `isStagingResidueName` suffix sweep — a non-recursive readDir — cannot
//    reach it no matter what the files are called.
//
// `cleanupOrphanedChunks` carries the same sweep, which is how BOOTSTRAP is
// covered after a crash or jetsam mid-picker.
//
// #920 (F3) adds the ARCHIVE READER's teardown to the same rule rather than a
// new 29b, because the property is identical — a native job that keeps running
// through a wipe writes plaintext a wipe cannot reach — and because the two
// teardowns have to stay next to each other in phase 1 to be reviewable:
//
//  - `abortAllArchiveSessions()` runs BEFORE the MEDIA_DIR deletion, for the
//    same reason `cancelAllExports()` does: it bumps `archiveEpoch` so later
//    `createStagingFile`/`openArchive` calls refuse, and synchronously sets
//    every in-flight job's cancel flag. An extraction that is mid-`stream_entry`
//    when an account is deleted would otherwise finish and leave a decrypted
//    staging file behind phase 2's sweep. Synchronous and NOT awaited, again
//    for cancelAllExports' reason: an await hands control straight back to the
//    job being torn down, which then gets to write one more chunk.
//  - `releaseAllPersistedParts()` drops the Android SAF persistable grants.
//    This one IS awaited: it is a ContentResolver round-trip and it must not
//    race the epoch bump. Without it, a departing account leaves this app
//    holding long-lived read grants on the user's Downloads ZIPs — grants that
//    survive the wipe and that nothing in the UI would ever mention again.
//
// #921 (SQLite migration 009) adds the Meta IMPORT teardown to the same rule,
// for the same property and in the same phase-1 slot, plus one ordering
// correction to the clause above:
//
//  - `deleteAllImportJobs()` sits next to `clearAllThreads()`/`clearAllReplies()`
//    in phase 1. `import_items.body` is the member's own post text —
//    plaintext-class, the same posture as `orbital_threads.body` — and
//    `import_items.source_file` holds basenames out of their export. The DB
//    file is shared with whatever account comes next on this device, so a
//    logout that kept those rows would hand the next member the previous
//    member's post bodies and export file names. The cascade takes
//    `import_items` and `import_item_media` with it.
//  - `releaseAllPersistedParts()` MOVES ABOVE the `if (preserveIdentity)`
//    branch, so it runs on BOTH paths. #920 deliberately kept the grants on
//    logout so a paused import could resume; Alex's 2026-11-13 decision ends
//    that trade, because logout now CLEARS the import state. A grant that
//    outlives every row that explained it is an Android permission on a file
//    in the member's Downloads folder that nothing in the app would ever
//    mention again — and the resume it was being kept for no longer exists.
//    Presence alone is therefore NOT enough: the call has to be above the
//    fork, which is what the ordering half below checks.
//
// The third arm is `fullCryptoWipe`, the OTHER wipe (see MIT_KEY_GEN_SERVICE).
// Its `DELETE FROM import_jobs` has to run inside the same `BEGIN IMMEDIATE`
// transaction as the Signal-table drops, so the pin names the transaction too:
// otherwise "inside the transaction" would pass vacuously the day the
// transaction is removed and the deletes are left bare.

const ME_WIPE_RULE = 'media-export-wipe-wired';
// #921's own issue number. The import teardown rides inside rule 24e (above),
// so it needs an issue constant rather than a rule name of its own.
const MIT_ISSUE = '#921';

const meAuthRaw = meRead(ME_AUTH_SERVICE, ME_WIPE_RULE, 'the localWipe export teardown');
if (meAuthRaw !== null) {
  const body = meStripComments(meAuthRaw);
  const wipe = body.match(
    /^export async function localWipe\(\{ preserveIdentity \}[\s\S]*?\n\}/m,
  );
  if (wipe === null) {
    violations.push(
      `  ${relative('.', ME_AUTH_SERVICE)}:0  [${ME_WIPE_RULE}]  localWipe() not found — the rule would pass vacuously (${ME_ISSUE})`,
    );
  } else {
    const cancelIdx = wipe[0].indexOf('cancelAllExports(');
    const sweepIdx = wipe[0].indexOf('clearMediaExportStaging(');
    const disclosureIdx = wipe[0].indexOf('clearExportDisclosureCache(');
    // The media-directory deletion, identified by the local it binds.
    const mediaDirIdx = wipe[0].indexOf('mediaDirPath');
    const at = meLineOf(body, wipe.index);

    if (cancelIdx === -1) {
      violations.push(
        `  ${relative('.', ME_AUTH_SERVICE)}:${at}  [${ME_WIPE_RULE}]  localWipe() does not call cancelAllExports( (${ME_ISSUE})`,
      );
    }
    const mmkvClearIdx = wipe[0].indexOf('getMMKVInstance().clearAll(');
    if (disclosureIdx === -1) {
      violations.push(
        `  ${relative('.', ME_AUTH_SERVICE)}:${at}  [${ME_WIPE_RULE}]  localWipe() does not call clearExportDisclosureCache( — the disclosure acknowledgement would carry over to the next account (${ME_ISSUE})`,
      );
    } else if (mmkvClearIdx === -1) {
      violations.push(
        `  ${relative('.', ME_AUTH_SERVICE)}:${at}  [${ME_WIPE_RULE}]  localWipe() no longer calls getMMKVInstance().clearAll( — the disclosure-cache ORDERING check would pass vacuously (${ME_ISSUE})`,
      );
    } else if (disclosureIdx < mmkvClearIdx) {
      violations.push(
        `  ${relative('.', ME_AUTH_SERVICE)}:${at}  [${ME_WIPE_RULE}]  clearExportDisclosureCache( must run AFTER getMMKVInstance().clearAll( — a read in between re-caches the old acknowledgement (${ME_ISSUE})`,
      );
    }
    if (sweepIdx === -1) {
      violations.push(
        `  ${relative('.', ME_AUTH_SERVICE)}:${at}  [${ME_WIPE_RULE}]  localWipe() does not call clearMediaExportStaging( (${ME_ISSUE})`,
      );
    }
    const runnerResetIdx = wipe[0].indexOf('resetBulkExportState(');
    if (runnerResetIdx === -1) {
      violations.push(
        `  ${relative('.', ME_AUTH_SERVICE)}:${at}  [${ME_WIPE_RULE}]  localWipe() does not call resetBulkExportState( — the previous account's Save-all summary would greet the next one (${ME_ISSUE})`,
      );
    }
    if (/\bawait\s+resetBulkExportState\s*\(/.test(wipe[0])) {
      violations.push(
        `  ${relative('.', ME_AUTH_SERVICE)}:${at}  [${ME_WIPE_RULE}]  resetBulkExportState( must not be awaited — it tears down a run that an await would hand control back to (${ME_ISSUE})`,
      );
    }
    if (mediaDirIdx === -1) {
      violations.push(
        `  ${relative('.', ME_AUTH_SERVICE)}:${at}  [${ME_WIPE_RULE}]  localWipe() no longer names mediaDirPath — the export-abort ORDERING check would pass vacuously (${ME_ISSUE})`,
      );
    } else if (cancelIdx !== -1 && cancelIdx > mediaDirIdx) {
      violations.push(
        `  ${relative('.', ME_AUTH_SERVICE)}:${at}  [${ME_WIPE_RULE}]  cancelAllExports( must run BEFORE the MEDIA_DIR deletion in localWipe() (${ME_ISSUE})`,
      );
    }
    if (/\bawait\s+cancelAllExports\s*\(/.test(wipe[0])) {
      violations.push(
        `  ${relative('.', ME_AUTH_SERVICE)}:${at}  [${ME_WIPE_RULE}]  cancelAllExports( must not be awaited — the abort has to be synchronous (${ME_ISSUE})`,
      );
    }

    // --- #920 F3: the archive reader's teardown, pinned the same three ways
    // as the export teardown above (present, phase 1, not awaited) plus the
    // deletion-path grant release. `mediaDirPath` is the SAME ordering anchor
    // the cancelAllExports clause uses, and its non-vacuity is already
    // asserted above, so this clause cannot pass by the anchor disappearing.
    const archiveAbortIdx = wipe[0].indexOf('abortAllArchiveSessions(');
    if (archiveAbortIdx === -1) {
      violations.push(
        `  ${relative('.', ME_AUTH_SERVICE)}:${at}  [${ME_WIPE_RULE}]  localWipe() does not call abortAllArchiveSessions( — a native archive job mid-extraction would keep writing a decrypted staging file through the wipe (${AR_ISSUE})`,
      );
    } else if (mediaDirIdx !== -1 && archiveAbortIdx > mediaDirIdx) {
      violations.push(
        `  ${relative('.', ME_AUTH_SERVICE)}:${at}  [${ME_WIPE_RULE}]  abortAllArchiveSessions( must run in phase 1, BEFORE the MEDIA_DIR deletion in localWipe() — after it, the epoch bump lands too late to stop a job that is already extracting (${AR_ISSUE})`,
      );
    }
    if (/\bawait\s+abortAllArchiveSessions\s*\(/.test(wipe[0])) {
      violations.push(
        `  ${relative('.', ME_AUTH_SERVICE)}:${at}  [${ME_WIPE_RULE}]  abortAllArchiveSessions( must not be awaited — the epoch bump and the cancel-flag set are synchronous, and an await hands control back to the job being torn down (${AR_ISSUE})`,
      );
    }
    const releaseIdx = wipe[0].indexOf('releaseAllPersistedParts(');
    // The logout/deletion fork. Used as the ORDERING anchor for the grant
    // release below, the same way `mediaDirPath` anchors the export abort —
    // and asserted non-vacuous for the same reason: if the branch is gone,
    // "before the branch" is a comparison against nothing.
    const preserveBranchIdx = wipe[0].indexOf('if (preserveIdentity)');
    if (releaseIdx === -1) {
      violations.push(
        `  ${relative('.', ME_AUTH_SERVICE)}:${at}  [${ME_WIPE_RULE}]  localWipe() does not call releaseAllPersistedParts( — a deleted account would leave this app holding persistable SAF read grants on the user's archive ZIPs (${AR_ISSUE})`,
      );
    } else if (preserveBranchIdx === -1) {
      violations.push(
        `  ${relative('.', ME_AUTH_SERVICE)}:${at}  [${ME_WIPE_RULE}]  localWipe() no longer branches on \`if (preserveIdentity)\` — the releaseAllPersistedParts( ORDERING check would pass vacuously (${MIT_ISSUE})`,
      );
    } else if (releaseIdx > preserveBranchIdx) {
      violations.push(
        `  ${relative('.', ME_AUTH_SERVICE)}:${at}  [${ME_WIPE_RULE}]  releaseAllPersistedParts( must run ABOVE the \`if (preserveIdentity)\` branch, so it runs on LOGOUT as well as deletion — logout now clears the import state, and a retained SAF grant would outlive every row that explained it (${MIT_ISSUE})`,
      );
    }

    // --- #921: the Meta import tables. Phase 1, next to the thread and reply
    // caches, because `import_items.body` is the member's own post text
    // (plaintext-class inside SQLCipher) and the DB file is shared with the
    // next account on this device.
    if (wipe[0].indexOf('deleteAllImportJobs(') === -1) {
      violations.push(
        `  ${relative('.', ME_AUTH_SERVICE)}:${at}  [${ME_WIPE_RULE}]  localWipe() does not call deleteAllImportJobs( — logout/deletion would leave the member's plaintext-class post bodies and export file names in import_items for the next account on this device (${MIT_ISSUE})`,
      );
    }
  }
}

// --- #921, third arm: the OTHER wipe. `fullCryptoWipe` destroys the key
// generation every stored `import_key` was derived under and that
// `import_jobs.key_fingerprint` stamps, so no import job can survive it — and
// the rows carry plaintext-class post bodies, which belong with the rest of
// the dead-generation state. `BEGIN IMMEDIATE` is pinned alongside the delete
// so the "inside the transaction" half cannot pass vacuously if the
// transaction is ever removed and the deletes are left bare.
const MIT_WIPE_WINDOW_RE = /^export async function fullCryptoWipe\(\)[\s\S]*?\n\}/m;
checkWindowedPins(
  MIT_KEY_GEN_SERVICE,
  ME_WIPE_RULE,
  MIT_WIPE_WINDOW_RE,
  'the fullCryptoWipe body',
  ['BEGIN IMMEDIATE', 'DELETE FROM import_jobs'],
  [],
  MIT_ISSUE,
);

// Presence is not position. The three pins above can all hold with the DELETE
// sitting AFTER the COMMIT, where it is no longer part of the atomic wipe: a
// crash between the two would leave the Signal tables empty and the import
// rows — plaintext-class bodies included — behind, under a key generation
// that no longer exists. So the index order is checked too, which is what the
// comment on the rule has always claimed.
{
  const mitWipeRaw = meRead(
    MIT_KEY_GEN_SERVICE,
    ME_WIPE_RULE,
    'the fullCryptoWipe transaction ordering',
    MIT_ISSUE,
  );
  if (mitWipeRaw !== null) {
    const mitWipeWindow = meStripComments(mitWipeRaw).match(MIT_WIPE_WINDOW_RE);
    // A missing window is already reported by checkWindowedPins above; this
    // arm only has to avoid asserting against nothing.
    if (mitWipeWindow !== null) {
      const beginIdx = mitWipeWindow[0].indexOf('BEGIN IMMEDIATE');
      const deleteIdx = mitWipeWindow[0].indexOf('DELETE FROM import_jobs');
      const commitIdx = mitWipeWindow[0].indexOf('COMMIT');
      if (commitIdx === -1) {
        violations.push(
          `  ${relative('.', MIT_KEY_GEN_SERVICE)}:0  [${ME_WIPE_RULE}]  fullCryptoWipe has no COMMIT — the "DELETE FROM import_jobs runs inside the transaction" ordering check would pass vacuously (${MIT_ISSUE})`,
        );
      } else if (
        beginIdx !== -1 &&
        deleteIdx !== -1 &&
        !(beginIdx < deleteIdx && deleteIdx < commitIdx)
      ) {
        violations.push(
          `  ${relative('.', MIT_KEY_GEN_SERVICE)}:0  [${ME_WIPE_RULE}]  DELETE FROM import_jobs must sit BETWEEN BEGIN IMMEDIATE and COMMIT — outside the transaction it is not part of the atomic wipe, and a crash would leave plaintext-class import bodies behind under a destroyed key generation (${MIT_ISSUE})`,
        );
      }
    }
  }
}

// --- #921, fourth arm: key recovery. `keyRecoveryService` never calls
// `localWipe`, so neither of the teardowns the rule pins above reaches it —
// yet step 5 runs `fullCryptoWipe`, which deletes `import_jobs`. Without
// these two calls a recovery leaves the app holding persistable SAF grants on
// ZIPs in the member's Downloads folder with no row left to explain them, and
// lets a live parse keep flushing items against a job row the wipe just
// deleted.
//
// Order is the point, so it is what is checked: abort (synchronous, bumps the
// epoch) BEFORE the wipe, release (a ContentResolver round-trip) AFTER it.
// `fullCryptoWipe(` is the non-vacuity anchor — if the wipe ever leaves this
// file, pinning its neighbours here means nothing.
{
  const mitRecoveryRaw = meRead(
    MIT_RECOVERY_SERVICE,
    ME_WIPE_RULE,
    'the key-recovery archive teardown',
    MIT_ISSUE,
  );
  if (mitRecoveryRaw !== null) {
    const flat = meStripComments(mitRecoveryRaw);
    const wipeIdx = flat.indexOf('fullCryptoWipe(');
    const abortIdx = flat.indexOf('abortAllArchiveSessions(');
    const releaseIdx = flat.indexOf('releaseAllPersistedParts(');
    if (wipeIdx === -1) {
      violations.push(
        `  ${relative('.', MIT_RECOVERY_SERVICE)}:0  [${ME_WIPE_RULE}]  no fullCryptoWipe( call — the key-recovery archive teardown pins would have nothing to anchor on and would pass vacuously (${MIT_ISSUE})`,
      );
    } else {
      if (abortIdx === -1 || abortIdx > wipeIdx) {
        violations.push(
          `  ${relative('.', MIT_RECOVERY_SERVICE)}:0  [${ME_WIPE_RULE}]  abortAllArchiveSessions( must run BEFORE fullCryptoWipe( in key recovery — the wipe deletes import_jobs, and a parse still flushing items would be writing against a job row that no longer exists (${MIT_ISSUE})`,
        );
      }
      if (releaseIdx === -1 || releaseIdx < wipeIdx) {
        violations.push(
          `  ${relative('.', MIT_RECOVERY_SERVICE)}:0  [${ME_WIPE_RULE}]  releaseAllPersistedParts( must run AFTER fullCryptoWipe( in key recovery — this path never calls localWipe, so without it a recovered account keeps long-lived SAF read grants on the member's archive ZIPs with no import row left to explain them (${MIT_ISSUE})`,
        );
      }
    }
  }
}

checkWindowedPins(
  ME_UPLOAD_SERVICE,
  ME_WIPE_RULE,
  /^export async function cleanupOrphanedChunks\(\)[\s\S]*?\n\}/m,
  'the cleanupOrphanedChunks bootstrap reaper',
  ['clearMediaExportStaging('],
  [],
  ME_ISSUE,
);

// The CALL SITE pins above are satisfied by an emptied function, so the two
// synchronous teardowns are pinned by BODY as well (#889 review).
//
// `cancelAllExports` has three jobs and each one alone is insufficient:
// bumping the epoch stops a write that is already past every `signal.aborted`
// check; aborting the controllers stops the downloads still in flight; and
// discarding the staged list stops the end-of-run picker from presenting
// decrypted paths that phase 2 is about to delete. A version that did two of
// the three would pass every call-site check in this file.
checkWindowedPins(
  ME_SERVICE,
  ME_WIPE_RULE,
  /^export function cancelAllExports\(\): void \{[\s\S]*?\n\}/m,
  'the cancelAllExports teardown body',
  ['exportEpoch += 1', '.abort(', 'discardStagedBulkDocuments('],
  [],
  ME_ISSUE,
);

// The bulk runner's PUBLISHED state is module state that outlives a logout
// (nothing reloads the JS bundle), so a finished run's summary card would
// otherwise greet the next account on the device.
checkWindowedPins(
  ME_BULK_RUNNER,
  ME_WIPE_RULE,
  /^export function resetBulkExportState\(\): void \{[\s\S]*?\n\}/m,
  'the bulk-runner wipe reset',
  ['bulkExportStore.setState(', 'discardStagedBulkDocuments(', '.abort('],
  [],
  ME_ISSUE,
);

// The disclosure reset itself: an emptied function would satisfy the call-site
// pin above while the acknowledgement stayed cached.
checkWindowedPins(
  ME_SERVICE,
  ME_WIPE_RULE,
  /^export function clearExportDisclosureCache\(\)[\s\S]*?\n\}/m,
  'the clearExportDisclosureCache body',
  ['disclosureAcked = null'],
  [],
  ME_ISSUE,
);

// The sweep itself: a named function that no longer deletes the directory
// would satisfy every call-site pin above while leaving the residue in place.
checkWindowedPins(
  ME_SERVICE,
  ME_WIPE_RULE,
  /^export async function clearMediaExportStaging\(\)[\s\S]*?\n\}/m,
  'the clearMediaExportStaging body',
  ['EXPORT_STAGING_DIR', 'unlink('],
  [],
  ME_ISSUE,
);

checkWindowedPins(
  ME_SERVICE,
  ME_WIPE_RULE,
  /^export const EXPORT_STAGING_DIR =[\s\S]*?;$/m,
  'the EXPORT_STAGING_DIR definition',
  ['orbital-export', 'CachesDirectoryPath'],
  [],
  ME_ISSUE,
);

// #920 F3, same reasoning as the cancelAllExports body pin above: the call
// site in localWipe is satisfied by an emptied function. All three halves of
// the archive teardown are load-bearing and each alone is insufficient —
// bumping the epoch refuses the call that is one microtask from creating a
// staging file; closeForWipe() sets the cancel flag of a job already inside
// stream_entry and drops Rust's descriptor dups; clearing the live set stops
// a second wipe from closing sessions twice. A version doing two of the three
// would pass every call-site check in this file.
checkWindowedPins(
  join(ARCHIVE_PKG_REL, 'src', 'index.tsx'),
  ME_WIPE_RULE,
  /^export function abortAllArchiveSessions\(\): void \{[\s\S]*?\n\}/m,
  'the abortAllArchiveSessions teardown body',
  ['archiveEpoch++', 'closeForWipe(', 'liveSessions.clear('],
  [],
  AR_ISSUE,
);

// ---------------------------------------------------------------------------
// 25. The two import-free registries that cross the crypto fence (#912)
// ---------------------------------------------------------------------------

// `src/services/crypto/**` is a fenced layer: ESLint bans Sentry and every
// telemetry facade there, because an error report built inside the crypto layer
// is one interpolation away from carrying key material. Two modules are allowed
// to be imported from BOTH sides of that fence, and the only thing that makes
// that safe is that they import NOTHING AT ALL — so they cannot reach Sentry,
// a store, MMKV or the database, whichever side loads them:
//
//   crypto/groupKeyErrors.ts    the closed failure vocabulary, the classifier,
//                               REWRAP_REFUSAL_CODES and a {report, reset}
//                               reporter slot. Imported from outside the fence
//                               by src/services/groupKeyTelemetry.ts (which
//                               fills the slot) and src/services/api/errors.ts
//                               (which allowlists details.code against
//                               REWRAP_REFUSAL_CODES), and from inside it by
//                               contentCrypto / groupKeyRecovery.
//   crypto/wrapDeliveryHook.ts  a one-way slot for the WS wrapped_key_delivered
//                               dedup. Filled from outside the fence by
//                               src/services/websocket/messageHandler.ts at
//                               module scope; called from inside it.
//
// One import added to either file re-opens the fence for its outside callers
// (api/errors.ts is reachable from almost everything, and messageHandler pulls
// stores, repositories and notifications) without tripping any ESLint rule,
// because the restriction is on where the FILE lives, not on who imports it.
// Both module headers say "zero imports"; this is what enforces it.
//
// Type-only imports are forbidden too, deliberately: they are erased at
// runtime, so they would be safe — but allowing them means this rule has to
// distinguish forms, and a one-character edit (`import type` -> `import`) would
// then be invisible. "No import, require or from statement at all" is the
// cheapest rule to keep true. Comments are blanked first: both headers discuss
// imports at length in prose.
const IFR_RULE = 'import-free-registry';
const IFR_ISSUE = '#912';
const IFR_FILES = [
  [
    join(SRC, 'services', 'crypto', 'groupKeyErrors.ts'),
    'src/services/groupKeyTelemetry.ts and src/services/api/errors.ts import it from OUTSIDE the crypto fence',
  ],
  [
    join(SRC, 'services', 'crypto', 'wrapDeliveryHook.ts'),
    'src/services/websocket/messageHandler.ts fills its slot from OUTSIDE the crypto fence',
  ],
];
// `from` is matched as a statement-position keyword only (`} from '…'`,
// `* from '…'`), so prose-free code using `from` as an identifier is unaffected.
const IFR_PATTERNS = [
  [/^\s*import\b/m, 'an import statement'],
  [/\brequire\s*\(/, 'a require() call'],
  [/\bfrom\s*['"\x60]/, "a `from '…'` specifier"],
];

for (const [file, importers] of IFR_FILES) {
  let source;
  try {
    source = blankComments(readFileSync(file, 'utf8'));
  } catch {
    violations.push(
      `  ${relative('.', file)}:0  [${IFR_RULE}]  import-free registry not found — it is imported from both sides of the crypto fence and the rule cannot be verified (${IFR_ISSUE})`,
    );
    continue;
  }
  for (const [re, label] of IFR_PATTERNS) {
    const m = re.exec(source);
    if (m === null) continue;
    report(
      file,
      source.slice(0, m.index).split('\n').length,
      IFR_RULE,
      `must stay import-free but has ${label} — ${importers}, so any dependency here lands on both sides of it. Put the dependency in the module that fills the registry slot instead (${IFR_ISSUE})`,
    );
  }
}

// ---------------------------------------------------------------------------
// 26. The 1:1 Signal session path stays dormant (#200 / #946)
// ---------------------------------------------------------------------------

// Every libsignal bump since v0.95 has been reviewed as a ROUTINE bump on the
// strength of one premise: the Signal 1:1 session pipeline has no production
// callers. That premise is what licenses skipping a device smoke, skipping a
// SessionRecord migration, and (at v0.106.0 / #946) accepting Tahini session
// management — `SessionStructure.origin`, the `RecordStructure.tahini` oneof,
// `MAX_ARCHIVED_SESSIONS` 40 -> 3 and "an archived session is never made active
// again" — with no test of any of it. Until this clause existed the premise was
// recorded only in prose (src/services/crypto/index.ts's header, Test 8e's
// docblock, the golden-fixture ledgers), so a single `import { signalEncrypt }`
// could falsify every one of those reviews without tripping anything.
//
// The FFI surface is exported and callable today: `processPreKeyBundle`,
// `signalEncrypt`, `signalDecrypt`, `signalDecryptPreKey` and
// `parsePrekeyMessageIds` are generated into
// packages/orbital-signal/src/generated/orbital_signal.ts and re-exported by the
// blanket `export *` in its index.tsx, so a caller needs no new plumbing.
//
// Reviving the path is allowed — it is a deferral (#200), not a ban — but it is
// not a one-line change, and this clause is where the bill is written down:
//
//   1. Tahini policy. Sessions now carry an origin and a direction-change
//      counter; archived sessions are never reactivated and a tiebreaker picks
//      the active session in a race. Read upstream `rust/protocol/src/tahini.rs`
//      before writing a session service.
//   2. `MAX_ARCHIVED_SESSIONS` is 3 (was 40). Records holding more are trimmed
//      on the next archive. Test eviction at 3.
//   3. Golden fixtures. tests/golden_session_record_tests.rs holds v0.97.4-era
//      records with no on-device counterpart; the moment real records are
//      persisted, migration and restore need coverage in both directions.
//   4. A device smoke. The whole 1:1 path has never run on a device in this
//      app, and every bump review has deferred that smoke on these grounds.
//
// Matching is a plain identifier scan over non-comment code, deliberately: it
// catches a direct import from the package, an import through the barrel, a
// namespaced `OrbitalSignal.signalEncrypt(…)` member call, and a bare
// re-export, without this rule having to model import forms. Comments are
// blanked first because the prose that records the deferral names all four
// functions. `__tests__/` and `*.test.*` are exempt: the export-surface smoke
// test (__tests__/OrbitalSignal.test.ts) and the mock (__mocks__/) live outside
// `src/` anyway, and a future in-crate test of a revived path should not be
// blocked by the clause that merely says "not in production yet".
//
// The store half is the same premise from the other end: no production code may
// READ or WRITE a session row. `signalSessionRepository`'s save/load exports
// have no caller outside their own test file, and production SQL against
// `signal_sessions` is DELETE-only (the logout wipe in authService and the
// Signal-table wipe in keyGenerationService). `removeSession` /
// `removeAllSessionsForService` are therefore NOT on this list — wiping a table
// that is never written is harmless. `getSession` is a generic enough name that
// an unrelated module could want it one day; if that happens, rename the
// unrelated one or scope this clause to the import specifier — do not delete it.
//
// The third arm is the TABLE NAME, which catches what the two name lists cannot:
// raw SQL. Any mention of `signal_sessions` in a non-test `src/` file must be a
// DELETE. The two production wipes (`execute('DELETE FROM signal_sessions')` in
// authService's logout and keyGenerationService's full Signal-table wipe) are
// exactly that and keep passing; an `INSERT`, `SELECT`, `UPDATE` or an unverbed
// mention fails. Exempt: the repository itself (it defines the save/load SQL),
// `src/database/migrations/` (DDL — the table must be creatable) and
// `src/types/database.ts` (the row type's doc comment names the table).
//
// SCAN ROOT: `src/` only, `.ts`/`.tsx` only (the shared `allFiles` walk).
// `packages/orbital-signal/src` is NOT scanned and must not be — it holds
// generated bindings, which necessarily name all four functions; it is read
// instead as the non-vacuity floor below.
//
// Non-vacuity floor: assert every name in SSD_FFI is still generated. If a
// future ubrn/libsignal change stops exporting one, this clause would pass by
// having nothing to find, while the real question ("is the 1:1 path still
// dormant?") had quietly become "does the 1:1 path still exist?".
const SSD_RULE = 'signal-session-dormant';
const SSD_ISSUE = '#200 / #946';
const SSD_FFI = [
  'processPreKeyBundle',
  'signalEncrypt',
  'signalDecryptPreKey',
  'signalDecrypt',
  // The preloaded-store pattern's first step: a caller must parse the message's
  // key ids before it can load the pre-keys to decrypt with. It is pure parsing
  // with no crypto, which makes it the quietest possible first production
  // reference to the 1:1 path — and the most likely one to be added first.
  'parsePrekeyMessageIds',
];
const SSD_STORE = ['saveSession', 'getSessionsForService', 'getSession'];
const SSD_TABLE = 'signal_sessions';
const SSD_TABLE_OK = /DELETE\s+FROM\s+signal_sessions/i;
const SSD_REPO = join(SRC, 'database', 'repositories', 'signalSessionRepository.ts');
const SSD_TABLE_EXEMPT = [join(SRC, 'database', 'migrations'), join(SRC, 'types', 'database.ts')];
const SSD_GENERATED = join('packages', 'orbital-signal', 'src', 'generated', 'orbital_signal.ts');
// THE canonical list of what reviving the 1:1 path owes. Deliberately stated
// once, here: it used to be restated in the golden-fixture headers and Test 8e's
// docblock, where the copies drifted. Those now point at this rule by name.
const SSD_OWED =
  'reviving it owes: (1) Tahini policy — read upstream tahini.rs, sessions carry an origin and a direction-change counter and archived sessions are never reactivated; (2) MAX_ARCHIVED_SESSIONS=3 eviction coverage (was 40); (3) a test that an archived session cannot roll back a later-learned identity (upstream saves the identity only for SessionLocation::Current); (4) golden SessionRecord fixtures for real on-device records, in both directions; (5) correct pre-key consumption — DecryptPreKeyResult.consumedPreKeyId / consumedKyberPreKeyId are ENVELOPE READS, not upstream consumption facts: on the existing-session branch upstream consumes no pre-key at all, so a session service must not delete the keys they name unconditionally; and a device smoke (the whole path has never run on a device)';

{
  let generated = '';
  try {
    generated = readFileSync(SSD_GENERATED, 'utf8');
  } catch {
    violations.push(
      `  ${SSD_GENERATED}:0  [${SSD_RULE}]  generated bindings not found — the dormancy rule would pass vacuously (${SSD_ISSUE})`,
    );
  }
  for (const fn of SSD_FFI) {
    if (generated && !new RegExp(`export function ${fn}\\b`).test(generated)) {
      violations.push(
        `  ${SSD_GENERATED}:0  [${SSD_RULE}]  \`${fn}\` is no longer generated — the 1:1 session surface moved, so re-derive this clause's name list from the current bindings instead of letting it match nothing (${SSD_ISSUE})`,
      );
    }
  }

  const ssdNames = [
    ...SSD_FFI.map((n) => [n, 'the 1:1 session FFI surface has no production caller']),
    ...SSD_STORE.map((n) => [n, 'no production code reads or writes a signal_sessions row']),
  ];
  for (const file of allFiles) {
    const rel = relative('.', file);
    if (rel.includes('__tests__/') || rel.includes('.test.ts') || rel.includes('.test.tsx')) {
      continue;
    }
    // The repository defines the store half; the barrel's `export *` names nothing.
    if (file === SSD_REPO) continue;

    const tableExempt = SSD_TABLE_EXEMPT.some((p) => rel.startsWith(p));
    const lines = blankComments(readFileSync(file, 'utf8')).split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const [name, why] of ssdNames) {
        if (!new RegExp(`\\b${name}\\b`).test(lines[i])) continue;
        report(
          file,
          i + 1,
          SSD_RULE,
          `references \`${name}\` — ${why} (${SSD_ISSUE}), and every libsignal bump review has relied on that. If the path is being revived deliberately, ${SSD_OWED}; then update this clause.`,
        );
      }
      if (!tableExempt && lines[i].includes(SSD_TABLE) && !SSD_TABLE_OK.test(lines[i])) {
        report(
          file,
          i + 1,
          SSD_RULE,
          `raw SQL touching \`${SSD_TABLE}\` that is not a DELETE — production access to that table is wipe-only, because no production code ever writes a session row (${SSD_ISSUE}). If the path is being revived deliberately, ${SSD_OWED}; then update this clause.`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 27. libsignal version literals in the docs track the pinned tag (#573)
// ---------------------------------------------------------------------------

// The libsignal pin appears in eleven prose literals across five docs, and
// every bump has hand-swept them: v0.102.3, v0.103.0, v0.104.0 and v0.106.0 all
// shipped the same manual edit list with no detector behind it. A missed literal
// is not cosmetic — docs/encryption-export-compliance.md and
// docs/compliance/bis-filing-2026.md are the derivation source for the BIS
// filing and the export-compliance answer, so a stale version there is a stale
// regulatory claim.
//
// The pin is read from the crate's Cargo.toml (`tag = "…"`), which also makes
// this the lockstep check for the two libsignal crates: libsignal-protocol and
// libsignal-core are published from one repo at one tag and have never been
// pinned apart.
//
// Rule: on any line of the doc set that mentions libsignal, every version token
// must equal the pin. That shape — rather than a list of blessed phrasings —
// means a NEW stale literal added later is caught too. Two escapes, both narrow:
//
//   * FROZEN tokens, allowlisted by exact substring. `v0.83.0 at time of
//     writing` is a historical statement about what was current when those
//     feasibility docs were written; `since libsignal v0.99.1` dates when
//     curve25519-dalek became stock. Neither tracks the pin.
//   * HISTORY lines, allowlisted per file by line pattern: the BIS derivation
//     log is an append-only ledger of every version it was re-derived at. It
//     gets the opposite check instead — it MUST contain the current pin, which
//     is what makes the append non-optional.
//
// Per-version ledgers inside the crate (the golden-fixture test headers, the
// Cargo.toml history comments, .cargo/audit.toml's re-verification log) are
// deliberately OUT of scope: they are append-only records of what was true at
// each tag, and rewriting them to the current pin would destroy the evidence.
//
// Non-vacuity floor: each file must carry at least as many pin-matching tokens
// as it does today, so deleting a literal (or renaming the file) fails instead
// of silently shrinking the swept surface.
const LVL_RULE = 'libsignal-doc-version';
const LVL_ISSUE = '#573';
const LVL_CARGO = join(CRATE_REL, 'Cargo.toml');
const LVL_FROZEN = ['v0.83.0 at time of writing', 'since libsignal v0.99.1'];
const LVL_HISTORY = /^-\s+\*\*Derived:\*\*/;
// file -> minimum number of tokens that must equal the pin
const LVL_DOCS = [
  ['docs/MOBILE-APP-SPEC.md', 3],
  // Floor 0: this file's only version-bearing line is the append-only `- **Derived:**`
  // log, which LVL_HISTORY skips and the inverse check below owns. It is still in the
  // scan set so that a NEW stale literal added anywhere else in it is caught.
  ['docs/compliance/bis-filing-2026.md', 0],
  ['docs/libsignal-api-surface.md', 2],
  ['docs/uniffi-toolchain.md', 1],
  ['docs/uniffi-udl-feasibility.md', 3],
  ['docs/encryption-export-compliance.md', 2],
];
const LVL_BIS = 'docs/compliance/bis-filing-2026.md';
const LVL_VER_RE = /\bv\d+\.\d+\.\d+\b/g;
const LVL_BARE_RE = /\blibsignal(?:-protocol|-core)?\s+(\d+\.\d+\.\d+)\b/g;

{
  let pin = null;
  try {
    const cargo = readFileSync(LVL_CARGO, 'utf8');
    const tags = [...cargo.matchAll(/^libsignal-(protocol|core)\s*=.*tag\s*=\s*"([^"]+)"/gm)];
    const found = new Map(tags.map(([, crate, tag]) => [crate, tag]));
    if (found.size !== 2) {
      violations.push(
        `  ${LVL_CARGO}:0  [${LVL_RULE}]  could not read a \`tag = "…"\` pin for both libsignal-protocol and libsignal-core (found ${[...found.keys()].join(', ') || 'neither'}) — the doc-literal rule has no reference to compare against (${LVL_ISSUE})`,
      );
    } else if (found.get('protocol') !== found.get('core')) {
      violations.push(
        `  ${LVL_CARGO}:0  [${LVL_RULE}]  libsignal-protocol (${found.get('protocol')}) and libsignal-core (${found.get('core')}) are pinned to different tags — they are published from one repo at one tag and must move in lockstep (${LVL_ISSUE})`,
      );
    } else {
      pin = found.get('protocol');
    }
  } catch {
    violations.push(
      `  ${LVL_CARGO}:0  [${LVL_RULE}]  crate Cargo.toml not found — the doc-literal rule would pass vacuously (${LVL_ISSUE})`,
    );
  }

  if (pin !== null) {
    const bare = pin.replace(/^v/, '');
    for (const [docFile, floor] of LVL_DOCS) {
      let lines;
      try {
        lines = readFileSync(docFile, 'utf8').split('\n');
      } catch {
        violations.push(
          `  ${docFile}:0  [${LVL_RULE}]  doc not found — it carries ${floor} libsignal version literal(s) that this rule sweeps; if it moved, update LVL_DOCS (${LVL_ISSUE})`,
        );
        continue;
      }
      let matched = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!/libsignal/i.test(line)) continue;
        if (LVL_HISTORY.test(line)) continue;
        const tokens = new Set([
          ...[...line.matchAll(LVL_VER_RE)].map((m) => m[0].slice(1)),
          ...[...line.matchAll(LVL_BARE_RE)].map((m) => m[1]),
        ]);
        for (const token of tokens) {
          if (token === bare) {
            matched += 1;
            continue;
          }
          if (LVL_FROZEN.some((f) => line.includes(f) && f.includes(token))) continue;
          report(
            docFile,
            i + 1,
            LVL_RULE,
            `libsignal version literal \`v${token}\` does not match the pinned tag \`${pin}\` from ${CRATE_REL}/Cargo.toml (${LVL_ISSUE}). If it is a frozen historical statement, add its exact phrase to LVL_FROZEN; otherwise sweep it with the bump.`,
          );
        }
      }
      if (matched < floor) {
        violations.push(
          `  ${docFile}:0  [${LVL_RULE}]  found ${matched} literal(s) matching the pin \`${pin}\`, expected at least ${floor} — a swept literal was deleted or reworded, so the doc no longer states the pin it used to (${LVL_ISSUE})`,
        );
      }
    }

    let bisLine = null;
    let bisLineNo = 0;
    try {
      const lines = readFileSync(LVL_BIS, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (LVL_HISTORY.test(lines[i])) {
          bisLine = lines[i];
          bisLineNo = i + 1;
          break;
        }
      }
    } catch {
      /* reported below */
    }
    if (bisLine === null) {
      violations.push(
        `  ${LVL_BIS}:0  [${LVL_RULE}]  the \`- **Derived:**\` log line is missing — it is the append-only record of every libsignal version the BIS filing was re-derived at (${LVL_ISSUE})`,
      );
    } else if (!bisLine.includes(pin)) {
      violations.push(
        `  ${LVL_BIS}:${bisLineNo}  [${LVL_RULE}]  the derivation log does not mention the current pin \`${pin}\` — append \`; updated <date>, ${pin}, Cargo.lock\` rather than editing an earlier entry (${LVL_ISSUE})`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 28. The react-native-image-picker native patch stays intact (#971)
// ---------------------------------------------------------------------------

// react-native-image-picker 8.2.1 can call one JS callback twice, which trips
// RCTTurboModule's LOG(FATAL) and aborts the process (Sentry ORBITAL-MOBILE-R).
// Upstream issue #2415 is unfixed and 8.3.1 ships the same code, so the fix is
// a local patch: patches/react-native-image-picker+8.2.1.patch, applied by
// patch-package from the root `postinstall`.
//
// That mechanism has three ways to rot silently, and this rule covers the parts
// of them that live in TRACKED content:
//   * the patch is deleted, emptied or regenerated without the fix;
//   * the postinstall loses a flag, so a patch that no longer applies (or
//     applies to the wrong version) degrades to a warning instead of exit 1;
//   * the pins drift, so the installed version stops matching the version the
//     patch was made for.
//
// HERMETIC on purpose: it never reads node_modules. Every other rule here runs
// on a bare checkout, and a rule that needed an install would pass vacuously
// wherever node_modules was absent or stale. The INSTALLED tree is gated
// separately, by scripts/verify-native-patches-ios.sh (an Xcode build phase, so
// it covers Product > Archive) and by the build.yml step after `npm ci`.
//
// Marker accounting has three clauses, because each catches a different edit:
//   * total markers >= NP_MARKER_FLOOR  — the current count. Deleting ONE
//     marker from a hunk that carries several would clear the per-hunk and
//     per-count floors below, so only a snapshot floor catches it. Regenerating
//     the patch legitimately means updating this number, deliberately, the way
//     rule 27's per-doc floors work.
//   * total markers >= hunk count       — self-calibrating: a new hunk cannot
//     ride along unmarked even if the floor above is stale.
//   * every hunk carries >= 1 marker    — the markers cannot bunch up in one
//     hunk and leave another unannotated.
const NP_RULE = 'native-patch-integrity';
const NP_ISSUE = '#971';
const NP_DIR = 'patches';
const NP_PKG = 'react-native-image-picker';
const NP_MARKER = 'ORBITAL-PATCH(#971)';
// The call upstream makes through its single shared `callback` property. Every
// double-call site read it, and the patch removes all ten, so a surviving
// occurrence on an added or context line means an incomplete patch.
const NP_BANNED_CALL = 'self.callback(';
// The patch's only legitimate target. A patch that reached further (the
// podspec, the JS, the Android sources) would change a different review
// surface than the one #971 signed off on.
const NP_PATCHED_FILE = `node_modules/${NP_PKG}/ios/ImagePickerManager.mm`;
const NP_MARKER_FLOOR = 39;
// Non-vacuity, in the shape rule 18 uses: this rule DELEGATES the installed-tree
// half to two detectors that it cannot run itself, so it asserts they are still
// wired up. Deleting either one is otherwise invisible — an Xcode build with a
// silently dropped script phase looks exactly like a passing one.
// Each needle is the INVOCATION, never the bare script path: build.yml also
// lists that path in its `paths:` trigger filter, so a path-only needle would
// still match after the step itself was deleted (caught while mutation-testing
// this clause).
const NP_GATE_SCRIPT = 'scripts/verify-native-patches-ios.sh';
const NP_PODFILE_GATE = 'the Podfile declaration of the Xcode build phase that covers Product > Archive';
// The Podfile is only the SOURCE of that phase: Xcode runs what pod install
// generated into the pbxproj. A Podfile edit committed without a `pod install`
// leaves the two out of step and the archive ungated, so the generated phase is
// checked too (both the name CocoaPods writes, prefixed `[CP-User] `, and the
// shell script, where the quotes are backslash-escaped).
const NP_PBXPROJ = 'ios/OrbitalMobile.xcodeproj/project.pbxproj';
const NP_PBXPROJ_GATE = 'the GENERATED Xcode build phase, which is the one Xcode.app and Product > Archive actually run';
const NP_GATES = [
  ['ios/Podfile', '[Orbital] Verify native patches', NP_PODFILE_GATE],
  ['ios/Podfile', `exec bash "\${SRCROOT}/../${NP_GATE_SCRIPT}"`, NP_PODFILE_GATE],
  [NP_PBXPROJ, '[Orbital] Verify native patches', NP_PBXPROJ_GATE],
  [NP_PBXPROJ, `exec bash \\"\${SRCROOT}/../${NP_GATE_SCRIPT}\\"`, NP_PBXPROJ_GATE],
  ['.github/workflows/build.yml', `bash ${NP_GATE_SCRIPT}`, "the iOS job's post-`npm ci` check"],
];

{
  let patchName = null;
  try {
    const entries = readdirSync(NP_DIR);
    const matches = entries.filter((e) => e.startsWith(`${NP_PKG}+`) && e.endsWith('.patch'));
    if (matches.length === 0) {
      violations.push(
        `  ${NP_DIR}/:0  [${NP_RULE}]  no ${NP_PKG}+<version>.patch found — the picker double-callback fix is gone, and patch-package exits 0 with an empty patches/ dir, so nothing else would notice (${NP_ISSUE})`,
      );
    } else if (matches.length > 1) {
      violations.push(
        `  ${NP_DIR}/:0  [${NP_RULE}]  ${matches.length} patches for ${NP_PKG} (${matches.join(', ')}) — patch-package would apply all of them and only one version can be installed; keep exactly one (${NP_ISSUE})`,
      );
    } else {
      patchName = matches[0];
    }
  } catch {
    violations.push(
      `  ${NP_DIR}/:0  [${NP_RULE}]  patches/ directory not found — the ${NP_PKG} double-callback fix (${NP_ISSUE}) lives there and patch-package silently succeeds without it`,
    );
  }

  let patchVersion = null;
  if (patchName !== null) {
    const m = /^react-native-image-picker\+(\d+\.\d+\.\d+)\.patch$/.exec(patchName);
    if (m === null) {
      violations.push(
        `  ${NP_DIR}/${patchName}:0  [${NP_RULE}]  filename does not carry a plain x.y.z version — patch-package keys the patch to the installed version by this name, and the pins below are checked against it (${NP_ISSUE})`,
      );
    } else {
      patchVersion = m[1];
    }
  }

  const patchFile = patchName === null ? null : join(NP_DIR, patchName);
  if (patchFile !== null) {
    let patchLines = null;
    try {
      patchLines = readFileSync(patchFile, 'utf8').split('\n');
    } catch {
      violations.push(
        `  ${patchFile}:0  [${NP_RULE}]  [file-missing] could not read the patch file (${NP_ISSUE})`,
      );
    }

    if (patchLines !== null) {
      let hunks = 0;
      let markers = 0;
      let markerlessHunks = 0;
      let currentHunkMarkers = 0;
      let sawHunk = false;
      const touched = new Set();

      for (let i = 0; i < patchLines.length; i++) {
        const line = patchLines[i];

        if (line.startsWith('@@')) {
          if (sawHunk && currentHunkMarkers === 0) markerlessHunks += 1;
          sawHunk = true;
          currentHunkMarkers = 0;
          hunks += 1;
          continue;
        }
        if (line.startsWith('+++ ') || line.startsWith('--- ')) {
          const path = line.slice(4).trim().replace(/^[ab]\//, '');
          if (path !== '/dev/null') touched.add(path);
          continue;
        }
        if (line.startsWith('diff --git') || line.startsWith('index ')) continue;

        const isAdded = line.startsWith('+');
        if (isAdded && line.includes(NP_MARKER)) {
          markers += 1;
          currentHunkMarkers += 1;
        }

        // Removed lines are the point of the patch; only what SURVIVES
        // (added + context) is checked for the banned call.
        if (!line.startsWith('-') && line.includes(NP_BANNED_CALL)) {
          report(
            patchFile,
            i + 1,
            NP_RULE,
            `patch keeps a raw \`${NP_BANNED_CALL}\` call — every launch must call back through its own taken context, or the double-callback abort is still reachable (${NP_ISSUE})`,
          );
        }
      }
      if (sawHunk && currentHunkMarkers === 0) markerlessHunks += 1;

      if (markers < NP_MARKER_FLOOR) {
        violations.push(
          `  ${patchFile}:0  [${NP_RULE}]  ${markers} \`${NP_MARKER}\` marker(s) on added lines, expected at least ${NP_MARKER_FLOOR} — a marked hunk shrank or lost its annotation. If the patch was deliberately regenerated, update NP_MARKER_FLOOR in this file to the new count (${NP_ISSUE})`,
        );
      }
      if (markers < hunks) {
        violations.push(
          `  ${patchFile}:0  [${NP_RULE}]  ${hunks} hunk(s) but only ${markers} \`${NP_MARKER}\` marker(s) on added lines — every hunk must say why it diverges from upstream (${NP_ISSUE})`,
        );
      }
      if (markerlessHunks > 0) {
        violations.push(
          `  ${patchFile}:0  [${NP_RULE}]  ${markerlessHunks} hunk(s) carry no \`${NP_MARKER}\` marker — annotate each one; the markers are also what the installed-tree gates grep for (${NP_ISSUE})`,
        );
      }
      if (hunks === 0) {
        violations.push(
          `  ${patchFile}:0  [${NP_RULE}]  the patch has no hunks — it would apply as a no-op and ship the unpatched picker (${NP_ISSUE})`,
        );
      }
      for (const path of touched) {
        if (path !== NP_PATCHED_FILE) {
          violations.push(
            `  ${patchFile}:0  [${NP_RULE}]  patch touches ${path}; ${NP_ISSUE} scopes it to ${NP_PATCHED_FILE} only. Widening it changes what ships natively — review it as native code, not as a dependency bump`,
          );
        }
      }
      if (!touched.has(NP_PATCHED_FILE)) {
        violations.push(
          `  ${patchFile}:0  [${NP_RULE}]  patch does not touch ${NP_PATCHED_FILE}, which is the file that carries the double-callback fix (${NP_ISSUE})`,
        );
      }
    }
  }

  for (const [gateFile, needle, what] of NP_GATES) {
    let content = null;
    try {
      content = readFileSync(gateFile, 'utf8');
    } catch {
      violations.push(
        `  ${gateFile}:0  [${NP_RULE}]  [file-missing] not found — it should carry ${what}, which is how the INSTALLED react-native-image-picker gets checked (this rule only sees tracked content) (${NP_ISSUE})`,
      );
      continue;
    }
    if (!content.includes(needle)) {
      violations.push(
        `  ${gateFile}:0  [${NP_RULE}]  no reference to \`${needle}\` — ${what} is gone, so an unpatched node_modules would compile and ship the double-callback abort with nothing to stop it (${NP_ISSUE})`,
      );
    }
  }

  let gateScriptExists = true;
  try {
    readFileSync(NP_GATE_SCRIPT, 'utf8');
  } catch {
    gateScriptExists = false;
  }
  if (!gateScriptExists) {
    violations.push(
      `  ${NP_GATE_SCRIPT}:0  [${NP_RULE}]  [file-missing] the installed-tree gate script is missing, but the Podfile build phase and build.yml both invoke it — the iOS build would fail noisily, or silently stop checking (${NP_ISSUE})`,
    );
  }

  let pkg = null;
  try {
    pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  } catch {
    violations.push(
      `  package.json:0  [${NP_RULE}]  [file-missing] could not read or parse package.json — the patch-package postinstall and the picker pin could not be checked (${NP_ISSUE})`,
    );
  }

  if (pkg !== null) {
    const postinstall = pkg.scripts?.postinstall ?? '';
    if (!postinstall.includes('patch-package')) {
      violations.push(
        `  package.json:0  [${NP_RULE}]  the \`postinstall\` script does not run patch-package — without it npm installs leave node_modules unpatched and the picker aborts the app at runtime (${NP_ISSUE})`,
      );
    } else {
      for (const flag of ['--error-on-fail', '--error-on-warn']) {
        if (!postinstall.includes(flag)) {
          violations.push(
            `  package.json:0  [${NP_RULE}]  \`postinstall\` is missing ${flag} — patch-package would only WARN (exit 0) when the patch fails to apply or was made for another version, so a silent downgrade to the unpatched picker would install cleanly (${NP_ISSUE})`,
          );
        }
      }
    }

    const ppVersion = pkg.devDependencies?.['patch-package'];
    if (ppVersion === undefined) {
      violations.push(
        `  package.json:0  [${NP_RULE}]  patch-package is not a devDependency, but the \`postinstall\` depends on it (${NP_ISSUE})`,
      );
    } else if (!/^\d+\.\d+\.\d+$/.test(ppVersion)) {
      violations.push(
        `  package.json:0  [${NP_RULE}]  patch-package is "${ppVersion}", not an exact x.y.z pin — it is this repo's only install-time code execution, so it moves on a reviewed bump, never on a range (${NP_ISSUE})`,
      );
    }

    if (patchVersion !== null) {
      const declared = pkg.dependencies?.[NP_PKG];
      if (declared !== patchVersion) {
        violations.push(
          `  package.json:0  [${NP_RULE}]  ${NP_PKG} is "${declared ?? 'absent'}" but the patch is keyed to ${patchVersion} — pin it EXACTLY (no caret), because any other resolved version makes patch-package fail the install (${NP_ISSUE})`,
        );
      }
    }
  }

  if (patchVersion !== null) {
    let lock = null;
    try {
      lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    } catch {
      violations.push(
        `  package-lock.json:0  [${NP_RULE}]  [file-missing] could not read or parse package-lock.json — the resolved ${NP_PKG} version could not be checked against the patch (${NP_ISSUE})`,
      );
    }

    if (lock !== null) {
      const rootSpec = lock.packages?.['']?.dependencies?.[NP_PKG];
      if (rootSpec !== patchVersion) {
        violations.push(
          `  package-lock.json:0  [${NP_RULE}]  root dependency spec for ${NP_PKG} is "${rootSpec ?? 'absent'}", not the patched ${patchVersion} — regenerate the lock (${NP_ISSUE})`,
        );
      }
      const resolved = lock.packages?.[`node_modules/${NP_PKG}`]?.version;
      if (resolved !== patchVersion) {
        violations.push(
          `  package-lock.json:0  [${NP_RULE}]  the lock resolves ${NP_PKG} to "${resolved ?? 'absent'}" but the patch is for ${patchVersion} — \`npm ci\` would install a version the patch cannot apply to (${NP_ISSUE})`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 29. archive-reader-native-pins: the Rust half (#920)
// ---------------------------------------------------------------------------

// orbital_archive_reader is the ONLY place in Orbital where hostile,
// attacker-chosen bytes are parsed by hand. It exists as a second crate (and a
// second binary) precisely so that parsing lives outside the key-holding
// orbital_signal library. Six properties make that separation real, none of
// them observable from JS, each of them a one-line edit away from being gone:
//
//   1. Memory safety. `#![deny(unsafe_code)]` crate-wide, with exactly ONE
//      exemption (`fd.rs`, adopting an FFI descriptor). An `unsafe {}` block
//      added to the ZIP parser would be unreviewed raw-pointer arithmetic over
//      attacker-controlled lengths.
//   2. A pure-Rust decompressor. flate2 with `default-features = false` +
//      `rust_backend` resolves to miniz_oxide. Any default-featured flate2, or
//      any libz/zlib-ng/zlib-rs backend, hands the inflate loop to C — the
//      exact code path with the CVE history this crate was built to avoid.
//   3. A closed dependency set. Four crates.io dependencies, no more: every
//      addition widens the trusted computing base of the parser.
//   4. The limits table. The caps are the bomb defence; `KIND_CAPS` having no
//      `Video` row is what keeps video entries listed-but-never-opened.
//   5. The allowlist. A denied root appearing as an allowlist row would make
//      `messages/` (private DMs, photos and all) readable by the importer.
//      F17's known-root-key set is the other half: it is what stops a wrapper
//      strip from rewriting a real export's paths, and it must name every root
//      on BOTH sides.
//   6. Silence. No logging macro anywhere: an archive path or URI reaching a
//      log is a privacy leak (and `log::` would also add a dependency).
//
// Matching runs on COMMENT-STRIPPED source, because this crate documents each
// of these bans in its own prose — `fd.rs`'s header names `unsafe`, lib.rs's
// header quotes `#![deny(unsafe_code)]`, Cargo.toml explains why there is no
// `panic =` key, and allowlist.rs lists every denied root in a doc comment.
// Raw-text matching would be satisfied by all of it. The ONE deliberate
// exception is the no-key-material header phrase, which is prose by nature and
// is checked on raw text; it is flagged as such below.
//
// Every file is read as a NAMED file: a missing one is a violation, never a
// pass. The glue clauses (.mm / .kt / manifests / ubrn.config.yaml) and rule
// 29a (import restriction) land with the native layer in PR2.

const AR_RULE = 'archive-reader-native-pins';
// AR_ISSUE is declared with ARCHIVE_ACCESS above — rules 18, 24d and 24e cite
// it before this block runs.
// One spelling of the crate path in this file: rule 18 already needs it.
const AR_CRATE = ARCHIVE_CRATE_REL;
const AR_SRC = join(AR_CRATE, 'src');
const AR_LIB = join(AR_SRC, 'lib.rs');
const AR_FD = join(AR_SRC, 'fd.rs');
const AR_LIMITS = join(AR_SRC, 'limits.rs');
const AR_ALLOWLIST = join(AR_SRC, 'allowlist.rs');
const AR_TOML = join(AR_CRATE, 'Cargo.toml');
const AR_LOCK = join(AR_CRATE, 'Cargo.lock');

function arViolation(file, detail) {
  violations.push(`  ${relative('.', file)}:0  [${AR_RULE}]  ${detail} (${AR_ISSUE})`);
}

// --- 29.1 Safety posture across every module.
//
// The `unsafe` matcher is the F9 form: the keyword followed by a block, fn,
// impl, extern or trait. It is deliberately NOT case-insensitive — Rust
// keywords are case-sensitive, so `UNSAFE {` is not unsafe code, it is a
// syntax error. `\s*` (not `\s+`) before the brace is what catches the
// `unsafe\n{` line-break variant, which rustfmt will not produce but a hand
// edit can.
// Matched over the WHOLE comment-stripped file, not line by line: `\s*` has
// to be able to cross the newline for the `unsafe\n{` variant to be caught.
const AR_UNSAFE_RE = /\bunsafe\s*(\{|fn\b|impl\b|extern\b|trait\b)/g;
// `log::` covers the log facade; bare `tracing` covers tracing and
// tracing::debug! alike. On comment-stripped source these can only be code.
const AR_LOG_TOKENS = ['println!', 'eprintln!', 'print!', 'eprint!', 'dbg!', 'log::', 'tracing'];
// fd.rs is NOT exempt, it is BOUNDED. A wholesale exemption makes the one file
// that is allowed to contain `unsafe` the one file where any amount of it is
// invisible — and it is also the file an attacker-facing descriptor arrives
// through. So: exactly one unsafe construct, it must be an `unsafe {`
// expression (not an `unsafe fn`, which would push the obligation onto every
// caller), exactly one `allow(unsafe_code)`, and the two APIs that make the
// containment argument work must both still be there. `borrow_raw` is the
// unsafe step; `try_clone_to_owned` is what makes it a dup this crate owns, so
// losing it would mean the crate closes the glue's descriptor (F2).
const AR_FD_REQUIRED = ['BorrowedFd::borrow_raw', 'try_clone_to_owned'];

let arSrcFiles = [];
try {
  arSrcFiles = walkSync(AR_SRC, ['.rs']);
} catch {
  arViolation(AR_SRC, 'crate src/ directory not found — every clause below would pass vacuously');
}
if (arSrcFiles.length === 0) {
  arViolation(AR_SRC, 'no .rs files under the crate src/ — every clause below would pass vacuously');
}
for (const file of arSrcFiles) {
  const text = readFileSync(file, 'utf8');
  const code = stripCStyleComments(text);
  const lines = code.split('\n');
  const isFd = relative('.', file) === relative('.', AR_FD);
  const unsafeHits = [...code.matchAll(AR_UNSAFE_RE)];
  const allowHits = code.match(/allow\(unsafe_code\)/g) ?? [];
  if (isFd) {
    if (unsafeHits.length !== 1) {
      arViolation(file, `fd.rs contains ${unsafeHits.length} \`unsafe\` construct(s) — exactly one is allowed, the \`BorrowedFd::borrow_raw\` dup. Found: ${unsafeHits.map((h) => h[0].replace(/\s+/g, ' ')).join(', ') || 'none'}`);
    } else if (unsafeHits[0][1] !== '{') {
      arViolation(file, `fd.rs's single \`unsafe\` construct is \`${unsafeHits[0][0].replace(/\s+/g, ' ')}\` — it must be an \`unsafe {\` expression, so the obligation stays inside this file instead of moving to every caller`);
    }
    if (allowHits.length !== 1) {
      arViolation(file, `fd.rs carries ${allowHits.length} \`allow(unsafe_code)\` attribute(s) — exactly one, on the dup function, is allowed`);
    }
    for (const pin of AR_FD_REQUIRED) {
      if (!code.includes(pin)) {
        arViolation(file, `fd.rs no longer calls \`${pin}\` — the one permitted \`unsafe\` block is only defensible as borrow_raw immediately followed by a dup this crate owns`);
      }
    }
  } else {
    for (const m of unsafeHits) {
      const lineNum = code.slice(0, m.index).split('\n').length;
      report(file, lineNum, AR_RULE, `\`unsafe\` outside fd.rs: ${m[0].replace(/\s+/g, ' ')} (${AR_ISSUE})`);
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!isFd && line.includes('allow(unsafe_code)')) {
      report(file, i + 1, AR_RULE, `\`allow(unsafe_code)\` outside fd.rs: ${line.trim()} (${AR_ISSUE})`);
    }
    if (line.includes('global_allocator')) {
      report(file, i + 1, AR_RULE, `custom global allocator in a hostile-input parser: ${line.trim()} (${AR_ISSUE})`);
    }
    for (const token of AR_LOG_TOKENS) {
      if (line.includes(token)) {
        report(file, i + 1, AR_RULE, `logging in the archive reader (\`${token}\`) — paths and URIs must never reach a log: ${line.trim()} (${AR_ISSUE})`);
      }
    }
  }
}

// The crate-wide deny, matched from the first inner attribute so that deleting
// the attribute block loses the window and fails rather than passing.
checkWindowedPins(
  AR_LIB,
  AR_RULE,
  /^#!\[[\s\S]*/m,
  "lib.rs's crate attribute block",
  ['#![deny(unsafe_code)]'],
  [],
  AR_ISSUE,
);

// RAW TEXT, deliberately: this is a documentation pin, not a code pin. The
// crate header is the contract the security audit and the FFI review read —
// "no key material crosses this boundary" is why the parser was split out of
// orbital_signal at all, and a silent deletion would erase the rationale that
// keeps crypto out of this crate.
const AR_HEADER_PHRASE = 'No key material, no ciphertext and no credential';
const arLibRaw = meRead(AR_LIB, AR_RULE, 'the no-key-material header contract', AR_ISSUE);
if (arLibRaw !== null && !arLibRaw.includes(AR_HEADER_PHRASE)) {
  arViolation(AR_LIB, `the crate header no longer states "${AR_HEADER_PHRASE} …" — that contract is why hostile-input parsing lives outside the key-holding crate`);
}

// --- 29.2 The closed dependency set and the release profile.
const AR_ALLOWED_DEPS = new Set(['uniffi', 'thiserror', 'flate2', 'crc32fast']);
// Non-vacuity anchors: a `[dependencies]` table emptied of these would satisfy
// the subset check trivially.
const AR_REQUIRED_DEPS = ['uniffi', 'flate2'];
// EVERY dependency table, in BOTH TOML spellings:
//
//   short form  [dependencies] / [build-dependencies] /
//               [target.'cfg(unix)'.dependencies]      -> crates are body keys
//   long form   [dependencies.libc] /
//               [target.'cfg(unix)'.dependencies.nix]  -> the crate is the
//                                                         HEADER's last segment
//
// The long form has no `libc = …` line anywhere, so a body-only scan saw an
// empty table and passed (PR #977 re-review, probe-proven by two reviewers).
// `[dev-dependencies]` and `[dev-dependencies.tempfile]` are the documented
// carve-out — they repeat flate2 and crc32fast for the ZIP generator in
// tests/support, are never part of the cdylib/staticlib, and adding a test
// helper must not need an invariant edit. Note that `dev-dependencies` cannot
// match AR_DEP_HEADER_RE anyway (the character before `dependencies` is `-`,
// not `.` or start); the explicit skip is there to say so out loud.
const AR_DEP_TABLE_RE = /^\[([^\]]+)\]\n?([\s\S]*?)(?=^\[|(?![\s\S]))/gm;
const AR_DEP_HEADER_RE = /(^|\.)(?:build-)?dependencies(?:\.([^.\]]+))?$/;
const AR_DEV_DEP_HEADER_RE = /(^|\.)dev-dependencies(?:\.([^.\]]+))?$/;
const arToml = meRead(AR_TOML, AR_RULE, 'the dependency-set and release-profile clauses', AR_ISSUE);
if (arToml !== null) {
  // TOML uses shell comment syntax; this file's comments explain the bans.
  const tomlCode = stripShellComments(arToml);
  const depTables = [];
  AR_DEP_TABLE_RE.lastIndex = 0;
  let table;
  while ((table = AR_DEP_TABLE_RE.exec(tomlCode)) !== null) {
    const name = table[1].trim();
    if (AR_DEV_DEP_HEADER_RE.test(name)) continue;
    const header = AR_DEP_HEADER_RE.exec(name);
    if (header === null) continue;
    depTables.push({
      name,
      // Long form: the crate is named in the header, not in the body.
      crate: header[2] ? header[2].replace(/^['"]|['"]$/g, '') : null,
      body: table[2],
    });
  }
  if (depTables.length === 0) {
    arViolation(AR_TOML, 'no dependency table (`[dependencies]`, `[build-dependencies]`, `[target.*.dependencies]`, or any `.<crate>` long form) — the closed-dependency-set clause would pass vacuously');
  } else {
    const keys = new Map(); // crate -> the table it was declared in
    for (const { name, crate, body } of depTables) {
      if (crate !== null) {
        keys.set(crate, name);
        continue;
      }
      for (const line of body.split('\n')) {
        // `["']?` for the quoted spelling; the optional `\.<field>` tail takes
        // the CRATE from the dotted spelling (`libc.version = "0.2"`), which a
        // bare-key match would have skipped entirely.
        const key = /^\s*["']?([A-Za-z0-9_-]+)(?:\.[A-Za-z0-9_-]+)?["']?\s*=/.exec(line);
        if (key) keys.set(key[1], name);
      }
    }
    for (const [key, name] of keys) {
      if (!AR_ALLOWED_DEPS.has(key)) {
        arViolation(AR_TOML, `\`${key}\` is a new [${name}] entry — the archive reader's dependency set is closed at {${[...AR_ALLOWED_DEPS].join(', ')}}; widening the trusted computing base of a hostile-input parser is a deliberate edit of this rule`);
      }
    }
    for (const key of AR_REQUIRED_DEPS) {
      if (!keys.has(key)) {
        arViolation(AR_TOML, `\`${key}\` is missing from every dependency table — the closed-set check above would pass vacuously`);
      }
    }
    // The flate2 declaration, in whichever spelling: a `flate2 = { … }` line
    // in a short-form table, or the whole body of a `[dependencies.flate2]`
    // long-form table.
    const flate2Long = depTables.find((t) => t.crate === 'flate2');
    const flate2Short = /^\s*flate2\s*=.*$/m.exec(
      depTables.filter((t) => t.crate === null).map((t) => t.body).join('\n'),
    );
    const flate2Decl = flate2Long ? flate2Long.body : flate2Short?.[0];
    if (flate2Decl === undefined) {
      arViolation(AR_TOML, 'no flate2 declaration to check the backend on');
    } else {
      for (const need of ['default-features = false', '"rust_backend"']) {
        if (!flate2Decl.includes(need)) {
          arViolation(AR_TOML, `flate2 is declared without \`${need}\` — inflate would run in C (libz/zlib-ng), not miniz_oxide, in the one crate that parses hostile bytes: ${flate2Decl.trim().replace(/\s+/g, ' ').slice(0, 120)}`);
        }
      }
    }
  }
}

// `overflow-checks = true` keeps attacker-driven arithmetic from wrapping
// silently in release. `panic =` is forbidden: `panic = "abort"` would turn
// every defensive panic in the parser into a kill of the whole host app.
// stripShellComments is passed because this table's own comment explains both,
// and `# overflow-checks = true` must not satisfy the pin (mutation 29-18).
checkWindowedPins(
  AR_TOML,
  AR_RULE,
  /^\[profile\.release\][\s\S]*?(?=^\[|(?![\s\S]))/m,
  "the archive crate's [profile.release] table",
  ['overflow-checks = true'],
  ['panic ='],
  AR_ISSUE,
  stripShellComments,
);

// --- 29.3 The lock proves the pure-Rust backend actually resolved.
// miniz_oxide is the non-vacuity anchor: without it the absence of every C
// backend below would also be satisfied by a lock with no decompressor at all.
const AR_LOCK_REQUIRED = ['miniz_oxide'];
const AR_LOCK_FORBIDDEN = ['libz-sys', 'libz-ng-sys', 'zlib-rs', 'cloudflare-zlib-sys', 'miniz-sys', 'zip'];
const arLock = meRead(AR_LOCK, AR_RULE, 'the resolved decompressor backend', AR_ISSUE);
if (arLock !== null) {
  for (const pkg of AR_LOCK_REQUIRED) {
    if (!arLock.includes(`name = "${pkg}"`)) {
      arViolation(AR_LOCK, `\`${pkg}\` is not in the resolved graph — the pure-Rust inflate backend is gone, so the "no C zlib" clause below would pass vacuously`);
    }
  }
  for (const pkg of AR_LOCK_FORBIDDEN) {
    if (arLock.includes(`name = "${pkg}"`)) {
      arViolation(AR_LOCK, `\`${pkg}\` resolved into the archive reader's graph — hostile archive bytes must be inflated by memory-safe Rust (miniz_oxide) and never by a C zlib or a third-party ZIP crate`);
    }
  }
}

// --- 29.4 The limits table.
//
// The Json row is 12 MiB and the pin says so. It is a JS-HEAP budget: read_json
// hands the whole text across the FFI as a String, and the B3 Hermes
// measurement put peak RSS at ~10x the input bytes (UTF-16 copy + parsed graph
// + intermediates coexisting). At 32 MiB — the value this row carried until
// Alex's 2026-11-09 decision — that is an allocation failure Hermes aborts the
// process on: uncatchable from JS, so no typed error, no retry, no crash
// breadcrumb beyond a jetsam-style kill. Raising it again requires a fresh
// on-device measurement, which is why the literal is pinned here and not left
// to review.
checkWindowedPins(
  AR_LIMITS,
  AR_RULE,
  /^pub const KIND_CAPS[\s\S]*?\];/m,
  'the KIND_CAPS table',
  ['(EntryKind::Json, 12 * MIB)', '(EntryKind::Image, 50 * MIB)'],
  // A `Video` row would make video entries extractable. They are listed so a
  // post can be shown whole, and never opened: kind_cap returns None, which
  // becomes EntryKindNotEnabled.
  ['Video'],
  AR_ISSUE,
);

checkWindowedPins(
  AR_LIMITS,
  AR_RULE,
  /^pub const KIB[\s\S]*/m,
  "limits.rs's constant block",
  // Full declarations, not bare numbers: the file's own #[cfg(test)] module
  // asserts `MAX_RATIO, 100` and `HEAD_PEEK_BYTES, 128`, and a bare-literal
  // pin would be satisfied by those asserts after the consts had changed.
  [
    'pub const MAX_RATIO: u64 = 100;',
    'pub const HEAD_PEEK_BYTES: usize = 128;',
    // The session-wide central-directory record bound (PR #977 review).
    // Without it, 64 parts x 1M records keeps ~512 MB of lh_offsets alive and
    // the OS jetsams the app — a limit whose absence is invisible in every
    // single-part test.
    'pub const MAX_CD_RECORDS_PER_SESSION: u64 = 2_000_000;',
    // The retained-path byte budget (PR #977 re-review). 100k listed entries x
    // 1 KiB paths x three retained copies is ~320 MB — again a jetsam kill
    // rather than a typed error, and again invisible in small-archive tests.
    'pub const MAX_RETAINED_PATH_BYTES: u64 = 64 * MIB;',
    // The JS-heap ceiling, pinned separately from the KIND_CAPS Json row
    // above. read_json takes the MINIMUM of the two, so lowering the kind cap
    // while leaving this at 32 MiB would look consistent and lowering THIS
    // while leaving the row high would too — only pinning both says which
    // number the Hermes measurement licensed (12 MiB, Alex 2026-11-09).
    'pub const MAX_JSON_BYTES: u64 = 12 * MIB;',
  ],
  [],
  AR_ISSUE,
);

// --- 29.5 The allowlist tables.
//
// The forbidden list is DERIVED from DENIED_ROOTS rather than restated. A
// hand-written list drifted immediately: the first version forbade 7 of the 10
// roots, leaving `inbox`, `profile` and `other_content` admissible as allowlist
// rows (PR #977 review). Deriving it means adding a denied root automatically
// forbids it as a row. The floor of 10 is what stops the derivation from being
// weakened the easy way — shortening DENIED_ROOTS would otherwise shrink the
// forbidden list silently, and it is also the F17 known-root set, so a short
// table makes a denied root strippable too.
const AR_DENIED_ROOTS_FLOOR = 10;
const arAllowlistRaw = meRead(AR_ALLOWLIST, AR_RULE, 'the denied-root tables', AR_ISSUE);
let arDeniedRoots = [];
if (arAllowlistRaw !== null) {
  // `\s*:` after the NAME, not `[^=]*`: the loose form also matched a RENAMED
  // const (`pub const DENIED_ROOTS_X: [&str; 10] = [` — `_X: [&str; 10] ` holds
  // no `=`, so it slipped through `[^=]*`), which made this clause and 29.7's
  // parity check read a table whose name nothing in the crate refers to any
  // more. Mutation P7 (#982) found it. A rename is also a Rust compile error,
  // so this was never a silent security hole — but a vacuity guard that cannot
  // see a rename is not a vacuity guard.
  const table = /^pub const DENIED_ROOTS\s*:[^=]*=\s*\[([\s\S]*?)\];/m.exec(
    stripCStyleComments(arAllowlistRaw),
  );
  if (table === null) {
    arViolation(AR_ALLOWLIST, 'no DENIED_ROOTS table — the forbidden-allowlist-row list is derived from it and would be empty');
  } else {
    arDeniedRoots = [...table[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    if (arDeniedRoots.length < AR_DENIED_ROOTS_FLOOR) {
      arViolation(AR_ALLOWLIST, `DENIED_ROOTS lists ${arDeniedRoots.length} roots, below the floor of ${AR_DENIED_ROOTS_FLOOR} — a shortened table both narrows the forbidden-row list below and makes the dropped root strippable by the F17 wrapper strip`);
    }
  }
}

// Required rows are the ones CONFIRMED by name against the local FB and IG
// samples; they are also the non-vacuity anchors for the forbidden list.
checkWindowedPins(
  AR_ALLOWLIST,
  AR_RULE,
  /^const JSON_EXACT[\s\S]*?^const MEDIA_PREFIXES[\s\S]*?\n\];/m,
  'the allowlist tables (JSON_EXACT through MEDIA_PREFIXES)',
  [
    '"your_facebook_activity/posts/your_posts__check_ins__photos_and_videos_"',
    '"your_instagram_activity/media/posts_"',
    '"your_instagram_activity/media/posts.json"',
    '"your_facebook_activity/posts/media/"',
    '"media/posts/"',
  ],
  // A denied root appearing as an allowlist ROW is the one way this crate
  // could ever open private data. These are substrings, so `messages` also
  // catches `messages/inbox/…`, and the check runs on the comment-stripped
  // window, so allowlist.rs's own header listing all of them does not count.
  arDeniedRoots,
  AR_ISSUE,
);

// Defence in depth inside classify() itself, since the tables are edited far
// more often than the function: a denied first segment is refused BEFORE any
// row is consulted, so a future row that happens to overlap a denied root is
// inert instead of silently opening private data. The ordering is asserted,
// not just the presence — a guard after the JSON_EXACT lookup would be a guard
// that the first matching row has already bypassed.
const AR_CLASSIFY_GUARD = 'if starts_with_denied_root(path) {';
if (arAllowlistRaw !== null) {
  const body = /^pub fn classify\(path: &str\) -> Verdict \{[\s\S]*?\n\}/m.exec(
    stripCStyleComments(arAllowlistRaw),
  );
  if (body === null) {
    arViolation(AR_ALLOWLIST, 'classify() not found — the denied-root refusal cannot be verified and the rule would pass vacuously');
  } else {
    const guardAt = body[0].indexOf(AR_CLASSIFY_GUARD);
    const firstTableAt = body[0].indexOf('JSON_EXACT');
    if (guardAt < 0) {
      arViolation(AR_ALLOWLIST, `classify() no longer refuses denied roots — \`${AR_CLASSIFY_GUARD}\` is missing, so the allowlist tables are the only thing standing between the importer and messages/`);
    } else if (firstTableAt >= 0 && guardAt > firstTableAt) {
      arViolation(AR_ALLOWLIST, 'the denied-root refusal in classify() runs AFTER the first allowlist table is consulted — a row matching a denied path would already have returned Listed');
    }
  }
}

// F17: the known-root-key set must name every root on BOTH sides, and
// is_known_root_key must consult both tables. A denied root dropped from
// DENIED_ROOTS would become strippable: on the real FB sample every entry
// shares the single root `your_facebook_activity`, so the unanimous-wrapper
// strip fires and only this exemption keeps the paths intact — strip it and
// the only posts JSON in the export stops matching the allowlist and the
// import silently loses every post.
checkWindowedPins(
  AR_ALLOWLIST,
  AR_RULE,
  /^pub const ALLOWED_ROOTS[\s\S]*?^pub fn is_known_root_key[\s\S]*?\n\}/m,
  'the ALLOWED_ROOTS / DENIED_ROOTS tables and is_known_root_key',
  [
    // Allowed roots (F17).
    '"your_facebook_activity"',
    '"your_activity_across_facebook"',
    '"your_instagram_activity"',
    '"posts"',
    '"media"',
    '"content"',
    '"photos_and_videos"',
    // Denied roots (F17). Named, not merely absent, so a wrapper directory
    // called after one of them can never be stripped away.
    '"messages"',
    '"inbox"',
    '"friends_and_followers"',
    '"ads_information"',
    '"security_and_login_information"',
    '"personal_information"',
    '"stories"',
    '"reels"',
    '"profile"',
    '"other_content"',
    // Both tables are actually consulted.
    'ALLOWED_ROOTS.contains(&segment)',
    'DENIED_ROOTS.contains(&segment)',
  ],
  [],
  AR_ISSUE,
);

// --- 29.6 The native glue (#920 PR2).
//
// Rust owns the parsing; these two files own everything Rust cannot see — which
// document the user picked, which descriptor it arrives on, where the extracted
// bytes land, and for how long the app keeps the right to re-read the archive.
// None of it is observable from a unit test on either platform, and all of it
// is one keyword away from a different security posture:
//
//   COPY vs REFERENCE. `asCopy:NO` / `ACTION_OPEN_DOCUMENT` give a reference to
//   the user's file. The one-character alternatives (`asCopy:YES`,
//   `ACTION_GET_CONTENT`, `copyItemAtURL`) make the OS duplicate a multi-GB ZIP
//   into this app's container first: it fails on a full device, it doubles the
//   user's disk, and the copy is then OURS to wipe — a plaintext archive of the
//   user's whole social history sitting in a sandbox a localWipe has to find.
//
//   DESCRIPTOR vs STREAM. The Rust reader seeks; `openInputStream` and the
//   asset-fd variants do not give a seekable fd, so reaching for one is how a
//   future edit would silently fall back to buffering the archive in memory.
//   `Os.fstat` + `S_ISREG` is the check that refuses a pipe or a directory
//   before the reader ever trusts an offset.
//
//   READ-ONLY. Every descriptor is opened `"r"` / without `O_RDWR`/`O_WRONLY`,
//   and the SAF grant taken is read-only. A write handle on a document the user
//   picked means a parser bug can CORRUPT the user's only copy of their export.
//
//   CONFINEMENT. Staging goes to the internal `cacheDir` (never
//   `externalCacheDir`, which is world-readable on older API levels), under the
//   `-archive-staging.bin` suffix the wipe sweep and the bootstrap reaper
//   recognise, and `canonicalPath` / `realpath(` are what stop a traversal in a
//   caller-supplied path from unlinking something else.
//
//   SILENCE. Every diagnostic sink is banned, not just the obvious two. A
//   logging call in either file writes archive paths and media URIs — the
//   names of a user's photos, and on Android the document URI that is itself a
//   capability — to a device log any other app's crash reporter can read.
//   `NSLog`, `os_log`, `android.util.Log` and the per-level `Log.x(` calls are
//   the idiomatic sinks; `printf`/`fprintf` and `RCTLog` on the .mm side and
//   `println(`, `System.out`, `System.err` and `printStackTrace` on the Kotlin
//   side are the ones a debugging session actually reaches for, which is
//   exactly when a temporary print gets committed. The `.mm` bans are
//   SUBSTRINGS: `printf` also covers `snprintf`/`asprintf`, which is
//   deliberate — this file formats nothing — and a future legitimate need
//   would have to carve itself an explicit exemption here rather than slip in
//   under an existing token.
//
// Matching is on COMMENT-STRIPPED source for the usual reason: both files
// document every one of these bans in prose, naming the forbidden API, and raw
// text would be satisfied by the documentation. Both windows are anchored on a
// structural declaration, so deleting the class loses the window and FAILS
// rather than passing vacuously.

const AR_MM = join(ARCHIVE_PKG_REL, 'ios', 'OrbitalArchiveAccess.mm');
const AR_ANDROID_JAVA = join(
  ARCHIVE_PKG_REL, 'android', 'src', 'main', 'java', 'com', 'orbital', 'archivereader',
);
const AR_KT = join(AR_ANDROID_JAVA, 'OrbitalArchiveAccessModule.kt');
const AR_PACKAGE_KT = join(AR_ANDROID_JAVA, 'OrbitalArchiveReaderPackage.kt');
const AR_MANIFEST_DIR = join(ARCHIVE_PKG_REL, 'android', 'src', 'main');

// TODO(#920 F15): pin the data-protection class here once smoke step 4 reports.
// That leg extracts an entry, locks the device for two minutes and then runs
// the upload read loop (RNFS reopens per MiB). If it passes, pin
// `NSFileProtectionCompleteUnlessOpen`; if the locked-device reopen fails, the
// glue switches to `…CompleteUntilFirstUserAuthentication` and THAT gets
// pinned. Pinning either string before the measurement would freeze a guess —
// and the .mm's own closing note says so. `NSFileProtectionNone` is forbidden
// below either way: that is the one answer no measurement can license.
checkWindowedPins(
  AR_MM,
  AR_RULE,
  // Whole file from its first #import: the staging-leaf constant and the
  // realpath(3) helper are file-level statics ABOVE both classes, so a
  // class-anchored window would miss them. Both class declarations are pinned
  // as tokens instead, so deleting either still fires, and an emptied file has
  // no #import and so no window at all.
  /^#import[\s\S]*/m,
  'the OrbitalArchiveAccess glue',
  [
    '@interface OAAPickSession',
    '@implementation OrbitalArchiveAccess',
    'asCopy:NO',
    'allowsMultipleSelection = YES',
    'startAccessingSecurityScopedResource',
    'stopAccessingSecurityScopedResource',
    'NSFileCoordinator',
    'NSURLIsExcludedFromBackupKey',
    'O_CLOEXEC',
    '-archive-staging.bin',
    'RCTPresentedViewController',
    'realpath(',
  ],
  [
    'asCopy:YES',
    'UIDocumentPickerModeImport',
    'initWithDocumentTypes',
    'copyItemAtURL',
    'copyItemAtPath',
    'NSFileProtectionNone',
    'NSLog',
    'os_log',
    // Substring bans, and the `printf` one is doing more work than it looks:
    // it also catches `snprintf`, `asprintf` and `vsnprintf`. That is the
    // intent — this file builds no formatted strings at all, so any of them
    // appearing means something is being composed out of a path or an OS error
    // string. A future legitimate `snprintf` needs an explicit carve-out
    // added here, not a silent pass under the existing token.
    'printf',
    'fprintf',
    // React's own logger, which routes to NSLog in debug and to the JS console
    // in dev — both of which carry whatever was interpolated into a log
    // aggregator. Banning the PREFIX covers RCTLogInfo/Warn/Error/Trace and
    // the `#import <React/RCTLog.h>` that enables them.
    'RCTLog',
    'O_RDWR',
    'O_WRONLY',
  ],
  AR_ISSUE,
  stripCStyleComments,
);

checkWindowedPins(
  AR_KT,
  AR_RULE,
  // From the PACKAGE declaration, not the class: the import block has to be
  // inside the window or `import android.util.Log` sits above it, where the
  // logging ban cannot see it (#982). Re-anchoring this way loses "deleting
  // the class loses the window", so the class declaration is pinned as a token
  // below instead — the same shape the .mm already uses. An emptied file has
  // no package line and so no window at all.
  /^package com\.orbital\.archivereader[\s\S]*/m,
  'the OrbitalArchiveAccessModule glue',
  [
    // WITH the opening paren of the primary constructor: a bare
    // `class OrbitalArchiveAccessModule` is a substring of
    // `class OrbitalArchiveAccessModuleSomethingElse`, so a rename would still
    // satisfy it (proven by mutation K10).
    'class OrbitalArchiveAccessModule(',
    // The content-scheme fence on every ref before it reaches
    // openFileDescriptor. Pinned as the CONSTANT: a string literal would be
    // mangled by stripCStyleComments (which is not string-aware) and would be
    // satisfiable from a comment, and the fence is what stops a tampered token
    // naming a local file from being opened as an archive part.
    'ContentResolver.SCHEME_CONTENT',
    'ACTION_OPEN_DOCUMENT',
    'EXTRA_ALLOW_MULTIPLE',
    'openFileDescriptor(',
    'Os.fstat',
    'S_ISREG',
    'cacheDir',
    'canonicalPath',
    '-archive-staging.bin',
    'takePersistableUriPermission',
    'releasePersistableUriPermission',
    'persistedUriPermissions',
    // RN calls invalidate() on a catalyst teardown (reload, Fast Refresh, host
    // destroy). Without an override, every open descriptor and every staging
    // file leaks across a reload, and the pending-pick promise never settles.
    'override fun invalidate',
  ],
  [
    'openInputStream',
    'openAssetFileDescriptor',
    'openTypedAssetFileDescriptor',
    // Substring, so it also catches getExternalCacheDirs() and friends. Note
    // `cacheDir` above is a substring of `externalCacheDir`, i.e. swapping the
    // internal dir for the external one would still satisfy the pin — this ban
    // is what makes that swap fire.
    'externalCacheDir',
    'getExternalStorage',
    // LOAD-BEARING, and not redundant with the call bans below: this is the
    // only clause that catches an ALIASED import (`import android.util.Log as
    // L`, then `L.d(...)`, which matches none of the `Log.x(` tokens). It only
    // works because the window now starts at the package line. Do not prune it
    // as duplicative.
    'android.util.Log',
    'Log.d(',
    'Log.e(',
    'Log.i(',
    'Log.w(',
    'Log.v(',
    'Log.wtf(',
    // The sinks a debugging session reaches for. All four write to logcat on
    // Android, where a document URI is readable by anything with log access.
    'println(',
    'System.out',
    'System.err',
    'printStackTrace',
    'ACTION_GET_CONTENT',
    'MODE_WORLD',
  ],
  AR_ISSUE,
  stripCStyleComments,
);

// Two Kotlin clauses that a token list cannot express, both about WRITE access.
const arKtRaw = meRead(AR_KT, AR_RULE, 'the read-only descriptor and grant clauses', AR_ISSUE);
if (arKtRaw !== null) {
  const arKtCode = stripCStyleComments(arKtRaw);

  // 1. Every openFileDescriptor() call opens READ-ONLY. A file-wide ban on the
  //    `"rw"` / `"w"` literals is too blunt (they are ordinary strings
  //    elsewhere) and too weak (`"rwt"`, `"wa"`, a mode held in a val). So the
  //    MODE ARGUMENT of each call is read instead: it must be the literal "r".
  const AR_OFD_RE = /openFileDescriptor\s*\(([^)]*)\)/g;
  AR_OFD_RE.lastIndex = 0;
  let ofd;
  let ofdSeen = 0;
  while ((ofd = AR_OFD_RE.exec(arKtCode)) !== null) {
    ofdSeen += 1;
    if (!/,\s*"r"\s*$/.test(ofd[1].trim())) {
      report(
        AR_KT,
        arKtCode.slice(0, ofd.index).split('\n').length,
        AR_RULE,
        `openFileDescriptor() must take the literal mode "r" — a write handle on a document the user picked lets a parser bug corrupt the only copy of their export: ${ofd[0].replace(/\s+/g, ' ')} (${AR_ISSUE})`,
      );
    }
  }
  if (ofdSeen === 0) {
    arViolation(AR_KT, 'no openFileDescriptor() call — the read-only-mode clause would pass vacuously, and the reader needs a SEEKABLE descriptor (openInputStream is banned above)');
  }

  // 2. The WRITE grant flag may appear ONLY inside releaseAllPersistedParts,
  //    where releasing a grant the user somehow holds is the whole point. Taken
  //    anywhere else — the picker Intent, takePersistableUriPermission — it
  //    would hand this app durable write access to the user's archive files.
  const arRelease = /^ {2}override fun releaseAllPersistedParts\([\s\S]*?\n {2}\}/m.exec(arKtCode);
  if (arRelease === null) {
    arViolation(AR_KT, 'releaseAllPersistedParts() not found — localWipe\'s deletion path (rule 24e) calls it, and the write-flag containment clause below would pass vacuously');
  } else {
    const releaseStart = arRelease.index;
    const releaseEnd = releaseStart + arRelease[0].length;
    for (let at = arKtCode.indexOf('FLAG_GRANT_WRITE_URI_PERMISSION'); at !== -1; at = arKtCode.indexOf('FLAG_GRANT_WRITE_URI_PERMISSION', at + 1)) {
      if (at >= releaseStart && at < releaseEnd) continue;
      report(
        AR_KT,
        arKtCode.slice(0, at).split('\n').length,
        AR_RULE,
        `FLAG_GRANT_WRITE_URI_PERMISSION outside releaseAllPersistedParts() — the SAF grant this app takes and persists must be READ-ONLY; releasing a write grant is the only legitimate mention (${AR_ISSUE})`,
      );
    }
  }
}

// Both package manifests, ZERO permissions. Everything this package touches is
// reached through a user-granted SAF document URI, which needs no permission at
// all; a `<uses-permission>` here would widen the APP's declared surface
// (library manifests are merged into it) and change the Play Data Safety
// answers, with nothing in the app's own manifest to show for it. XML comments
// are stripped because AndroidManifestNew.xml explains this ban in a comment
// that names the tag.
for (const manifest of ['AndroidManifest.xml', 'AndroidManifestNew.xml']) {
  checkWindowedPins(
    join(AR_MANIFEST_DIR, manifest),
    AR_RULE,
    /<manifest[\s\S]*<\/manifest>/m,
    `the ${manifest} <manifest> element`,
    [],
    ['<uses-permission'],
    AR_ISSUE,
    meStripXmlComments,
  );
}

// The hand-written package registration. ubrn's template registers only its own
// module; this file is in `noOverwrite` (rule 18) precisely so it can register
// BOTH. A module missing here fails at runtime as "module not found" with
// nothing in the build log — and the glue module is the half that owns the
// picker, the descriptors and the staging files.
checkWindowedPins(
  AR_PACKAGE_KT,
  AR_RULE,
  /^class OrbitalArchiveReaderPackage[\s\S]*/m,
  'the OrbitalArchiveReaderPackage module registry',
  ['OrbitalArchiveReaderModule.NAME', 'OrbitalArchiveAccessModule.NAME'],
  [],
  AR_ISSUE,
  stripCStyleComments,
);

// --- 29.7 The TS tripwire: parity with the Rust table, and the call itself.
//
// 29.5 pins the Rust DENIED_ROOTS table and a floor of 10 on it. This pins the
// OTHER side of the FFI — `archiveAccess.ts`'s own DENIED_ROOTS set, the second
// lock on every listing — and everything that makes it run: the set is unique
// and top-level, `openArchiveSession` still calls the predicate and closes on a
// hit, and the predicate itself still consults the set.
//
// Set EQUALITY, not a floor, with missing and extra reported SEPARATELY,
// because they mean opposite things:
//   - MISSING here (denied by Rust, absent in TS): the app-side tripwire lets a
//     listing under that root through. This is not hypothetical — the TS set
//     shipped with 6 of the 10 roots (#981), so `stories`, `reels`, `profile`
//     and `other_content` were admissible to the second lock for a release.
//   - EXTRA here (absent from the Rust table): a root the app refuses but the
//     crate does not hold as a known root key, so a wrapper segment named
//     after it IS strippable, and 29.5's floor-of-10 reasoning no longer
//     describes a single set.
//
// Parity is load-bearing, not tidiness: the F17 argument for why checking the
// POST-strip path is sound (see `startsWithDeniedRoot`'s comment) depends on
// Rust's `is_known_root_key` covering every root the TS side denies. Let the
// two drift and that argument quietly stops holding.
//
// A parity check alone would pass on a file that never consults the set, so the
// ENFORCEMENT is pinned too: `openArchiveSession` must still test
// `startsWithDeniedRoot(entry.path)` and `session.close()` on a hit. Matching is
// on `meStripComments` output — string-aware, unlike stripCStyleComments —
// so neither a set entry nor the call can be satisfied from prose.
const arAccessRaw = meRead(
  ARCHIVE_ACCESS,
  AR_RULE,
  "the app-side denied-root set and the listing tripwire",
  AR_ISSUE,
);
if (arAccessRaw !== null) {
  const arAccessCode = meStripComments(arAccessRaw);

  // ANCHORED at column 0 (`^` under `m`) and requiring `\s*:` after the name,
  // for the reason 29.5 was tightened in this PR plus one more: the first-match
  // unanchored form was defeated by a DECOY — a block-scoped
  // `const DENIED_ROOTS = new Set([…all 10…])` inside any helper above the real
  // declaration was matched FIRST, so the real module-level set could be
  // shrunk to two roots and the parity check still saw ten (PR #983 review,
  // mutation D1). Only a top-level declaration can be the one the tripwire
  // reads, so only a top-level declaration is accepted.
  const arTsTable = /^const DENIED_ROOTS\s*:[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/m.exec(arAccessCode);
  const arTsRoots =
    arTsTable === null ? [] : [...arTsTable[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);

  // ...and exactly ONE declaration of the name in the whole stripped file, so a
  // decoy is itself a violation rather than merely ignored. Anchoring alone
  // would leave a second top-level declaration (the later one wins at runtime,
  // the earlier one here) invisible — mutation D2.
  const arTsDecls = (arAccessCode.match(/\bconst DENIED_ROOTS\b/g) ?? []).length;
  if (arTsDecls > 1) {
    arViolation(ARCHIVE_ACCESS, `${arTsDecls} declarations of \`const DENIED_ROOTS\` — exactly one is allowed, because this clause and the tripwire must be reading the same Set; a second one (block-scoped or shadowing) lets the parity check pass against a table nothing enforces`);
  }

  if (arTsTable === null) {
    arViolation(ARCHIVE_ACCESS, 'no `const DENIED_ROOTS = new Set([…])` — the app-side denied-root tripwire has no table, and this parity clause would pass vacuously');
  } else if (arTsRoots.length === 0) {
    arViolation(ARCHIVE_ACCESS, 'DENIED_ROOTS is EMPTY — every listing passes the app-side tripwire, including one under messages/');
  } else if (arDeniedRoots.length > 0) {
    // Silent when the Rust list could not be read or is short: 29.5 already
    // reports that, and comparing against an empty set would bury it under a
    // cascade of "extra" roots.
    const arRustSet = new Set(arDeniedRoots);
    const arTsSet = new Set(arTsRoots);
    const arMissing = arDeniedRoots.filter((root) => !arTsSet.has(root));
    const arExtra = arTsRoots.filter((root) => !arRustSet.has(root));
    if (arMissing.length > 0) {
      arViolation(ARCHIVE_ACCESS, `DENIED_ROOTS is missing ${arMissing.length} root(s) the Rust table denies (${arMissing.join(', ')}) — a listing under those roots passes the only check on this side of the FFI`);
    }
    if (arExtra.length > 0) {
      arViolation(ARCHIVE_ACCESS, `DENIED_ROOTS names ${arExtra.length} root(s) the Rust table does not deny (${arExtra.join(', ')}) — is_known_root_key does not protect them from the F17 wrapper strip, so the two sides no longer describe one set`);
    }
  }

  const arTripwire = /export async function openArchiveSession\([\s\S]*?\n\}/m.exec(arAccessCode);
  if (arTripwire === null) {
    arViolation(ARCHIVE_ACCESS, 'openArchiveSession() not found — it is the one place the denied-root tripwire runs, and without the window this clause would pass vacuously');
  } else {
    for (const pin of ['startsWithDeniedRoot(entry.path)', 'session.close()']) {
      if (!arTripwire[0].includes(pin)) {
        arViolation(ARCHIVE_ACCESS, `openArchiveSession() no longer contains \`${pin}\` — the denied-root set is then dead code and a listing under a denied root is returned to the caller`);
      }
    }
  }

  // The PREDICATE's body, not just its call site. `startsWithDeniedRoot` could
  // be `return false` and everything above would still pass: the Set would be
  // the right size, the tripwire would still call the function, and every
  // listing would sail through (PR #983 review, mutation D3). So the body has
  // to consult the Set.
  const arPredicate = /^export function startsWithDeniedRoot\([\s\S]*?\n\}/m.exec(arAccessCode);
  if (arPredicate === null) {
    arViolation(ARCHIVE_ACCESS, 'startsWithDeniedRoot() not found — it is the predicate the tripwire calls, and without the window this clause would pass vacuously');
  } else if (!arPredicate[0].includes('DENIED_ROOTS.has(')) {
    arViolation(ARCHIVE_ACCESS, 'startsWithDeniedRoot() no longer consults DENIED_ROOTS (`DENIED_ROOTS.has(` is missing from its body) — the set and the tripwire call would both still be present while every listing passes');
  }
}

// ---------------------------------------------------------------------------
// 29.8 meta-import-parser-pins (#925)
// ---------------------------------------------------------------------------
//
// The Meta import parses a stranger-supplied JSON export into back-dated E2EE
// threads. Two of its guarantees are static facts about the source rather than
// behaviour a test can observe, so they are pinned here:
//
//   * the ONLY licence to import a post's media is a positive `image` peek
//     verdict, folded per post (clauses 2-6), and
//   * the codec story: the id framing must be lossless, and nothing anywhere
//     may call `TextDecoder` (clauses 7-8).
//
// Clauses 1-4 and 6 pin `mediaPrePass.ts`, which decides every media item's
// fate; clause 5 pins the CALL SITE in `parseArchive.ts`, because clauses 3-4
// pin two function BODIES and an orchestration that ignored both of them would
// satisfy every one of them while importing media nothing ever classified.

const MI_RULE = 'meta-import-parser-pins';
const MI_ISSUE = '#925';
const MI_UTF8 = join(SRC, 'utils', 'utf8.ts');
const MI_IMPORT_DIR = join(SRC, 'services', 'metaImport');
const MI_MEDIA_GATE_FILE = join(MI_IMPORT_DIR, 'mediaPrePass.ts');
const MI_PARSE_ARCHIVE = join(MI_IMPORT_DIR, 'parseArchive.ts');

function miViolation(file, detail) {
  violations.push(`  ${relative('.', file)}:0  [${MI_RULE}]  ${detail} (${MI_ISSUE})`);
}

// --- 29.8.1 The files every clause below reasons about must exist.
//
// `meRead` records a violation when one does not: deleting the subject of a
// pin must FAIL the rule, not satisfy it by leaving nothing to check. This is
// the first mutation in #925's matrix for exactly that reason.
const miUtf8Raw = meRead(
  MI_UTF8,
  MI_RULE,
  'the strict UTF-8 codec the parser frames source_item_id with',
  MI_ISSUE,
);

const miMediaGateRaw = meRead(
  MI_MEDIA_GATE_FILE,
  MI_RULE,
  'the media pre-pass that decides which of a post\'s media may be imported',
  MI_ISSUE,
);

const miParseArchiveRaw = meRead(
  MI_PARSE_ARCHIVE,
  MI_RULE,
  'the orchestration that must route every media item through the pre-pass',
  MI_ISSUE,
);

// --- 29.8.2 One declaration each, and a window that was really found.
//
// Both halves matter, for the two mutations 29.7 D1/D2 already caught on the
// denied-root set:
//
//   * ANCHORED windows (`^export function`), because an unanchored first match
//     can be a block-scoped DECOY above the real declaration — the clause then
//     reads a body nothing calls while the real one is free to import
//     everything;
//   * a FILE-WIDE declaration count, because anchoring alone leaves a SECOND
//     top-level declaration after the real one invisible: JS binds the later
//     one at runtime, this clause keeps reading the earlier.
//
// The count also covers the arrow-const and rename mutations: converting
// `export function classifyMediaItem` to `export const classifyMediaItem = …`
// or renaming it loses the window, which is reported rather than passed over.
const miMediaGateWindows = new Map();
if (miMediaGateRaw !== null) {
  const miMediaGateCode = meStripComments(miMediaGateRaw);

  for (const name of ['classifyMediaItem', 'foldPostMediaDecisions', 'resolveFileMedia']) {
    const declarations = (
      miMediaGateCode.match(new RegExp(`\\b(?:function|const|let|var)\\s+${name}\\b`, 'g')) ?? []
    ).length;
    if (declarations > 1) {
      miViolation(
        MI_MEDIA_GATE_FILE,
        `${declarations} declarations of \`${name}\` — exactly one is allowed, because this clause and every caller must be reading the same function; a second one (block-scoped decoy, or a top-level redeclaration that wins at runtime) lets these pins pass against a body nothing runs`,
      );
    }

    const window = new RegExp(`^export (?:async )?function ${name}\\([\\s\\S]*?\\n\\}`, 'm').exec(
      miMediaGateCode,
    );
    if (window === null) {
      miViolation(
        MI_MEDIA_GATE_FILE,
        `no top-level \`export function ${name}(\` — it was renamed, removed or converted to an arrow const, and the clauses that pin its body would pass vacuously`,
      );
    } else {
      miMediaGateWindows.set(name, window[0]);
    }
  }

  // --- 29.8.3 ONE import licence, guarded by a positive image verdict.
  //
  // This is the whole hold obligation (#983) in one pin. `peekEntryKind`'s
  // contract (a) is that a skip is never proof of "not a video", and the sniff
  // recognises ISO-BMFF video only — so WebM, MKV and every unknown head come
  // back "indeterminate". The ONLY evidence that licenses importing a member's
  // media is `{ok: true, kind: 'image'}`, and the only place that licence may
  // be minted is the guarded return in `classifyMediaItem`.
  //
  // Counted across the WHOLE stripped file, not inside the window: a second
  // `decision: 'import-image'` anywhere — the video arm, a skip `default`, a
  // helper below — is a second licence. (The `MediaDecision` type spells the
  // tag through the `ImportImage` alias precisely so the count can be exactly
  // one; see the comment on that alias.)
  const miLicences = (miMediaGateCode.match(/decision: 'import-image'/g) ?? []).length;
  if (miLicences !== 1) {
    miViolation(
      MI_MEDIA_GATE_FILE,
      `${miLicences} occurrences of the literal \`decision: 'import-image'\` — exactly ONE is allowed, the guarded return in classifyMediaItem; any other is a second licence to import media that was never positively classified as an image`,
    );
  }

  const miClassify = miMediaGateWindows.get('classifyMediaItem');
  if (miClassify !== undefined) {
    // Whitespace-insensitive, so Prettier's line breaking cannot decide
    // whether the rule holds — the TOKEN ORDER is what is pinned: the guard
    // tests both `peek.ok` and `kind === 'image'`, and the licence is the
    // FIRST thing its body does. Widening the guard to `if (peek.ok)` (which
    // would licence videos) or dropping it entirely fails here.
    const miGuard = "if (peek.ok && peek.kind === 'image') { return { decision: 'import-image'";
    if (!miClassify.replace(/\s+/g, ' ').includes(miGuard)) {
      miViolation(
        MI_MEDIA_GATE_FILE,
        `classifyMediaItem no longer reads \`${miGuard}\` — the import licence is unguarded or its guard was widened; only a positive image peek may licence an import (peekEntryKind contract (a))`,
      );
    }
    if (!miClassify.includes("decision: 'import-image'")) {
      miViolation(
        MI_MEDIA_GATE_FILE,
        "the single `decision: 'import-image'` literal is OUTSIDE classifyMediaItem — the licence moved to a function this rule does not pin",
      );
    }
    if (!miClassify.includes('assertNever(')) {
      miViolation(
        MI_MEDIA_GATE_FILE,
        'classifyMediaItem no longer calls `assertNever(` — without the exhaustiveness tail a new Rust skip code or sniff verdict falls through silently instead of failing the build, and the fall-through direction is the one that must hold the post',
      );
    }
    if (miClassify.includes('catch')) {
      miViolation(
        MI_MEDIA_GATE_FILE,
        'classifyMediaItem contains a `catch` — archive throws are run-level facts that parseArchive dispatches on ARCHIVE_ERROR_DISPOSITIONS (pause/repick/abort); catching one here turns a resumable pause into a permanent, silent "your photo did not migrate"',
      );
    }
  }

  // --- 29.8.4 The fold never drops a hold.
  //
  // A PROXY for that behaviour, and deliberately a crude one — the per-outcome
  // and priority tests own the real semantics. What it catches is the shape of
  // the regressions: a fold that stopped branching on `hold` at all, a fold
  // that minted its own import licence, and a fold rewritten around `.filter(`
  // (every plausible filter here drops held items and imports the rest, which
  // is exactly the partial post Alex ruled out on 2026-10-19).
  const miFold = miMediaGateWindows.get('foldPostMediaDecisions');
  if (miFold !== undefined) {
    if (!miFold.includes("decision === 'hold'")) {
      miViolation(
        MI_MEDIA_GATE_FILE,
        "foldPostMediaDecisions no longer tests `decision === 'hold'` — it must inspect every item's decision, because ANY hold holds the WHOLE post",
      );
    }
    if (miFold.includes("'import-image'")) {
      miViolation(
        MI_MEDIA_GATE_FILE,
        "foldPostMediaDecisions contains the literal `'import-image'` — the fold consumes decisions, it does not mint them; a licence spelled here is one classifyMediaItem never issued",
      );
    }
    if (miFold.includes('.filter(')) {
      miViolation(
        MI_MEDIA_GATE_FILE,
        'foldPostMediaDecisions contains `.filter(` — filtering the decision list is how a held item gets dropped instead of holding the post, which would import a post partially',
      );
    }
  }

  // --- 29.8.6 The resolution parity check.
  //
  // `resolveMediaUris` is 1:1 with its input, and the pre-pass reassembles
  // posts BY INDEX. A resolver that returned a short array would shift every
  // later post's media onto the wrong post — the failure mode is the member's
  // photos appearing in a stranger's thread, which no test downstream would
  // name. Both parities are pinned: per chunk (the call that can skew) and
  // over the whole file (the array the caller indexes into).
  const miResolve = miMediaGateWindows.get('resolveFileMedia');
  if (miResolve !== undefined) {
    for (const pin of ['.length !== chunk.length', '.length !== uris.length']) {
      if (!miResolve.includes(pin)) {
        miViolation(
          MI_MEDIA_GATE_FILE,
          `resolveFileMedia no longer asserts \`${pin}\` — the resolutions are index-aligned with the uris by contract, and an unchecked skew assigns one post's media to another`,
        );
      }
    }
  }
}

// --- 29.8.5 The CALL SITE: `parseArchive` must route media through the fold.
//
// Clauses 3-4 pin two function bodies. Nothing in them says anyone CALLS those
// functions — a `parseArchive` that resolved a post's uris and built
// `ParsedPost.media` straight from the resolutions would leave every one of
// those clauses green while importing media that was never peeked, never
// classified and never folded. The plan review made this the blocking half of
// the hold obligation (#983) for exactly that reason.
//
// The pins come in two halves, because the hole has two ends.
//
// The FOLD half — the verdict is computed and used:
//
//   * the fold is CALLED (`foldPostMediaDecisions(`);
//   * a `ParsedPost`'s media is the fold's OWN output (`media: folded.media`),
//     so calling the fold and then ignoring its verdict is not enough;
//   * the `'import-image'` licence is minted NOWHERE in this directory except
//     `mediaPrePass.ts` — scanned file-wide across every non-test file, since
//     a second licence in a helper, a parser or a future module would be a
//     second place a post's media can be waved through.
//
// The CLASSIFY half — the verdict is computed from REAL EVIDENCE. The fold
// half alone pins the downstream plumbing and says nothing about where
// `classifyMediaItem`'s peek argument came from. #987's security reviewer
// proved that gap by hand: a `parseArchive` that passes a literal
// `{ ok: true, kind: 'image', contentType: 'image/jpeg' }` into
// `classifyMediaItem` for every item folds a clean `import-image` for media
// nothing ever read a byte of, builds `media` from `folded.media`, mints the
// licence nowhere — and exited 0. So the evidence chain is pinned link by
// link: the peek is PERFORMED (`peekMediaEntries(`), each item is CLASSIFIED
// (`classifyMediaItem(`), and the verdict handed to the classifier is LOOKED
// UP from that peek's result (`peeks.get(`) rather than conjured at the call.
// `peeks.get(` is the one that closes it; the other two keep it from passing
// vacuously if the peek call or the classify call is what disappears.
//
// Same anchoring and declaration-count discipline as clause 2 (29.7 D1/D2): a
// block-scoped decoy or a second top-level `parseArchive` would otherwise let
// this clause read a body nothing runs. The window match is
// whitespace-normalised so Prettier's line breaking cannot decide whether the
// rule holds.
if (miParseArchiveRaw !== null) {
  const miParseCode = meStripComments(miParseArchiveRaw);

  const miParseDecls = (
    miParseCode.match(/\b(?:function|const|let|var)\s+parseArchive\b/g) ?? []
  ).length;
  if (miParseDecls > 1) {
    miViolation(
      MI_PARSE_ARCHIVE,
      `${miParseDecls} declarations of \`parseArchive\` — exactly one is allowed, because this clause and every caller must be reading the same function; a second one (block-scoped decoy, or a top-level redeclaration that wins at runtime) lets the call-site pins pass against a body nothing runs`,
    );
  }

  const miParseWindow = /^export async function parseArchive\([\s\S]*?\n\}/m.exec(miParseCode);
  if (miParseWindow === null) {
    miViolation(
      MI_PARSE_ARCHIVE,
      'no top-level `export async function parseArchive(` — the orchestration was renamed, removed or converted to an arrow const, and the call-site pins below would pass vacuously',
    );
  } else {
    const miParseBody = miParseWindow[0].replace(/\s+/g, ' ');
    const miCallSitePins = [
      [
        'foldPostMediaDecisions(',
        "parseArchive no longer calls the whole-post fold — media decisions that are never folded cannot hold a post, and a post with one video in it would be imported without it (Alex, 2026-10-19: never a partial post)",
      ],
      [
        'media: folded.media',
        'parseArchive no longer builds `ParsedPost.media` from the fold result — calling the fold and then assembling media from the raw resolutions imports items that were never positively classified as images',
      ],
      [
        'peekMediaEntries(',
        "parseArchive no longer calls `peekMediaEntries(` — nothing reads a byte of the member's media, so every verdict the fold consumes is an assertion about a file that was never opened",
      ],
      [
        'classifyMediaItem(',
        "parseArchive no longer calls `classifyMediaItem(` — the fold consumes decisions it does not mint, so a fold fed anything other than this classifier's output is folding verdicts no peek licensed",
      ],
      [
        'peeks.get(',
        "parseArchive no longer LOOKS UP the peek result it classifies (`peeks.get(`) — a peek whose verdict is not read back is a peek that did not happen, and a forged `{ok: true, kind: 'image'}` handed straight to classifyMediaItem folds a clean import for media nothing ever read (this exact variant exited 0 before the pin existed)",
      ],
    ];
    for (const [pin, detail] of miCallSitePins) {
      if (!miParseBody.includes(pin)) {
        miViolation(MI_PARSE_ARCHIVE, `${detail} (\`${pin}\` is missing from its body)`);
      }
    }
  }
}

// The licence may be spelled in ONE file. Scanned over the whole import
// directory rather than over `parseArchive.ts` alone, because the next module
// to need a decision is the one that would quietly mint its own.
//
// Test and fixture-builder paths are exempt on the same grounds as clause 8:
// they run only under Jest, and the pre-pass's own tests must be able to name
// the decision they assert on. `__mocks__/` is absent for the same reason it
// is absent there — this repo keeps `__mocks__/` at the repo ROOT, so the
// pattern matched nothing and only looked like coverage.
const MI_LICENCE_EXEMPT = ['__tests__/', 'testUtils/', '.test.ts', '.test.tsx'];
const MI_MEDIA_GATE_REL = relative('.', MI_MEDIA_GATE_FILE);
let miLicenceScanned = 0;
for (const file of walkSync(MI_IMPORT_DIR, ['.ts', '.tsx'])) {
  const rel = relative('.', file);
  if (rel.includes('node_modules')) continue;
  if (MI_LICENCE_EXEMPT.some((pattern) => rel.includes(pattern))) continue;
  if (rel === MI_MEDIA_GATE_REL) continue;
  miLicenceScanned++;
  const lines = meStripComments(readFileSync(file, 'utf8')).split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes("'import-image'")) continue;
    report(
      file,
      i + 1,
      MI_RULE,
      `the \`'import-image'\` licence is minted outside mediaPrePass.ts — only classifyMediaItem's guarded return may issue it, and only a positive image peek licences it (peekEntryKind contract (a)): ${lines[i].trim()} (${MI_ISSUE})`,
    );
  }
}
if (miLicenceScanned === 0) {
  violations.push(
    `  ${MI_IMPORT_DIR}:0  [${MI_RULE}]  the import-licence scan examined ZERO files — its root or exemptions are wrong and the clause would pass vacuously (${MI_ISSUE})`,
  );
}

// --- 29.8.7 `encodeUtf8Strict` is a TextEncoder wrapper, never a hand-rolled
//     loop.
//
// The point of this clause is INJECTIVITY, not style. `source_item_id` is a
// length-prefixed framing of the member's own post text, and #924 HMACs it
// into the 16-byte `import_key` the server dedups on. A hand-rolled encoder is
// how this repo has already got UTF-8 wrong twice — `src/services/crypto/
// utils.ts` `encodeUTF8` truncates every code point to one byte (#373), and
// `contentCrypto.ts`'s decoder is lenient — and a lossy encoder means two
// different posts can frame to the same bytes. `TextEncoder` is present on
// Hermes 0.82.1 and is correct; the wrapper's whole job is to add the two
// refusals a lossy encoder would not make (non-string input, unpaired
// surrogate), and those live in a separate helper so this window stays clean.
//
// The banned tokens are the fingerprints of a byte-composition loop. The
// surrogate scan is deliberately NOT in this window, so none of them has a
// legitimate reason to appear.
//
// Banning a loop is only half of it: `return new TextEncoder().encode(value)`
// on its own passes every token check above and is exactly the lossy encoder
// the wrapper exists to prevent — `encode(undefined)` returns the nine bytes
// of `"undefined"`, and an unpaired surrogate becomes U+FFFD, so two distinct
// posts frame to the same `import_key` and the server dedups one member's post
// away. So both REFUSALS are pinned in the window, each with its own message,
// and the surrogate helper is pinned the way the pre-pass functions are:
// file-wide declaration count plus an anchored, non-trivial window. Without
// the count a `function hasUnpairedSurrogate() { return false }` appended
// below the real one wins at runtime while this clause keeps reading the
// first — the refusal line stays in place and refuses nothing.
if (miUtf8Raw !== null) {
  const miUtf8Code = meStripComments(miUtf8Raw);

  // File-wide declaration count first (29.7 D2): anchoring alone would let a
  // second top-level declaration shadow the pinned one at runtime while this
  // clause kept reading the first.
  const miEncoderDecls = (
    miUtf8Code.match(/\b(?:function|const|let|var)\s+encodeUtf8Strict\b/g) ?? []
  ).length;
  if (miEncoderDecls > 1) {
    miViolation(
      MI_UTF8,
      `${miEncoderDecls} declarations of \`encodeUtf8Strict\` — exactly one is allowed, because this clause and every caller must be reading the same function`,
    );
  }

  const miEncoder = /^export function encodeUtf8Strict\([\s\S]*?\n\}/m.exec(miUtf8Code);
  if (miEncoder === null) {
    miViolation(
      MI_UTF8,
      'no top-level `export function encodeUtf8Strict(` — the strict encoder was renamed, removed or converted to an arrow const, and this clause would pass vacuously',
    );
  } else {
    if (!miEncoder[0].includes('new TextEncoder()')) {
      miViolation(
        MI_UTF8,
        'encodeUtf8Strict no longer calls `new TextEncoder()` — a hand-rolled encoder is how this repo already shipped a latin1-truncating encodeUTF8 (#373), and a lossy encoder makes the source_item_id framing non-injective',
      );
    }
    for (const banned of [
      'charCodeAt',
      'codePointAt',
      'fromCharCode',
      '0x3f',
      '0xc0',
      '0xe0',
      '0xf0',
    ]) {
      if (miEncoder[0].includes(banned)) {
        miViolation(
          MI_UTF8,
          `encodeUtf8Strict contains \`${banned}\` — that is the fingerprint of a manual code-unit loop, and this function must stay a thin TextEncoder wrapper (the unpaired-surrogate scan belongs in its own helper)`,
        );
      }
    }

    // The two refusals, each named separately: they fail for different reasons
    // and a reviewer reading the violation needs to know WHICH guarantee went.
    // Whitespace-normalised so Prettier's line breaking cannot decide whether
    // the rule holds.
    const miEncoderBody = miEncoder[0].replace(/\s+/g, ' ');
    if (!miEncoderBody.includes("typeof value !== 'string'")) {
      miViolation(
        MI_UTF8,
        'encodeUtf8Strict no longer refuses a non-string (`typeof value !== \'string\'`) — every string it frames comes out of JSON.parse on an attacker-supplied archive, so "it is a string" is a runtime fact; `new TextEncoder().encode(undefined)` frames the nine bytes of "undefined" instead, and two different malformed posts then share one import_key',
      );
    }
    if (!miEncoderBody.includes('hasUnpairedSurrogate(')) {
      miViolation(
        MI_UTF8,
        'encodeUtf8Strict no longer calls `hasUnpairedSurrogate(` — TextEncoder substitutes U+FFFD for a lone surrogate, which is LOSSY, so the source_item_id framing stops being injective and two distinct posts can HMAC to the same import_key (#924)',
      );
    }
  }

  // The helper that second refusal delegates to, pinned the way the pre-pass
  // functions are (29.7 D1/D2): count first, then an anchored window.
  const miSurrogateDecls = (
    miUtf8Code.match(/\b(?:function|const|let|var)\s+hasUnpairedSurrogate\b/g) ?? []
  ).length;
  if (miSurrogateDecls > 1) {
    miViolation(
      MI_UTF8,
      `${miSurrogateDecls} declarations of \`hasUnpairedSurrogate\` — exactly one is allowed, because the refusal pinned above and this window must be reading the same function; a second one (a \`return false\` decoy below the real declaration wins at runtime) leaves encodeUtf8Strict calling a scan that never refuses anything`,
    );
  }

  const miSurrogate = /^function hasUnpairedSurrogate\([\s\S]*?\n\}/m.exec(miUtf8Code);
  if (miSurrogate === null) {
    miViolation(
      MI_UTF8,
      'no top-level `function hasUnpairedSurrogate(` — the surrogate scan was renamed, removed or converted to an arrow const, and the refusal pinned above would be satisfied by a call to anything at all',
    );
  } else {
    // Non-triviality, by the two constants and the one read the scan cannot be
    // written without. Chosen over pinning the loop shape (brittle:
    // `for`/`while`/`indexOf` are all legitimate) and over pinning `return
    // true` (a bare `return true` stub would satisfy that while refusing every
    // string):
    //
    //   * `0xd800` is the floor of the surrogate block — without it the scan
    //     cannot even find a candidate code unit;
    //   * `0xdc00` is the low-surrogate floor, which is what distinguishes a
    //     well-formed PAIR from a lone high surrogate. A scan that never names
    //     it either refuses every astral character or refuses none;
    //   * `charCodeAt(` is the only way to read a code unit in the first place
    //     — a body without it is not reading the string.
    //
    // Rewriting these as decimals (55296/56320) or as a regex class is a
    // deliberate change to the one function whose correctness this rule rests
    // on: update the anchors with it rather than deleting them.
    for (const anchor of ['charCodeAt(', '0xd800', '0xdc00']) {
      if (!miSurrogate[0].includes(anchor)) {
        miViolation(
          MI_UTF8,
          `hasUnpairedSurrogate no longer reads \`${anchor}\` — its body has been hollowed out or rewritten past the pin; a scan that cannot name the surrogate block and the low-surrogate floor is not deciding pairing, and encodeUtf8Strict's second refusal becomes a no-op`,
        );
      }
    }
  }
}

// --- 29.8.8 No `TextDecoder`, anywhere in app or package source.
//
// Hermes 0.82.1 has `TextEncoder` and does NOT have `TextDecoder`. Jest's node
// environment has BOTH. That asymmetry means a `new TextDecoder()` added
// anywhere in shipped source passes every test in CI and throws a
// ReferenceError on a real device — the worst shape a defect can have.
// `src/utils/utf8.ts` exists precisely so there is a strict decoder that does
// not need one.
//
// Scanned repo-wide (`src/` plus every package's own `src/`) rather than in
// the import's files only, because the engine gap is not a #925 fact. Test
// paths and the fixture BUILDERS under `testUtils/` are exempt: they only ever
// run under Jest, and `utf8.test.ts` must be able to use the real
// `TextDecoder` as its parity ORACLE.
//
// Two things are deliberately NOT exempt, and the comment is narrowed to say
// so. `__mocks__/` was listed here and matched nothing — this repo's
// `__mocks__/` is at the REPO ROOT, outside every scanned root — so it is
// dropped rather than left as a pattern some future `src/**/__mocks__/` would
// silently inherit. `__fixtures__/` is not added: the one that exists,
// `packages/orbital-archive-reader/src/__fixtures__/`, holds fixture DATA that
// ships inside a package's own `src/`, which is ordinary source as far as the
// engine is concerned, and it passes this scan today. Keeping it scanned costs
// nothing and an exemption would be coverage given away for a file that does
// not need it. If a fixture module ever legitimately needs the oracle, give it
// a `.test.ts` sibling rather than widening this list.
const MI_DECODER_EXEMPT = ['__tests__/', 'testUtils/', '.test.ts', '.test.tsx'];
const miDecoderRoots = [SRC];
for (const entry of readdirSync('packages')) {
  const packageSrc = join('packages', entry, 'src');
  try {
    if (statSync(packageSrc).isDirectory()) miDecoderRoots.push(packageSrc);
  } catch {
    // A package without a `src/` directory: nothing to scan.
  }
}

// A `=== 0` floor is the weakest non-vacuity test there is: one over-broad
// exemption — `'src/'`, say, which every scanned path contains — empties the
// scan to a single digit and still passes it. So the floor is a COUNT near the
// real one (301 files on 2026-11-12, across `src/` and four package `src/`
// trees), set ~15% below so ordinary deletion and consolidation do not trip
// it. Tripping it does not mean "a file was deleted and we lose": it means
// re-measure, and if the shrink is real, move the floor in the commit that
// caused it.
const MI_DECODER_FLOOR = 255;

// Each exemption must also EARN its place. A pattern matching nothing is
// either a typo or a directory that has moved, and in both shapes it reads
// like coverage that does not exist — which is how `__mocks__/` sat in this
// list un-noticed. Tracked per pattern, not as a total.
const miDecoderExemptHits = new Map(MI_DECODER_EXEMPT.map((pattern) => [pattern, 0]));

let miDecoderScanned = 0;
for (const root of miDecoderRoots) {
  for (const file of walkSync(root, ['.ts', '.tsx'])) {
    const rel = relative('.', file);
    if (rel.includes('node_modules')) continue;
    const matched = MI_DECODER_EXEMPT.filter((pattern) => rel.includes(pattern));
    if (matched.length > 0) {
      for (const pattern of matched)
        miDecoderExemptHits.set(pattern, miDecoderExemptHits.get(pattern) + 1);
      continue;
    }
    miDecoderScanned++;
    const lines = meStripComments(readFileSync(file, 'utf8')).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/\bTextDecoder\b/.test(lines[i])) continue;
      report(
        file,
        i + 1,
        MI_RULE,
        `TextDecoder is undefined on Hermes 0.82.1 and defined in Jest's node environment, so this passes every test and throws on device — use decodeUtf8Strict from src/utils/utf8.ts: ${lines[i].trim()} (${MI_ISSUE})`,
      );
    }
  }
}
if (miDecoderScanned < MI_DECODER_FLOOR) {
  violations.push(
    `  ${SRC}:0  [${MI_RULE}]  the no-TextDecoder scan examined ${miDecoderScanned} files, below the floor of ${MI_DECODER_FLOOR} — its roots or exemptions are wrong (an over-broad pattern empties the scan while leaving it non-zero) and the rule is passing over source it is supposed to read. Re-measure; if the shrink is a real, deliberate deletion, move MI_DECODER_FLOOR in the same commit (${MI_ISSUE})`,
  );
}
for (const [pattern, hits] of miDecoderExemptHits) {
  if (hits === 0) {
    violations.push(
      `  ${SRC}:0  [${MI_RULE}]  the no-TextDecoder exemption \`${pattern}\` matched ZERO scanned paths — it is a typo or a directory that has moved, and it reads as coverage that does not exist. Delete it, or fix it to match where those files actually live (${MI_ISSUE})`,
    );
  }
}

// ---------------------------------------------------------------------------
// 29a. archive-reader-import-restricted (#920 F10)
// ---------------------------------------------------------------------------

// Same shape and the same argument as rule 24a: the archive reader is the only
// code in the app that parses bytes a stranger produced, and
// `src/services/metaImport/archiveAccess.ts` is the policy layer wrapped around
// it — the denied-root tripwire on every listing, the magic-byte gate before
// and after extraction, the disk-headroom preflight, the one-UUID-per-extract
// staging discipline and the `release_staging` call in the unlink `finally`
// that keeps the 512 MiB live-staging ceiling from becoming a hard stop.
//
// NONE of that is in the package. A second importer anywhere in src/ would get
// the raw session API with every one of those policies silently absent, and
// would also route around rule 24e's wipe wiring, which reasons about ONE
// module's teardown exports.
//
// TWO specifier shapes, because the bare one is trivially avoidable. The
// precedent is `safetyNumber.ts`: a deep relative path
// (`../../../packages/orbital-archive-reader/src/index`) or an absolute one
// resolves to exactly the same module and matches no bare-specifier pattern at
// all. `\bfrom\s*` also covers `export … from`, i.e. a barrel re-export, which
// is how a "single importer" rule is usually defeated.
//
// Test and mock paths are exempt, like every other cross-file scan here: the
// wrapper's own tests and the jest manual mock both name the package.

const AR_IMPORT_RULE = 'archive-reader-import-restricted';
const AR_SPEC_HEAD = String.raw`(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)`;
// The bare package specifier, with or without a subpath.
const AR_BARE_SPEC_RE = new RegExp(`${AR_SPEC_HEAD}['"]orbital-archive-reader(?:/[^'"]*)?['"]`);
// Any specifier — relative, absolute or alias — that reaches into the package
// directory by path. ARCHIVE_PKG_REL holds no regex metacharacters.
const AR_PATH_SPEC_RE = new RegExp(`${AR_SPEC_HEAD}['"][^'"]*${ARCHIVE_PKG_REL}[^'"]*['"]`);

let arImporterSeen = false;
for (const file of allFiles) {
  const rel = relative('.', file);
  if (
    rel.includes('__tests__/') ||
    rel.includes('__mocks__/') ||
    rel.includes('.test.ts') ||
    rel.includes('.test.tsx')
  ) {
    continue;
  }

  const lines = meStripComments(readFileSync(file, 'utf8')).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const bare = AR_BARE_SPEC_RE.test(lines[i]);
    const byPath = AR_PATH_SPEC_RE.test(lines[i]);
    if (!bare && !byPath) continue;
    if (file === ARCHIVE_ACCESS) {
      // Only the BARE form anchors non-vacuity: the permitted importer is
      // supposed to use the package specifier, so a deep path there is itself
      // a drift worth seeing.
      if (bare) arImporterSeen = true;
      else {
        report(
          file,
          i + 1,
          AR_IMPORT_RULE,
          `the permitted importer reaches into ${ARCHIVE_PKG_REL} by path — use the \`orbital-archive-reader\` package specifier so the single-importer pattern stays greppable (${AR_ISSUE})`,
        );
      }
      continue;
    }
    report(
      file,
      i + 1,
      AR_IMPORT_RULE,
      `imports the archive reader outside ${relative('.', ARCHIVE_ACCESS)} — every hostile-input policy (denied-root tripwire, magic-byte gate, disk preflight, staging release) lives in that module and nothing enforces it here: ${lines[i].trim()} (${AR_ISSUE})`,
    );
  }
}

if (!arImporterSeen) {
  violations.push(
    `  ${relative('.', ARCHIVE_ACCESS)}:0  [${AR_IMPORT_RULE}]  the one permitted importer no longer imports 'orbital-archive-reader' — the rule would pass vacuously (${AR_ISSUE})`,
  );
}

// ---------------------------------------------------------------------------
// 30. import-kdf-call-sites (#924)
// ---------------------------------------------------------------------------

// There is no HKDF and no HMAC in this app's TypeScript. Both primitives are
// the Rust uniffi exports from #917, and the ONLY module allowed to name them
// is `src/services/crypto/importCrypto.ts`, which owns the Meta-import
// derivation:
//
//   K_import   = hkdfSha256(group_key, "orbital-meta-import-v1", lower(userId), 32)
//   import_key = hmacSha256(K_import, utf8(source) ‖ 0x00 ‖ sourceItemId)[0..16]
//
// Two different failures are being prevented, and they need different clauses.
//
//   (a) A SECOND call site. `import_key` is a dedup token whose cross-member
//       unlinkability rests entirely on `info` being the member's own userId
//       and on `salt` being this one protocol string. A second derivation
//       somewhere in src/ — with a different salt, a different info, or the
//       same salt under a different group key — silently re-partitions the
//       dedup space, and nothing downstream can tell. The blast radius of a
//       salt change is a full re-import for every member (see the kdf.rs
//       rotation section), so the salt gets its own exactly-once clause rather
//       than riding along with the identifiers.
//
//   (b) A SECOND IMPLEMENTATION. The far likelier drift is not calling the
//       Rust export twice: it is someone reaching for `node:crypto`,
//       `@noble/hashes` or `crypto-js` because the uniffi call is awkward in a
//       test, a script, or a Hermes-hostile corner. Those packages are not
//       available on Hermes at all (`node:crypto`) or ship their own
//       unaudited field arithmetic, and either way the result would be a
//       second, unreviewed KDF path producing tokens the Rust KAT does not
//       pin. So the module specifiers AND the bare identifiers are both
//       banned, in source that is not a test.
//
// Modelled on 29.8.8, with its four structural pieces kept intact: multi-root
// walk (`src/` plus every `packages/*/src`), `meStripComments` so a mention in
// prose is never a call site, per-exemption hit counting so a pattern that
// matches nothing is itself a violation, and a MEASURED file-count floor so an
// over-broad exemption cannot quietly empty the scan.
//
// Two deliberate departures from 29.8.8, both about strings:
//
//   * Identifier clauses (30.2, 30.4-identifiers) run on text with the
//     contents of '…' and "…" blanked as well, because `'hkdfSha256'` inside a
//     string is a name, not a call — a logging key or an error message must
//     not fail this rule. Backticks are tracked but NOT blanked: a template
//     literal can contain `${hkdfSha256(x)}`, which IS a call, and
//     over-reporting a name in a template is the safer side of that trade.
//     A quote left open at end of line (an apostrophe in JSX text, a `/['"]/`
//     character class, a template opened on an earlier line) falls back to
//     the unblanked line rather than blanking the remainder — see
//     `ikBlankQuoted`, and rows N5/N6/N7 below.
//   * Specifier clauses (30.3 salt, 30.4-modules) run on comment-stripped text
//     with strings INTACT, because what they are looking for is a string
//     literal.
//
// The generated bindings are exempt by exact path (they declare the exports),
// and so are test paths. The package barrel
// `packages/orbital-signal/src/index.tsx` is NOT exempt and does not need to
// be: it re-exports with `export *` and never names either function.
//
// MUTATION MATRIX — re-run in full 2026-11-12 against this rule, from the
// worktree, one row at a time (sha256 before, mutate,
// `node scripts/check-security-invariants.mjs`, restore, sha256 matches,
// `git status --porcelain` clean). Recorded here verbatim
// because the harness that would run it automatically is NOT in scope for
// #924; it stays registry item DEBT-360 (a committed invariant mutation
// harness), so this block is the only record that these clauses bite.
//
// Verdicts are what the run PRINTED, not what it was expected to print; the
// count is the number of this rule's violations the row produced.
//
//   M1   `export function hkdfSha256(` renamed in the generated
//        bindings                                            RED  30.1          (1)
//   M2   `export function hmacSha256(` renamed in the generated
//        bindings                                            RED  30.1          (1)
//   M3   `import { hmacSha256 } from 'orbital-signal'` appended
//        to src/services/metaImport/parseArchive.ts          RED  30.2          (1)
//   M4   an `hkdfSha256(...)` call in src/utils/uuid.ts      RED  30.2          (1)
//   M4b  an `hkdfSha256(...)` call in
//        packages/orbital-signal/src/NativeOrbitalSignal.ts  RED  30.2          (1)
//   M5   both names renamed away inside importCrypto.ts      RED  30.2 vacuity  (2)
//   M6   importCrypto.ts deleted                             RED  30.0 + 30.3   (2)
//   M7   a second copy of the salt literal in another file   RED  30.3          (2)
//   M8   the salt bumped to …-v2 in importCrypto.ts          RED  30.3          (1)
//   M9   `import { createHmac } from 'crypto'`               RED  30.4a + 30.4b (2)
//   M10  a bare `createHmac(...)` call                       RED  30.4b         (1)
//   M11  `import { hkdfSync } from 'node:crypto'`            RED  30.4a + 30.4b (2)
//   M12  a dead exemption pattern (`__mocks__/`, which in
//        this repo lives at the root, outside every root)    RED  exempt-hits   (1)
//   M13  the stale clause rewritten in the real kdf.rs       RED  30.5          (1)
//   M14  an apostrophe-bearing template literal holding a
//        real `${hkdfSha256(a, b, c, 32)}` call              RED  30.2          (1)
//   M15  a `/['"]/` character class and an `hkdfSha256(...)`
//        call on the SAME line                               RED  30.2          (1)
//   N1   both names in a `//` comment in another src/ file   GREEN
//   N2   the real importCrypto.kat.test.ts, which legitimately uses
//        `hkdfSync`, `createHmac` and the salt, untouched    GREEN  (the baseline run)
//   N3   `globalThis.…crypto.getRandomValues` in a src/ file GREEN
//   N4   `'hkdfSha256'` and `"hmacSha256"` as string values  GREEN
//   N5   an apostrophe in JSX prose, with no banned call on
//        the line (the fallback must not invent one)         GREEN
//
// M14 and M15 are the rows the quote-blanker used to miss. Run against the
// PREVIOUS `ikBlankQuoted`, both came back GREEN: the apostrophe and the `'`
// of the character class each opened a quote that never closed, and
// everything after it on the line — the call included — was blanked away.
// They are RED only because the blanker now tracks backticks and falls back
// to the unblanked line when a quote is still open at end of line. N5 is
// their counterweight: that fallback must not start reporting lines whose
// only sin is an apostrophe.
//
// Two further results worth keeping. M1/M2 do NOT also trip 30.2: the generated file
// is exempt from the scan and importCrypto.ts still names the now-undeclared
// export, which is exactly the vacuity 30.1 exists to cover — without it the
// rule would have gone on pinning a dead name. And M13 was run against the
// REAL `src/kdf.rs`, not a scratch copy, then restored: the file is
// byte-identical afterwards (sha256 da735816…3cbb4 before and after), which
// matters because `scripts/rust-input-digest.sh` hashes that directory and any
// change there condemns every built xcframework.

const IK_RULE = 'import-kdf-call-sites';
const IK_ISSUE = '#924';
const IK_MODULE = join(SRC, 'services', 'crypto', 'importCrypto.ts');
const IK_GENERATED = join('packages', 'orbital-signal', 'src', 'generated', 'orbital_signal.ts');
const IK_RUST = join('packages', 'orbital-signal', 'rust', 'orbital_signal');
const IK_KDF_RS = join(IK_RUST, 'src', 'kdf.rs');
const IK_KAT_RS = join(IK_RUST, 'tests', 'kdf_kat_tests.rs');
const IK_SALT = 'orbital-meta-import-v1';
const IK_PRIMITIVES = ['hkdfSha256', 'hmacSha256'];
const IK_STALE_CLAUSE = '#924 owns its internal length-prefixed encoding';

function ikViolation(file, detail) {
  violations.push(`  ${relative('.', file)}:0  [${IK_RULE}]  ${detail} (${IK_ISSUE})`);
}

/**
 * Blank the CONTENTS of '…' and "…" literals, preserving quotes and line
 * length so reported line numbers stay true. Input is expected to be
 * `meStripComments` output.
 *
 * Backtick templates are TRACKED but not blanked. Tracked because an
 * apostrophe inside one (`` `the member's archive ${hkdfSha256(x)}` ``) would
 * otherwise open a quote that never closes and blank the rest of the line,
 * hiding a real call — the same way `meStripComments` tracks backticks so a
 * `//` inside a template is not read as a comment. Not blanked because
 * `${hkdfSha256(x)}` IS a call site, and over-reporting a bare name inside a
 * template is the safer side of that trade.
 *
 * A quote still open at end of line means this line is not what it looks
 * like: an apostrophe in JSX text, a regex character class such as `/['"]/`,
 * or a template opened on an earlier line. Blanking from the opener onwards
 * would silently drop everything after it, so the line is handed back
 * UNBLANKED instead. That fails toward reporting: the worst case is a name
 * inside a string being flagged, which a reviewer can see and exempt, against
 * a missed second call site, which nobody sees at all.
 */
function ikBlankQuoted(text) {
  return text
    .split('\n')
    .map((line) => {
      let out = '';
      let quote = null;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quote !== null) {
          if (ch === '\\') {
            // Two characters consumed, two emitted — unless the backslash is
            // the last character on the line, where only one exists. Inside a
            // template the characters are kept; inside '…'/"…" they blank.
            const run = i + 1 < line.length ? 2 : 1;
            out += quote === '`' ? line.slice(i, i + run) : ' '.repeat(run);
            i += 1;
            continue;
          }
          if (ch === quote) {
            out += ch;
            quote = null;
            continue;
          }
          out += quote === '`' ? ch : ' ';
          continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') {
          quote = ch;
          out += ch;
          continue;
        }
        out += ch;
      }
      return quote === null ? out : line;
    })
    .join('\n');
}

// --- 30.0 The module that owns the derivation must exist.
//
// Deleting the subject of a pin must FAIL the rule, not satisfy it by leaving
// nothing to check.
const ikModuleRaw = meRead(
  IK_MODULE,
  IK_RULE,
  'the single permitted HKDF/HMAC call site for the Meta import',
  IK_ISSUE,
);

// --- 30.1 The generated bindings must still export both primitives.
//
// The non-vacuity floor for 30.2: if ubrn regenerates without these exports
// (an upstream rename, a dropped uniffi export, a hand-edited binding), the
// "appears only in importCrypto.ts" clause would pass over a dead name while
// the app no longer has a KDF at all. Matched as the generated DECLARATION,
// not as a bare mention.
const ikGeneratedRaw = meRead(
  IK_GENERATED,
  IK_RULE,
  'the generated uniffi bindings that declare hkdfSha256/hmacSha256',
  IK_ISSUE,
);
if (ikGeneratedRaw !== null) {
  for (const name of IK_PRIMITIVES) {
    if (!new RegExp(String.raw`export function ${name}\b`).test(ikGeneratedRaw)) {
      ikViolation(
        IK_GENERATED,
        `the generated bindings no longer export \`${name}\` — rule 30.2 would then pin a name nothing declares, and the Meta-import derivation has no primitive. Regenerate the bindings from \`${join(IK_RUST, 'src', 'kdf.rs')}\`, or if the export was deliberately removed, follow that file's removal trigger and take this whole rule with it`,
      );
    }
  }
}

const IK_EXEMPT = [
  '__tests__/',
  '.test.ts',
  '.test.tsx',
  // The generated bindings declare the exports; they are the floor 30.1 reads,
  // not a call site. Named as an exact path so a future `generated/` elsewhere
  // does not inherit the exemption.
  'packages/orbital-signal/src/generated/orbital_signal.ts',
];

// A measured floor, as in 29.8.8: 307 files on 2026-11-12 across `src/` and
// the four package `src/` trees, set ~15% below. Tripping it means re-measure;
// if the shrink is a real deletion, move the floor in that same commit.
//
// TWIN: `MI_DECODER_FLOOR` counts the same tree for 24b's scan and moves for
// the same reasons — keep the two in step. A THIRD copy of this
// roots/exemptions/floor harness means extracting a shared helper instead of
// cloning it again (registry item DEBT-360's neighbour).
const IK_SCAN_FLOOR = 260;

const ikRoots = [SRC];
for (const entry of readdirSync('packages')) {
  const packageSrc = join('packages', entry, 'src');
  try {
    if (statSync(packageSrc).isDirectory()) ikRoots.push(packageSrc);
  } catch {
    // A package without a `src/` directory: nothing to scan.
  }
}

const ikExemptHits = new Map(IK_EXEMPT.map((pattern) => [pattern, 0]));
const IK_BANNED_IDENT_RE = /\b(createHmac|hkdfSync|hkdfExtract|hkdfExpand|pbkdf2Sync)\b/;
// `crypto.getRandomValues` on the global stays legal and must not match: these
// shapes all require a quoted module specifier.
const IK_SPEC_HEAD = String.raw`(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s*)`;
const IK_BANNED_MODULES = String.raw`(?:node:)?crypto|crypto-js(?:/[^'"]*)?|js-sha256(?:/[^'"]*)?|hash\.js(?:/[^'"]*)?|@noble/hashes(?:/[^'"]*)?`;
const IK_BANNED_SPEC_RE = new RegExp(`${IK_SPEC_HEAD}['"](?:${IK_BANNED_MODULES})['"]`);

let ikScanned = 0;
const ikModuleRefs = new Map(IK_PRIMITIVES.map((name) => [name, 0]));
const ikSaltSites = [];

for (const root of ikRoots) {
  for (const file of walkSync(root, ['.ts', '.tsx'])) {
    const rel = relative('.', file);
    if (rel.includes('node_modules')) continue;
    const matched = IK_EXEMPT.filter((pattern) => rel.includes(pattern));
    if (matched.length > 0) {
      for (const pattern of matched) ikExemptHits.set(pattern, ikExemptHits.get(pattern) + 1);
      continue;
    }
    ikScanned++;

    const isOwner = rel === relative('.', IK_MODULE);
    const stripped = meStripComments(readFileSync(file, 'utf8'));
    const strippedLines = stripped.split('\n');
    const codeLines = ikBlankQuoted(stripped).split('\n');

    for (let i = 0; i < codeLines.length; i++) {
      const code = codeLines[i];
      const text = strippedLines[i];

      // --- 30.2 Both primitives, only in importCrypto.ts.
      for (const name of IK_PRIMITIVES) {
        if (!new RegExp(String.raw`\b${name}\b`).test(code)) continue;
        if (isOwner) {
          ikModuleRefs.set(name, ikModuleRefs.get(name) + 1);
          continue;
        }
        report(
          file,
          i + 1,
          IK_RULE,
          `\`${name}\` outside ${relative('.', IK_MODULE)} — a second KDF call site re-partitions the import dedup space (its salt and per-member \`info\` are what make \`import_key\` unlinkable) and is pinned by no KAT: ${text.trim()} (${IK_ISSUE})`,
        );
      }

      // --- 30.4a No second HMAC/HKDF implementation, by module specifier.
      if (IK_BANNED_SPEC_RE.test(text)) {
        report(
          file,
          i + 1,
          IK_RULE,
          `imports a JavaScript crypto implementation — \`node:crypto\` does not exist on Hermes and the userland hash packages ship unaudited primitives this repo has never reviewed; the only HKDF/HMAC is the Rust uniffi export used by ${relative('.', IK_MODULE)}: ${text.trim()} (${IK_ISSUE})`,
        );
      }

      // --- 30.4b ...and by bare identifier, for the destructured/global form.
      const bannedIdent = IK_BANNED_IDENT_RE.exec(code);
      if (bannedIdent !== null) {
        report(
          file,
          i + 1,
          IK_RULE,
          `uses \`${bannedIdent[1]}\` — a second KDF/MAC implementation outside the audited Rust path; derive through ${relative('.', IK_MODULE)} instead: ${text.trim()} (${IK_ISSUE})`,
        );
      }

      // --- 30.3 (collection) The protocol salt, spelled once.
      let from = text.indexOf(IK_SALT);
      while (from !== -1) {
        ikSaltSites.push({ file, line: i + 1 });
        from = text.indexOf(IK_SALT, from + IK_SALT.length);
      }
    }
  }
}

// --- 30.2 (non-vacuity) The owner must still call both primitives.
if (ikModuleRaw !== null) {
  for (const name of IK_PRIMITIVES) {
    if (ikModuleRefs.get(name) === 0) {
      ikViolation(
        IK_MODULE,
        `the one permitted call site no longer references \`${name}\` — either the derivation moved (which is what this rule exists to catch) or it is now implemented some other way, and in both shapes the "only here" clause passes vacuously`,
      );
    }
  }
}

// --- 30.3 The protocol salt appears exactly once, in importCrypto.ts.
//
// Bumping it is a one-line change by design (#917 §0), and that is precisely
// why a SECOND copy is dangerous: two spellings drift, and the half that lags
// derives keys nothing can re-derive, because only the 16-byte MAC is stored.
if (ikSaltSites.length === 0) {
  ikViolation(
    IK_MODULE,
    `the import salt \`${IK_SALT}\` appears in no scanned non-test source — the derivation's domain separator has moved or been inlined somewhere this rule cannot see`,
  );
} else if (ikSaltSites.length > 1) {
  for (const site of ikSaltSites) {
    report(
      site.file,
      site.line,
      IK_RULE,
      `the import salt \`${IK_SALT}\` is spelled in ${ikSaltSites.length} places; it must appear exactly once, in ${relative('.', IK_MODULE)}, because a second copy drifts on the next version bump and silently re-derives every \`import_key\` (${IK_ISSUE})`,
    );
  }
} else if (relative('.', ikSaltSites[0].file) !== relative('.', IK_MODULE)) {
  report(
    ikSaltSites[0].file,
    ikSaltSites[0].line,
    IK_RULE,
    `the import salt \`${IK_SALT}\` is spelled here instead of in ${relative('.', IK_MODULE)} — the salt belongs with the single derivation it separates (${IK_ISSUE})`,
  );
}

if (ikScanned < IK_SCAN_FLOOR) {
  violations.push(
    `  ${SRC}:0  [${IK_RULE}]  the import-KDF scan examined ${ikScanned} files, below the floor of ${IK_SCAN_FLOOR} — its roots or exemptions are wrong (an over-broad pattern empties the scan while leaving it non-zero) and the rule is passing over source it is supposed to read. Re-measure; if the shrink is a real, deliberate deletion, move IK_SCAN_FLOOR in the same commit (${IK_ISSUE})`,
  );
}
for (const [pattern, hits] of ikExemptHits) {
  if (hits === 0) {
    violations.push(
      `  ${SRC}:0  [${IK_RULE}]  the import-KDF exemption \`${pattern}\` matched ZERO scanned paths — it is a typo or a directory that has moved, and it reads as coverage that does not exist. Delete it, or fix it to match where those files actually live (${IK_ISSUE})`,
    );
  }
}

// --- 30.5 Stale-text detector on kdf.rs.
//
// `src/kdf.rs` says `source_item_id` is framed by #924. That is wrong — #925
// owns the framing — and it is deliberately NOT corrected, because
// `scripts/rust-input-digest.sh` hashes that directory, so a prose fix
// condemns every built xcframework and forces a Rust rebuild on every machine.
// The correction is therefore parked, and this clause is the tripwire that
// fires the day someone makes a REAL kdf.rs change and can fold it in for
// free. Failing here is good news, not a defect: apply the text and delete
// this clause.
const ikKdfRaw = meRead(
  IK_KDF_RS,
  IK_RULE,
  'the Rust module whose stale framing-ownership clause this rule tracks',
  IK_ISSUE,
);
//
// Matched against the comment markers stripped and whitespace collapsed,
// because the clause is WRAPPED across two `//!` lines in the real file and a
// literal `includes` would then "detect" a removal that never happened. A
// pure re-wrap keeps the rule green, which is right: the prose is still
// stale.
const ikKdfFlat =
  ikKdfRaw === null ? '' : ikKdfRaw.replace(/^[ \t]*\/\/[!/]?[ \t]?/gm, '').replace(/\s+/g, ' ');
if (ikKdfRaw !== null && !ikKdfFlat.includes(IK_STALE_CLAUSE)) {
  ikViolation(
    IK_KDF_RS,
    `the stale clause "${IK_STALE_CLAUSE}" is gone, so kdf.rs has been edited and the native digest has already moved — fold the correction in now, in this same commit, while the rebuild is already paid for. The two replacement texts have ONE home: the \`orbital_import_kat\` doc comment in ${relative('.', IK_KAT_RS)}, section "Fold-forward for the next real src/kdf.rs change" (kdf.rs lines 7-8, and the removal trigger at lines 56-64). Then DELETE the copies that only existed to park it: that fold-forward section in ${relative('.', IK_KAT_RS)}, this clause 30.5 (its constant, its meRead and this message), and the pointer to it in the ${relative('.', IK_MODULE)} module header`,
  );
}

// ---------------------------------------------------------------------------
// 31. meta-import-no-source-item-id (#921 / #925)
// ---------------------------------------------------------------------------

// The parser's `sourceItemId` (#925, `src/services/metaImport/sourceItemId.ts`)
// is the v1 identity frame, and the v1 framing embeds the member's REPAIRED
// POST TEXT verbatim. Those bytes ARE the member's content: the identifier is
// PLAINTEXT-CLASS, exactly like `import_items.body`, and it is never persisted,
// logged, thrown or sent. The only thing derived from it that ever leaves the
// parser is the 16-byte `import_key` (#924) — `hmacSha256(K_import,
// utf8(source) ‖ 0x00 ‖ sourceItemId)[0..16]` — and THAT is what migration 009
// stores and what the server dedups on.
//
// So the storage layer is the place to say "never here". A column named
// `source_item_id`, or a row-type field named `sourceItemId`, would be the
// member's post text sitting in a table under a name that reads like an
// opaque id — which is precisely how it would survive review. Rule 30 already
// keeps the DERIVATION to one module; this is the storage half of the same
// property, and it is a separate rule because the violation line has to say
// "schema", not "call site".
//
// SCOPE: every `.ts` in `src/database/migrations/` — the whole directory, not
// just 009, because the obvious way to add the column later is a migration
// 010 — plus `src/types/database.ts`, where the row interfaces live, plus
// `src/database/repositories/importRepository.ts`.
//
// The repository is in scope because a column is not the only way to persist
// this: `ImportItemInsert` is the parser → storage boundary, and `ParsedPost`
// (#925) really does carry a `sourceItemId` field. A writer that accepted one
// — to "key" an item, or by widening the insert type toward the parser's —
// would carry plaintext into this layer with no migration to review, and
// TypeScript would not stop it (excess-property checking does not reach
// spread-in properties). Mutation-proven: before this file was added to the
// list, a `sourceItemId` field on `ImportItemInsert` passed at exit 0.
//
// `meStripComments` first: 009's header, `ImportItemRow`'s doc comment and the
// repository's own "there is deliberately no `sourceItemId` here" line all
// NAME the identifier in order to say it is absent, and the prose must never
// be what fails the rule.
//
// NON-VACUITY: anchored on `CREATE TABLE import_items` still being in
// migration 009. A ban that scans a directory that has moved, or a 009 that no
// longer creates the table, is a ban over nothing — it must fail, not pass.

const MIT_RULE = 'meta-import-no-source-item-id';
const MIT_FRAME_ISSUE = '#921 / #925';
const MIT_MIGRATIONS_DIR = join(SRC, 'database', 'migrations');
const MIT_DB_TYPES = join(SRC, 'types', 'database.ts');
const MIT_REPOSITORY = join(SRC, 'database', 'repositories', 'importRepository.ts');
const MIT_SCHEMA_MIGRATION = join(MIT_MIGRATIONS_DIR, '009_meta_import_tables.ts');
const MIT_SCHEMA_ANCHOR = 'CREATE TABLE import_items';
const MIT_BANNED_RE = /source_item_id|sourceItemId/;

{
  const mitAnchorRaw = meRead(
    MIT_SCHEMA_MIGRATION,
    MIT_RULE,
    'the CREATE TABLE import_items anchor that makes this ban non-vacuous',
    MIT_FRAME_ISSUE,
  );
  if (mitAnchorRaw !== null && !meStripComments(mitAnchorRaw).includes(MIT_SCHEMA_ANCHOR)) {
    violations.push(
      `  ${relative('.', MIT_SCHEMA_MIGRATION)}:0  [${MIT_RULE}]  \`${MIT_SCHEMA_ANCHOR}\` is gone from the migration that owns the Meta import schema — the ban on source_item_id|sourceItemId would pass vacuously over a schema layer that no longer holds the table it protects (${MIT_FRAME_ISSUE})`,
    );
  }

  let mitMigrations = [];
  try {
    mitMigrations = readdirSync(MIT_MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.ts'))
      .sort()
      .map((name) => join(MIT_MIGRATIONS_DIR, name));
  } catch {
    violations.push(
      `  ${relative('.', MIT_MIGRATIONS_DIR)}:0  [${MIT_RULE}]  migrations directory not found — the schema-layer ban would pass vacuously (${MIT_FRAME_ISSUE})`,
    );
  }
  if (mitMigrations.length === 0) {
    violations.push(
      `  ${relative('.', MIT_MIGRATIONS_DIR)}:0  [${MIT_RULE}]  no .ts migration files to scan — a ban over zero files is a pass over nothing (${MIT_FRAME_ISSUE})`,
    );
  }

  for (const file of [...mitMigrations, MIT_DB_TYPES, MIT_REPOSITORY]) {
    const raw = meRead(file, MIT_RULE, 'the storage layer this ban covers', MIT_FRAME_ISSUE);
    if (raw === null) continue;
    const lines = meStripComments(raw).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!MIT_BANNED_RE.test(lines[i])) continue;
      report(
        file,
        i + 1,
        MIT_RULE,
        `the storage layer names source_item_id|sourceItemId — the v1 identity frame embeds the member's repaired post text verbatim, so those bytes ARE their content: PLAINTEXT-CLASS, never persisted. Only the 16-byte \`import_key\` derived from it (#924) is stored: ${lines[i].trim()} (${MIT_FRAME_ISSUE})`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

if (violations.length > 0) {
  console.error(`\nSecurity invariant violations (${violations.length}):\n`);
  for (const v of violations) {
    console.error(v);
  }
  console.error('');
  exit(1);
} else {
  console.log('Security invariants: all checks passed.');
  exit(0);
}
