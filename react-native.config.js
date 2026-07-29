module.exports = {
  project: {
    ios: {
      // Pod installs are always explicit in this repo (paired lockfile
      // commits, pod version matched to Podfile.lock's COCOAPODS stamp).
      // The CLI's auto-install runs `bundle exec pod`, whose Gemfile
      // resolution (1.15.x) disagrees with the stamp (1.17.0) and silently
      // rewrites it mid run-ios.
      automaticPodsInstallation: false,
    },
    android: {},
  },
  assets: ['./src/theme/fonts/'],
};
