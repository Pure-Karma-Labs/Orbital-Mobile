import * as Sentry from '@sentry/react-native';
import { filterBreadcrumb, scrubEvent } from '../src/services/telemetryScrub';
import '../src/sentryInit';

/**
 * src/sentryInit.ts runs Sentry.init() at import time. The @sentry/react-native
 * automock swallows the call, so without this test the privacy-relevant options
 * could be reverted silently (#743: enableMemoryIntrospection reads process
 * memory — SQLCipher key, identity keys, plaintext — into native crash reports.
 * #746: the breadcrumb/scrub hooks and the native network-breadcrumb flag).
 *
 * `scripts/check-security-invariants.mjs` section 15 pins the same options as
 * source text, which is the only check that survives a deleted test file.
 */
describe('sentryInit', () => {
  const initOptions = () =>
    (Sentry.init as unknown as jest.Mock).mock.calls[0][0] as Record<string, unknown>;

  it('initializes Sentry with PII and memory introspection disabled', () => {
    expect(Sentry.init).toHaveBeenCalledTimes(1);
    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        sendDefaultPii: false,
        enableMemoryIntrospection: false,
      }),
    );
  });

  it('pins the breadcrumb budget and disables native network breadcrumbs', () => {
    // enableNetworkBreadcrumbs is a sentry-cocoa option with no RN typing; it
    // reaches native through initNativeSdk's deny-list rest-destructure and is
    // the ONLY defence for hard native crash reports, because that same
    // destructure strips beforeSend/beforeBreadcrumb. Only the on-device check
    // can prove cocoa honoured it — this asserts we asked.
    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        maxBreadcrumbs: 100,
        enableNetworkBreadcrumbs: false,
      }),
    );
  });

  it('wires the scrub hooks to the exported functions, not to copies', () => {
    expect(initOptions().beforeBreadcrumb).toBe(filterBreadcrumb);
    expect(initOptions().beforeSend).toBe(scrubEvent);
  });

  it('swaps the default Breadcrumbs integration for one with console capture off', () => {
    const integrations = initOptions().integrations as (
      defaults: { name: string }[],
    ) => { name: string }[];
    expect(typeof integrations).toBe('function');

    const defaults = [
      { name: 'ReactNativeErrorHandlers' },
      { name: 'Breadcrumbs' },
      { name: 'DeviceContext' },
    ];
    const result = integrations(defaults);

    // Exactly one Breadcrumbs integration, and it is ours.
    expect(result.filter((i) => i.name === 'Breadcrumbs')).toHaveLength(1);
    expect(result.map((i) => i.name)).toEqual([
      'ReactNativeErrorHandlers',
      'DeviceContext',
      'Breadcrumbs',
    ]);
    // Every other default survives the swap.
    expect(Sentry.breadcrumbsIntegration).toHaveBeenCalledWith({ console: false });
  });
});
