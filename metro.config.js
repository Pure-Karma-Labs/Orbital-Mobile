const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  watchFolders: [
    path.resolve(__dirname, 'packages/orbital-signal'),
  ],
  resolver: {
    // Prefer CJS — fuse.js v7 ships .mjs referencing @babel/runtime helpers
    // that Metro can't resolve; resolving main (CJS) before module (ESM) fixes it
    resolverMainFields: ['react-native', 'main', 'module'],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
