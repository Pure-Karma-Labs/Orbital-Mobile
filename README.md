# Orbital Mobile

![CI](https://github.com/Pure-Karma-Labs/Orbital-Mobile/actions/workflows/ci.yml/badge.svg?branch=main)
![Build](https://github.com/Pure-Karma-Labs/Orbital-Mobile/actions/workflows/build.yml/badge.svg?branch=main)

Orbital is a private, encrypted discussion board for families — not a chat app. Instead of one endless group chat where photos and conversations disappear into the scroll, Orbital organizes your family's life into searchable, threaded topics backed by Signal Protocol encryption, with full-quality 4K video sharing up to 500MB and distributed backup across every member of your Orbit. Unlike Signal or Telegram, Orbital is purpose-built for focused group discussions with time-tested bulletin board style forum archival and search features built in.

This is the native mobile client, built with React Native 0.82+ (New Architecture), sharing the same [backend](https://github.com/Pure-Karma-Labs/Orbital-Backend) and Signal Protocol encryption as the desktop app.

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

## License

This project is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE).

Orbital-Mobile uses [libsignal](https://github.com/signalapp/libsignal) for end-to-end encryption, which is also licensed under AGPL-3.0.
