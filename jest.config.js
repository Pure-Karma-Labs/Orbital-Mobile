module.exports = {
  preset: 'react-native',
  testPathIgnorePatterns: ['/node_modules/', '\\.clone/', '\\.claude/worktrees/'],
  modulePathIgnorePatterns: ['\\.clone/', '\\.claude/worktrees/'],
  transformIgnorePatterns: [
    'node_modules/(?!(react-native|@react-native|@react-navigation|react-native-screens|react-native-gesture-handler|react-native-mmkv|react-native-keychain|react-native-safe-area-context|@op-engineering/op-sqlite)/)',
  ],
  setupFilesAfterEnv: ['./jest.setup.ts'],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/types/**',
    '!src/**/index.ts',
    '!src/navigation/types.ts',
  ],
  coverageThreshold: {
    global: {
      statements: 75,
      branches: 60,
      functions: 68,
      lines: 75,
    },
  },
  coverageReporters: ['text', 'text-summary', 'lcov', 'json-summary'],
};
