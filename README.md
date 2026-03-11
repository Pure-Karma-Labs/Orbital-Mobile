# Orbital Mobile

Native mobile client for the [Orbital](https://github.com/alexg-g/Orbital-Desktop) private family social network. Built with React Native 0.82+ (New Architecture), sharing the same backend and Signal Protocol encryption as the desktop app.

## Prerequisites

- **Node.js** >= 20
- **Xcode** >= 16 (iOS)
- **Android Studio** with JDK 17 (Android)
- **CocoaPods** (iOS)
- **Watchman** (recommended)

## Quick Start

```bash
# Install dependencies
npm install

# iOS
cd ios && pod install && cd ..
npx react-native run-ios

# Android
npx react-native run-android

# Run tests
npm test

# Lint
npm run lint
```

## Architecture

- **Framework:** React Native 0.82+ with New Architecture (Fabric + TurboModules)
- **JS Engine:** Hermes (default)
- **Crypto:** Turbo Modules wrapping `@signalapp/libsignal-client` via uniffi-bindgen-react-native
- **Backend:** orbital-backend (https://api.orbitl.org)
- **Local Storage:** SQLite/SQLCipher

## Project Structure

```
src/
├── components/       # Reusable UI components
├── crypto/           # Crypto service interfaces
├── database/         # SQLite/SQLCipher layer
├── navigation/       # React Navigation setup
├── screens/          # Screen components
├── services/
│   ├── api/          # REST API client
│   ├── crypto/       # Crypto service implementations
│   └── websocket/    # WebSocket client
├── stores/
│   └── protocol/     # Signal Protocol stores
├── theme/            # Design tokens, colors, typography
├── types/            # Shared TypeScript types
└── utils/            # Utility functions
rust/
└── orbital_signal/   # Rust crate wrapping libsignal
ios/                  # iOS native project
android/              # Android native project
fastlane/             # Fastlane automation
.github/workflows/    # CI/CD pipelines
```
