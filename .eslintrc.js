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
            { group: ['**/uploadTelemetry', '**/telemetry'], message: 'Telemetry facades forward to Sentry; banned where Sentry is banned. src/services/telemetryScrub.ts is pure and stays allowed.' },
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
