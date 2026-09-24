import * as Sentry from '@sentry/react-native';
import { SENTRY_DSN } from './config/env';
import { filterBreadcrumb, scrubEvent } from './services/telemetryScrub';

/**
 * `enableNetworkBreadcrumbs` is a sentry-cocoa option (read by
 * `optionsFromDictionary`) with no entry in the React Native typings.
 * `initNativeSdk` (dist/js/wrapper.js) forwards options to native with a
 * DENY-list rest-destructure, so an unknown-to-JS key still reaches cocoa.
 * Android's parser is an allow-list and ignores it, which is fine: Android's
 * OkHttp breadcrumbs are opt-in and we never enable them.
 */
type CocoaPassthrough = { enableNetworkBreadcrumbs: boolean };

// Must be imported in index.js BEFORE `./src/App` — App.tsx calls Sentry.wrap()
// at module scope, and the SDK requires init to run before wrap or the
// app-start span is lost. Init always runs (disabled without a DSN) so dev
// builds don't warn "`Sentry.wrap` was called before `Sentry.init`".
const options: Sentry.ReactNativeOptions & CocoaPassthrough = {
  dsn: SENTRY_DSN,
  enabled: Boolean(SENTRY_DSN),
  environment: __DEV__ ? 'development' : 'production',
  sendDefaultPii: false,
  // iOS only. sentry-cocoa >= 9.2x defaults this to false (it was unconditionally
  // on before, reading memory near the crash site into native crash reports).
  // Pinned explicitly: process memory holds the SQLCipher key, identity keys
  // and decrypted plaintext, and this must never follow an upstream default.
  enableMemoryIntrospection: false,
  // The SDK default, pinned so the stage trail (#738) cannot be silently
  // evicted by a future default change. CONDITIONAL on the native flag below
  // taking effect: dropping the JS xhr crumbs turns the SDK's
  // `deduplicateNativeHttpBreadcrumbs` into a no-op (it needs a JS xhr/fetch
  // crumb to match against), so if cocoa ever ignored
  // `enableNetworkBreadcrumbs`, native http crumbs would fill all 100 slots
  // before `scrubEvent` deletes them and the stage trail would be gone. The
  // device check in the PR verifies the trail survives; if it does not, raise
  // this value.
  maxBreadcrumbs: 100,
  // iOS: sentry-cocoa 9.29 defaults this ON and swizzles NSURLSession, so it
  // sees RN fetch and RNFS traffic. Those URLs carry orbit / thread / media
  // UUIDs and `setUser({ id })` makes them attributable. The JS hooks below
  // cannot cover this: `initNativeSdk` strips `beforeSend`/`beforeBreadcrumb`
  // from the native options, so a HARD NATIVE CRASH report is assembled by
  // cocoa with no JS boundary in the path. This flag is the only defence
  // there, and it is unverifiable from JS — see docs/ios-dependency-delivery.md
  // for the re-check triggers on an SDK bump.
  enableNetworkBreadcrumbs: false,
  // Replace the default Breadcrumbs integration (name: 'Breadcrumbs') with one
  // that has console capture off. Console crumbs would otherwise record the
  // raw arguments of every console.warn/error; our content-bearing logs are
  // `__DEV__`-guarded, so this is hardening rather than a live leak, but the
  // guard is a convention and this is not. Every other default is preserved:
  // `xhr: true` (dropped by filterBreadcrumb anyway), `sentry: true`, and
  // fetch/dom/history which are off outside web.
  integrations: (defaults) => [
    ...defaults.filter((integration) => integration.name !== 'Breadcrumbs'),
    Sentry.breadcrumbsIntegration({ console: false }),
  ],
  // Drops http / touch / ui.multiClick / console crumbs and rebuilds the rest
  // from primitives. Runs for JS crumbs only.
  beforeBreadcrumb: filterBreadcrumb,
  // The last JS boundary: scrubs exception values, message, extra and tags,
  // and RE-FILTERS breadcrumbs. The re-filter is required, not belt-and-braces:
  // `deviceContextIntegration` merges the native breadcrumb buffer into the
  // event (concat, sort, slice to maxBreadcrumbs) inside an event processor,
  // which runs BEFORE beforeSend and AFTER beforeBreadcrumb. Native crumbs
  // never pass through beforeBreadcrumb at all.
  beforeSend: scrubEvent,
};

Sentry.init(options);
