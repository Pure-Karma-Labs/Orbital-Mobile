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
        "CallExpression[callee.property.name=/^toLocale(Date|Time)?String$/], " +
        "CallExpression[callee.property.value=/^toLocale(Date|Time)?String$/], " +
        // MemberExpression alone covers every Intl form, `new Intl.X()` included
        // (the NewExpression callee IS that member expression), so a separate
        // NewExpression selector would only double-report. Verified by probe.
        "MemberExpression[object.name='Intl'], " +
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
