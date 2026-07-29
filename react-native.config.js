module.exports = {
  project: {
    ios: {
      // Pod installs are always explicit in this repo (paired lockfile
      // commits, pod version matched to Podfile.lock's COCOAPODS stamp).
      // The CLI's auto-install runs `bundle exec pod`, whose Gemfile
      // resolution (1.15.x) disagrees with the stamp (1.17.0) and silently
      // rewrites it mid run-ios.
      //
      // Consequences of disabling:
      // - After adding/upgrading a native dependency, run `cd ios && pod
      //   install` (Homebrew pod, version matching the lockfile stamp)
      //   yourself — the build no longer self-heals, and a missing install
      //   surfaces as a runtime null-native-module error, not a build error.
      // - Never use `--force-pods` / `--only-pods`: both bypass this flag
      //   and route through the mismatched `bundle exec pod`.
      automaticPodsInstallation: false,
    },
    android: {},
  },
  assets: ['./src/theme/fonts/'],
};
