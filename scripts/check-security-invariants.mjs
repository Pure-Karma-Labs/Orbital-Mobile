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

// react-native-image-picker imports restricted to useMediaPicker.ts + EditProfileScreen.tsx
const ALLOWED_PICKER_FILES = new Set([
  join(SRC, 'hooks', 'useMediaPicker.ts'),
  join(SRC, 'screens', 'EditProfileScreen.tsx'),
]);

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
 */
function checkWindowedPins(
  file,
  rule,
  windowRe,
  windowLabel,
  pins,
  forbidden = [],
  issue = '#746',
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
  const match = text.match(windowRe);
  if (match === null) {
    violations.push(
      `  ${relative('.', file)}:0  [${rule}]  ${windowLabel} not found — the rule would pass vacuously`,
    );
    return;
  }
  const body = match[0]
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
//     is version-pinned, cargo audit reads the committed lock, and the two
//     freshness gates share one input list (#812/#813)
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
//   EXECUTABLE (EXEC_CARGO_RE) decides the non-vacuity FLOORS and the
//   `cargo audit --file` rule. It requires the segment to START with the cargo
//   invocation (optionally behind a YAML `run:`), which is what a real command
//   looks like after splitting on `&&`/`||`/`;`/`|`.
//
// The split is the PR #859 blocking fix. When the floors counted permissive
// matches, the libsignal-bump issue body's "- Run cargo test --locked … and
// cargo clippy --locked …" line supplied test +1 and clippy +1 all by itself,
// so the entire rust-test job could be deleted and this invariant stayed
// green. Mutation-proven: replacing the real :334/:341 `run:` steps with
// `run: true` now fires two "found 0" violations.
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

      // --- Non-vacuity floors: executable invocations only.
      if (exec) counts[exec[1]] += 1;

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
const CARGO_EXPECTED = [
  ['.github/workflows/security.yml', 'test', 1, 'the rust-test job no longer runs cargo test'],
  ['.github/workflows/security.yml', 'clippy', 1, 'the rust-test job no longer runs cargo clippy'],
  ['.github/workflows/security.yml', 'audit', 1, 'the rust-audit job no longer runs cargo audit — the standing RUSTSEC gate'],
  ['.github/workflows/build.yml', 'build', 2, 'rust-apple-targets no longer cross-compiles both Apple slices'],
];
for (const [file, sub, min, why] of CARGO_EXPECTED) {
  const counts = cargoCounts.get(file);
  if (!counts) {
    violations.push(`  ${file}:0  [${RUST_PROV}]  expected cargo-bearing file was not scanned — ${why}`);
  } else if (counts[sub] < min) {
    violations.push(`  ${file}:0  [${RUST_PROV}]  expected >=${min} executable \`cargo ${sub}\` invocation(s), found ${counts[sub]} — ${why}`);
  }
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

// --- ubrn's own cargo passthrough must carry --locked on BOTH platforms.
// Defence in depth: ubrn 0.31.0-2 runs an unlocked `cargo metadata` first, so
// the raw workflow lines above remain the real gate.
const UBRN_CONFIG = 'packages/orbital-signal/ubrn.config.yaml';
try {
  const ubrnText = readFileSync(UBRN_CONFIG, 'utf8');
  for (const platform of ['ios', 'android']) {
    // Platform block = from `^<platform>:` to the next top-level key, or to
    // the absolute end of file — `(?![\s\S])`, since JS has no \Z and `$`
    // under /m would stop at the first newline.
    const block = new RegExp(`^${platform}:\\n([\\s\\S]*?)(?=^\\S|(?![\\s\\S]))`, 'm').exec(ubrnText);
    if (!block) {
      violations.push(`  ${UBRN_CONFIG}:0  [${RUST_PROV}]  no \`${platform}:\` block — cannot verify its cargoExtras`);
      continue;
    }
    const extras = /^\s+cargoExtras:\s*(.+)$/m.exec(block[1]);
    if (!extras) {
      violations.push(`  ${UBRN_CONFIG}:0  [${RUST_PROV}]  \`${platform}:\` block has no cargoExtras — ubrn would cargo build unlocked`);
    } else if (!extras[1].includes('--locked')) {
      violations.push(`  ${UBRN_CONFIG}:0  [${RUST_PROV}]  \`${platform}: cargoExtras\` does not contain --locked: ${extras[1].trim()}`);
    }
  }
} catch {
  violations.push(`  ${UBRN_CONFIG}:0  [${RUST_PROV}]  ubrn config not found — cannot verify cargoExtras`);
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

const FRESHNESS_GATES = [
  {
    file: 'android/check-rust-freshness.gradle',
    label: 'Android mtime gate',
    strip: stripCStyleComments,
    // The gradle gate composes its src path from a projectRoot variable, so
    // match the tail rather than the full relpath.
    names: ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'orbital_signal/src'],
    execAnchors: [
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
const MARKER_WRITER_CALLERS = [
  ['packages/orbital-signal/package.json', 'the build:ios[:release] scripts no longer call the shared marker writer'],
  ['scripts/test-rust-profile-gate-ios.sh', 'the harness no longer exercises the real marker writer, so writer drift would not surface on a PR'],
];
try {
  statSync(MARKER_WRITER);
  for (const [caller, why] of MARKER_WRITER_CALLERS) {
    try {
      if (!readFileSync(caller, 'utf8').includes('write-rust-marker-ios.sh')) {
        violations.push(`  ${caller}:0  [${RUST_PROV}]  does not reference ${MARKER_WRITER} — ${why}`);
      }
    } catch {
      violations.push(`  ${caller}:0  [${RUST_PROV}]  expected marker-writer caller not found — ${why}`);
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

const ME_INFO_PLIST = join('ios', 'OrbitalMobile', 'Info.plist');
const ME_PLIST_RULE = 'ios-photo-add-usage';
const ME_PLIST_KEY = 'NSPhotoLibraryAddUsageDescription';

try {
  const plistText = readFileSync(ME_INFO_PLIST, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
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
  const manifestText = readFileSync(ME_APP_MANIFEST, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
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
// Kept as FOUR separate rules rather than folded into rule 21: the rule name is
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
//   media-export-no-name-logging    — the service, sanitizer, abort helper and
//                                     the package's src/index.tsx +
//                                     src/NativeOrbitalMediaExport.ts carry no
//                                     file_name|fileName|displayName|localPath|
//                                     sourcePath|mediaId on a log or Sentry
//                                     line; the normalizer never interpolates
//                                     the native message; the .mm/.kt contain
//                                     no NSLog|os_log|android.util.Log.
//   media-export-wipe-wired         — localWipe aborts exports before deleting
//                                     MEDIA_DIR and sweeps the staging dir;
//                                     cleanupOrphanedChunks sweeps it too.

const ME_SERVICE = join(SRC, 'services', 'mediaExportService.ts');
const ME_SANITIZER = join(SRC, 'services', 'media', 'exportFileName.ts');
const ME_ABORTABLE = join(SRC, 'services', 'media', 'abortable.ts');
const ME_PKG_INDEX = join(MEDIA_EXPORT_PKG, 'src', 'index.tsx');
const ME_PKG_SPEC = join(MEDIA_EXPORT_PKG, 'src', 'NativeOrbitalMediaExport.ts');
const ME_AUTH_SERVICE = join(SRC, 'services', 'authService.ts');
const ME_UPLOAD_SERVICE = join(SRC, 'services', 'mediaUploadService.ts');

/**
 * PR 2 adds `src/services/media/bulkExportRunner.ts`. It is scanned by
 * `media-export-no-name-logging` the moment it exists (see ME_OPTIONAL_LOG_FILES)
 * and must be MOVED into the required list in that PR — a file that only
 * exists in half the delivery cannot be a required file here without failing
 * PR 1, and a rule that passes because its subject is absent is the vacuity
 * these checks exist to prevent. The required list below is PR 1's complete
 * set, so nothing is currently unguarded.
 */
const ME_OPTIONAL_LOG_FILES = [join(SRC, 'services', 'media', 'bulkExportRunner.ts')];

/** Read a file, recording a violation and returning null when it is missing. */
function meRead(file, rule, why) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    violations.push(
      `  ${relative('.', file)}:0  [${rule}]  file not found — ${why} cannot be verified and the rule would pass vacuously (${ME_ISSUE})`,
    );
    return null;
  }
}

/**
 * Blank out comment lines and trailing `//` comments, PRESERVING line count
 * and byte offsets so index comparisons below stay meaningful.
 *
 * This is what stops a pin from being satisfied by prose: every one of these
 * files documents the very identifiers the rules forbid (this script does
 * too), and a mention must never count as a call.
 */
function meStripComments(text) {
  let inBlock = false;
  return text
    .split('\n')
    .map((line) => {
      if (inBlock) {
        const end = line.indexOf('*/');
        if (end === -1) return ' '.repeat(line.length);
        inBlock = false;
        return ' '.repeat(end + 2) + line.slice(end + 2);
      }
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//')) return ' '.repeat(line.length);
      if (trimmed.startsWith('/*')) {
        const end = line.indexOf('*/');
        if (end === -1) {
          inBlock = true;
          return ' '.repeat(line.length);
        }
        return ' '.repeat(end + 2) + line.slice(end + 2);
      }
      if (trimmed.startsWith('*')) return ' '.repeat(line.length);
      const slash = line.indexOf('//');
      // Not inside a string literal: none of these files has a `//` in one
      // (URLs live in config/env.ts), and over-stripping can only make a
      // required pin fail, never make a forbidden one pass.
      if (slash !== -1) return line.slice(0, slash) + ' '.repeat(line.length - slash);
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
  ME_SANITIZER,
  ME_ABORTABLE,
  ME_PKG_INDEX,
  ME_PKG_SPEC,
];

for (const file of ME_REQUIRED_LOG_FILES.concat(
  ME_OPTIONAL_LOG_FILES.filter((f) => {
    try {
      statSync(f);
      return true;
    } catch {
      return false;
    }
  }),
)) {
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
checkWindowedPins(
  MEDIA_EXPORT_MM,
  ME_LOG_RULE,
  /^#import "OrbitalMediaExport\.h"[\s\S]*/m,
  'OrbitalMediaExport.mm (logging ban)',
  [],
  ['NSLog', 'os_log'],
  ME_ISSUE,
);

checkWindowedPins(
  MEDIA_EXPORT_KT,
  ME_LOG_RULE,
  /^package com\.orbital\.mediaexport[\s\S]*/m,
  'OrbitalMediaExportModule.kt (logging ban)',
  [],
  ['android.util.Log', 'Log.d(', 'Log.e(', 'Log.i(', 'Log.w(', 'Log.v('],
  ME_ISSUE,
);

// ---------------------------------------------------------------------------
// 24d. media-export-wipe-wired
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
//  - `clearMediaExportStaging()` sweeps `Caches/orbital-export/`. That
//    directory is the ONE media-pipeline residue in a SUBDIRECTORY, so the
//    `isStagingResidueName` suffix sweep — a non-recursive readDir — cannot
//    reach it no matter what the files are called.
//
// `cleanupOrphanedChunks` carries the same sweep, which is how BOOTSTRAP is
// covered after a crash or jetsam mid-picker.

const ME_WIPE_RULE = 'media-export-wipe-wired';

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
    // The media-directory deletion, identified by the local it binds.
    const mediaDirIdx = wipe[0].indexOf('mediaDirPath');
    const at = meLineOf(body, wipe.index);

    if (cancelIdx === -1) {
      violations.push(
        `  ${relative('.', ME_AUTH_SERVICE)}:${at}  [${ME_WIPE_RULE}]  localWipe() does not call cancelAllExports( (${ME_ISSUE})`,
      );
    }
    if (sweepIdx === -1) {
      violations.push(
        `  ${relative('.', ME_AUTH_SERVICE)}:${at}  [${ME_WIPE_RULE}]  localWipe() does not call clearMediaExportStaging( (${ME_ISSUE})`,
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
