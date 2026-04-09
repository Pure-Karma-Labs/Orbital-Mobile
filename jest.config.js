module.exports = {
  preset: 'react-native',
  transformIgnorePatterns: [
    'node_modules/(?!(react-native|@react-native|@react-navigation|react-native-screens|react-native-gesture-handler|react-native-mmkv|react-native-keychain|react-native-safe-area-context|@op-engineering/op-sqlite)/)',
  ],
};
