---
name: Bootstrap sequence and deferred init pattern
description: Keychain→MMKV→Database→TokenManager bootstrap in index.js; deferred init pattern used by MMKV and SQLCipher; BootstrapErrorScreen for Keychain failure.
type: project
---

Bootstrap happens in `src/bootstrap.ts`, called from `index.js` **before** `AppRegistry.registerComponent`.

Sequence:
1. `enableScreens()` (react-native-screens)
2. `clearKeychainIfFreshInstall()` — wipes Keychain on fresh installs (reinstall attack prevention)
3. `getOrCreateMMKVKey()` → `initMMKV(key)`
4. `getOrCreateDatabaseKey()` → `initDatabase(key)`
5. `initIdentityKeyCache()` — loads identity private key from Keychain into module-scoped cache in `keyGenerationService.ts`; must run before any `cryptoService` call
6. Register `KeychainTokenStorage` with `tokenManager`
7. Register `clearAuth` callback via `tokenManager.setOnTokensCleared()`
8. `AppRegistry.registerComponent(appName, () => App)` — only on success
9. On any failure: `require('./src/screens/BootstrapErrorScreen').default` registered instead

`BootstrapErrorScreen` (`src/screens/BootstrapErrorScreen.tsx`) is a plain RN View with no theme system, Zustand, or MMKV dependency — it works before any of those are initialized.

Deferred init pattern (used by both MMKV and SQLCipher):
- `initX(key)` — called once in bootstrap; throws if called twice
- `getX()` — throws with descriptive message if called before init
- `closeX()` — for graceful shutdown and test teardown
- `resetXForTesting()` — creates unencrypted in-memory instance for Jest

MMKV: `initMMKV`, `getMMKVInstance`, `closeMMKV`, `resetMMKVForTesting` (src/stores/middleware/persistence.ts)
SQLCipher: `initDatabase`, `getDatabase`, `closeDatabase`, `resetDatabaseForTesting` (src/database/connection.ts)

**Why:** Encryption keys come from Keychain and must exist before any storage is opened. Running bootstrap synchronously before AppRegistry guarantees no component ever runs with uninitialized storage.

**How to apply:** Never call `initMMKV()` or `initDatabase()` from a component, hook, or store initializer. Always go through `src/bootstrap.ts`. In tests, use `resetXForTesting()` in `beforeEach`.
