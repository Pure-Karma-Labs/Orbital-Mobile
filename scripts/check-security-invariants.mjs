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
