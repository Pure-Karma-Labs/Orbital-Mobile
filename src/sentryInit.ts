import * as Sentry from '@sentry/react-native';
import { SENTRY_DSN } from './config/env';
import { filterBreadcrumb, scrubEvent } from './services/telemetryScrub';

// Must be imported in index.js BEFORE `./src/App` — App.tsx calls Sentry.wrap()
// at module scope, and the SDK requires init to run before wrap or the
// app-start span is lost. Init always runs (disabled without a DSN) so dev
// builds don't warn "`Sentry.wrap` was called before `Sentry.init`".
const options: Sentry.ReactNativeOptions = {
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
  // iOS ONLY, and it defaults ON: sentry-cocoa swizzles NSURLSession, so it
  // sees RN fetch and RNFS traffic. Those URLs carry orbit / thread / media
  // UUIDs and `setUser({ id })` makes them attributable. The JS hooks below
  // cannot cover this: `initNativeSdk` (dist/js/wrapper.js) forwards our
  // options to native through a DENY-list rest-destructure that strips
  // `beforeSend`/`beforeBreadcrumb`, so a HARD NATIVE CRASH report is
  // assembled by cocoa with no JS boundary in the path. That same forward is
  // how this key reaches native at all, and the flag is the only defence
  // there.
  //
  // The RN typing marks it OPTIONAL, so nothing in the type system notices our
  // DELETING it. Section 15 of scripts/check-security-invariants.mjs pins it as
  // source text and __tests__/sentryInit.test.ts pins the value passed to
  // init(); those two are the whole guard that it is present AND `false`.
  // Neither may be deleted. The reverse direction IS covered since #877: with
  // the options literal typed as a plain `ReactNativeOptions`, an UPSTREAM
  // removal of `enableNetworkBreadcrumbs?` fails tsc as an excess property
  // here, so it breaks the build instead of becoming a silent no-op.
  //
  // Android has a SEPARATE option, `enableNetworkEventBreadcrumbs`, which
  // records network-connectivity-state crumbs (available/lost, WiFi <->
  // cellular, VPN) and no request URLs — nothing content-bearing, so it is
  // deliberately left at its default and not pinned.
  //
  // Whether cocoa honours this is unverifiable from JS — see
  // docs/ios-dependency-delivery.md for the re-check triggers on an SDK bump
  // and for the file/line anchors, which carry the version they were read at.
  enableNetworkBreadcrumbs: false,
  // Replace the default Breadcrumbs integration (name: 'Breadcrumbs') with one
  // that has console and xhr capture off at the SOURCE. Console crumbs would
  // otherwise record the raw arguments of every console.warn/error (our
  // content-bearing logs are `__DEV__`-guarded, but that guard is a convention
  // and this is not); xhr crumbs carry request URLs and were only ever dropped
  // by filterBreadcrumb — which stays as the defence for native-merged http
  // crumbs. `sentry: true` is preserved; fetch/dom/history are off outside web.
  integrations: (defaults) => [
    ...defaults.filter((integration) => integration.name !== 'Breadcrumbs'),
    Sentry.breadcrumbsIntegration({ console: false, xhr: false }),
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
