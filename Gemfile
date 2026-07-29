# NOTE on CocoaPods versions: the Homebrew-installed pod (matching
# ios/Podfile.lock's COCOAPODS stamp) is the source of truth for lockfile
# generation — CI and all repo procedures run bare `pod install`, never
# `bundle exec pod`. This Gemfile exists only because the RN CLI hard-errors
# without one; its cocoapods bound resolves LOWER than the stamp and must not
# be "fixed" to match: cocoapods >= 1.17 requires xcodeproj >= 1.28.1, which
# conflicts with the deliberate `xcodeproj < 1.26.0` guard below. The CLI
# path that consumed this (automatic pod installation) is disabled in
# react-native.config.js.
source 'https://rubygems.org'

# You may use http://rbenv.org/ or https://rvm.io/ to install and use this version
ruby ">= 2.6.10"

# Exclude problematic versions of cocoapods and activesupport that causes build failures.
gem 'cocoapods', '>= 1.13', '!= 1.15.0', '!= 1.15.1'
gem 'activesupport', '>= 6.1.7.5', '!= 7.1.0'
gem 'xcodeproj', '< 1.26.0'
gem 'concurrent-ruby', '< 1.3.4'

# Ruby 3.4.0 has removed some libraries from the standard library.
gem 'bigdecimal'
gem 'logger'
gem 'benchmark'
gem 'mutex_m'
gem 'nkf'
gem 'tsort'
