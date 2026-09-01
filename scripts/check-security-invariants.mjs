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
// 12. Firebase stays on CocoaPods (SPM disabled)
// ---------------------------------------------------------------------------

// @react-native-firebase >= 26 defaults to SPM on RN >= 0.75. We opt out via
// $RNFirebaseDisableSPM = true in ios/Podfile — the rationale has ONE home, the
// comment above that line in ios/Podfile (short version: this Podfile pins the
// Firebase pods directly, so SPM would add a second Firebase module graph).
// The flag must be exactly `true` (ruby podspec tests `== true`).
// Runtime guards (Podfile post_install + post_integrate, ci.yml pod-log check and
// post-install pbxproj diff) complement this static check. See #667 / #637.
//
// Anchored on the dependency: if @react-native-firebase/app is ever removed,
// delete this rule rather than leave it to pass vacuously.

try {
  const pkg = JSON.parse(readFileSync(PKG_JSON, 'utf8'));
  if (pkg.dependencies?.['@react-native-firebase/app'] === undefined) {
    violations.push(
      `  ${PKG_JSON}:0  [rnfb-cocoapods-pinned]  @react-native-firebase/app is no longer a dependency — delete this rule instead of leaving a vacuous check`,
    );
  } else {
    let podfile;
    try {
      podfile = readFileSync(join('ios', 'Podfile'), 'utf8');
    } catch {
      podfile = null;
      violations.push(
        `  ios/Podfile:0  [rnfb-cocoapods-pinned]  ios/Podfile not found — cannot verify $RNFirebaseDisableSPM`,
      );
    }
    if (podfile !== null && !/^\$RNFirebaseDisableSPM\s*=\s*true\s*$/m.test(podfile)) {
      violations.push(
        `  ios/Podfile:0  [rnfb-cocoapods-pinned]  ios/Podfile must declare "$RNFirebaseDisableSPM = true" (exactly true) — see #667/#637`,
      );
    }
  }
} catch {
  violations.push(
    `  ${PKG_JSON}:0  [rnfb-cocoapods-pinned]  package.json unreadable — cannot verify the @react-native-firebase/app anchor`,
  );
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
