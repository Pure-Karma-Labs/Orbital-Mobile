module.exports = {
  presets: ['module:@react-native/babel-preset'],
  env: {
    test: {
      // Jest's CJS VM cannot execute native dynamic import(); transform it to
      // require() so lazy imports (e.g. bootstrap.ts) run and stay mockable.
      plugins: ['@babel/plugin-transform-dynamic-import'],
    },
  },
};
