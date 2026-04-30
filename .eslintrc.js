module.exports = {
  root: true,
  extends: '@react-native',
  ignorePatterns: ['docs/', 'coverage/', '**/target/'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    'no-bitwise': 'off',
  },
};
