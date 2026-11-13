// #926 — why src/services/metaImport/** may not reach contentCrypto at all.
// Named once because the ban is spelled twice below (the module, and the crypto
// barrel that re-exports it); the two must never drift apart.
const CONTENT_CRYPTO_BAN =
  'metaImport/ must not import crypto/contentCrypto (directly or via the crypto barrel). ' +
  "getOrFetchGroupKey returns the group-key cache's OWN array, and invalidateGroupKey / " +
  'clearGroupKeyCache zero that array IN PLACE mid-run — invalidateGroupKey is reachable from the ' +
  'WebSocket decrypt retry. An import runner that held raw key bytes across an await would encrypt ' +
  'under 32 zero bytes, unnoticed by encryptContent (which does not validate its key). Seal through ' +
  'ImportKeySession.sealContent (services/crypto/importCrypto.ts), which re-reads the live key, ' +
  'checks its width and all-zero floor, byte-compares it against the session pin, and encrypts with ' +
  'no await in between. Never hold raw key bytes in metaImport/.';

module.exports = {
  root: true,
  extends: '@react-native',
  ignorePatterns: ['docs/', 'coverage/', '**/target/'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    'no-bitwise': 'off',
    'no-restricted-imports': ['error', {
      paths: [
        { name: '@react-native-async-storage/async-storage', message: 'Use encrypted MMKV via src/stores/middleware/persistence.ts instead. AsyncStorage is unencrypted.' },
      ],
      patterns: [
        { group: ['react-native-mmkv'], message: 'Import from src/stores/middleware/persistence.ts instead. Direct MMKV usage bypasses encryption key management.' },
      ],
    }],
    'no-restricted-syntax': ['error', {
      selector:
        // /^toLocale/ covers the whole family, case methods included, so the
        // message's "toLocale*" is literally true: toLocaleUpperCase and
        // toLocaleLowerCase are the same ICU-dependent class. Both selectors
        // exist so `x["toLocaleDateString"]()` is caught alongside `x.toLocale…()`.
        "CallExpression[callee.property.name=/^toLocale/], " +
        "CallExpression[callee.property.value=/^toLocale/], " +
        // The bare Identifier catches every Intl form exactly once — `Intl.X`,
        // `new Intl.X()`, `const { X } = Intl`, `globalThis.Intl.X`, `typeof
        // Intl` — where MemberExpression missed destructuring and double-reported
        // `new Intl.X()`. No identifier named Intl exists in src/. Probe-verified.
        // An `as any` cast (`(Intl as any).X`, `(globalThis as any).Intl`) still
        // escapes: that is deliberate circumvention, not an accident, and is not
        // chased here.
        "Identifier[name='Intl'], " +
        "CallExpression[callee.property.name=/^to(Date|Time)String$/]",
      message:
        'Locale/implementation-dependent formatting (toLocale*, Intl.*, toDateString, toTimeString) drifts between Hermes (trimmed ICU) and Node. ' +
        'Use the hand-built formatters in src/utils/formatPostTimestamp.ts, adding an export there if none fits (#845). toISOString/toUTCString/toJSON are spec-fixed and allowed.',
    }],
  },
  overrides: [
    {
      files: ['src/services/crypto/**/*', 'src/services/secure-storage/**/*', 'src/database/**/*'],
      rules: {
        'no-console': 'error',
        'no-restricted-imports': ['error', {
          paths: [
            { name: '@react-native-async-storage/async-storage', message: 'Use encrypted MMKV via src/stores/middleware/persistence.ts instead. AsyncStorage is unencrypted.' },
          ],
          patterns: [
            { group: ['react-native-mmkv'], message: 'Import from src/stores/middleware/persistence.ts instead.' },
            { group: ['@sentry/*', '@sentry/react-native'], message: 'Sentry must not be imported in crypto/secure-storage/database paths to prevent key material leakage in error reports.' },
            // '**/*Telemetry' covers every facade by naming convention (uploadTelemetry, groupKeyTelemetry, and the next one);
            // '**/telemetry' is kept because the bare module name has no suffix to match. Neither matches '**/telemetryScrub'.
            { group: ['**/*Telemetry', '**/telemetry'], message: 'Telemetry facades forward to Sentry; banned where Sentry is banned. src/services/telemetryScrub.ts is pure and stays allowed.' },
          ],
        }],
      },
    },
    {
      // #926: the Meta-import runner must never touch the group key directly.
      // Mirrors the crypto fence above in shape — an override REPLACES the base
      // rule config, so the two base bans are restated rather than inherited.
      files: ['src/services/metaImport/**/*'],
      rules: {
        'no-restricted-imports': ['error', {
          paths: [
            { name: '@react-native-async-storage/async-storage', message: 'Use encrypted MMKV via src/stores/middleware/persistence.ts instead. AsyncStorage is unencrypted.' },
            // The crypto barrel re-exports getOrFetchGroupKey / encryptContent /
            // invalidateGroupKey verbatim, so it is a second door to the banned module.
            // `paths` (exact specifier), not a pattern: the only glob that would catch
            // '../crypto' also catches '../crypto/importCrypto' under the rule's
            // gitignore directory semantics, and importCrypto is the sanctioned door.
            { name: '../crypto', message: CONTENT_CRYPTO_BAN },
            { name: '../../crypto', message: CONTENT_CRYPTO_BAN },
          ],
          patterns: [
            { group: ['react-native-mmkv'], message: 'Import from src/stores/middleware/persistence.ts instead. Direct MMKV usage bypasses encryption key management.' },
            // One glob covers every spelling: the rule matches with
            // ignore({ allowRelativePaths: true }), under which '**/' spans the leading
            // '..' segments, so '../crypto/contentCrypto' and '../../crypto/contentCrypto'
            // both match. Probe-verified in both directions (it does NOT match
            // '../crypto/importCrypto', which metaImport/ must keep importing).
            { group: ['**/crypto/contentCrypto'], message: CONTENT_CRYPTO_BAN },
          ],
        }],
      },
    },
    {
      // The fence above is a production-code rule. metaImport's suites import
      // contentCrypto to mock it — that is the whole point of a mock — so the
      // crypto ban is lifted here rather than forcing an eslint-disable per
      // suite. The two BASE bans are restated rather than switching the rule
      // off wholesale: an unencrypted-storage import is exactly as wrong in a
      // test as anywhere else, and every other suite in the repo still has
      // them.
      files: ['src/services/metaImport/**/__tests__/**', 'src/services/metaImport/**/*.test.ts'],
      rules: {
        'no-restricted-imports': ['error', {
          paths: [
            { name: '@react-native-async-storage/async-storage', message: 'Use encrypted MMKV via src/stores/middleware/persistence.ts instead. AsyncStorage is unencrypted.' },
          ],
          patterns: [
            { group: ['react-native-mmkv'], message: 'Import from src/stores/middleware/persistence.ts instead. Direct MMKV usage bypasses encryption key management.' },
          ],
        }],
      },
    },
    {
      files: ['src/stores/middleware/persistence.ts'],
      rules: {
        'no-restricted-imports': ['error', {
          paths: [
            { name: '@react-native-async-storage/async-storage', message: 'Use encrypted MMKV via src/stores/middleware/persistence.ts instead.' },
          ],
        }],
      },
    },
  ],
};
