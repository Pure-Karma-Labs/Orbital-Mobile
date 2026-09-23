module.exports = {
  preset: 'react-native',
  // In CI (or when JEST_LOG_START=1 locally), emit a START line per test file
  // so that when the Jest step cap fires the last logged file identifies the
  // hung suite (#834).
  reporters: [
    'default',
    ...(process.env.CI || process.env.JEST_LOG_START
      ? ['./scripts/jest/startLoggerReporter']
      : []),
  ],
  testPathIgnorePatterns: ['/node_modules/', '\\.clone/', '\\.claude/worktrees/'],
  modulePathIgnorePatterns: ['\\.clone/', '\\.claude/worktrees/'],
  transformIgnorePatterns: [
    'node_modules/(?!(react-native|@react-native|@react-navigation|@react-native-firebase|@notifee|react-native-screens|react-native-gesture-handler|react-native-mmkv|react-native-keychain|react-native-safe-area-context|@op-engineering/op-sqlite|react-native-config)/)',
  ],
  moduleNameMapper: {
    '^orbital-signal$': '<rootDir>/__mocks__/orbital-signal.ts',
    '^orbital-media-transcoder$': '<rootDir>/__mocks__/orbital-media-transcoder.ts',
  },
  setupFilesAfterEnv: ['./jest.setup.ts'],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/types/**',
    '!src/**/index.ts',
    '!src/navigation/types.ts',
    '!src/emoji/assetMap.ts',
    '!src/**/testUtils/**',
  ],
  coverageThreshold: {
    global: {
      statements: 70,
      branches: 55,
      functions: 65,
      lines: 70,
    },
  },
  coverageReporters: ['text', 'text-summary', 'lcov', 'json-summary'],
};
