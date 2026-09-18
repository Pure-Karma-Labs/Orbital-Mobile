import * as Sentry from '@sentry/react-native';
import '../src/sentryInit';

/**
 * src/sentryInit.ts runs Sentry.init() at import time. The @sentry/react-native
 * automock swallows the call, so without this test the privacy-relevant options
 * could be reverted silently (#743: enableMemoryIntrospection reads process
 * memory — SQLCipher key, identity keys, plaintext — into native crash reports).
 */
describe('sentryInit', () => {
  it('initializes Sentry with PII and memory introspection disabled', () => {
    expect(Sentry.init).toHaveBeenCalledTimes(1);
    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        sendDefaultPii: false,
        enableMemoryIntrospection: false,
      }),
    );
  });
});
