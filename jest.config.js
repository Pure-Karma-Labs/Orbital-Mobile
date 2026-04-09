module.exports = {
  preset: 'react-native',
  testPathIgnorePatterns: ['/node_modules/', '\\.clone/', '\\.claude/worktrees/'],
  modulePathIgnorePatterns: ['\\.clone/', '\\.claude/worktrees/'],
  transformIgnorePatterns: [
    'node_modules/(?!(react-native|@react-native|@react-navigation|react-native-screens|react-native-gesture-handler|react-native-mmkv|react-native-keychain|react-native-safe-area-context|@op-engineering/op-sqlite)/)',
  ],
};
