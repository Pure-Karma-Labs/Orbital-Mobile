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
