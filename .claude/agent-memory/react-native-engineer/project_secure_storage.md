---
name: Secure storage — Issue #18
description: react-native-keychain for Keychain/Keystore, deferred MMKV encryption key, bootstrap sequence in index.js before AppRegistry.
type: project
---

Secure storage lives at `src/services/secure-storage/`.

Key files:
- `secureStorage.ts` — `setSecureItem`, `getSecureItem`, `removeSecureItem`, `clearAll` wrappers over react-native-keychain; `clearKeychainIfFreshInstall` detects reinstalls
- `encryptionKeys.ts` — `getOrCreateMMKVKey()` and `getOrCreateDatabaseKey()` generate and persist 256-bit CSPRNG keys in Keychain on first run, returning the same key on subsequent runs
- `keychainTokenStorage.ts` — `KeychainTokenStorage` implements `TokenStorage` interface for the token manager
- `constants.ts` — `SecureKeys` enum, `SERVICE_PREFIX`, `KEYCHAIN_USERNAME`

Bootstrap sequence (`index.js`):
1. `enableScreens()` (react-native-screens)
2. `bootstrap()` from `src/bootstrap.ts`:
   - `clearKeychainIfFreshInstall()` — wipes Keychain if it's a fresh install (reinstall attack prevention)
   - `getOrCreateMMKVKey()` → `initMMKV(key)`
   - `getOrCreateDatabaseKey()` → `initDatabase(key)`
   - Register `KeychainTokenStorage` with `tokenManager`
   - Register `clearAuth` callback via `tokenManager.setOnTokensCleared()`
3. `AppRegistry.registerComponent(appName, () => App)` — only fires on bootstrap success
4. On bootstrap failure: `require('./src/screens/BootstrapErrorScreen').default` registered instead

`BootstrapErrorScreen` (`src/screens/BootstrapErrorScreen.tsx`) renders without the theme system so it works before MMKV/Zustand are initialized.

**Why:** Keychain keys must be retrieved before MMKV or the database can be opened. Doing this in bootstrap (before AppRegistry) means no component ever runs without initialized storage. The lazy-require of BootstrapErrorScreen prevents App from being imported before stores are initialized.

**How to apply:** Never call `initMMKV()` or `initDatabase()` from within a component or store. Always bootstrap first, then register the component tree.
