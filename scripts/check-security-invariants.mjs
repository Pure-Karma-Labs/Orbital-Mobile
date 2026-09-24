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
import { join, relative } from 'node:path';
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
 */
function checkWindowedPins(file, rule, windowRe, windowLabel, pins) {
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
    .join('\n');
  for (const pin of pins) {
    if (!body.includes(pin)) {
      violations.push(
        `  ${relative('.', file)}:0  [${rule}]  "${pin}" missing from ${windowLabel} (#746)`,
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
