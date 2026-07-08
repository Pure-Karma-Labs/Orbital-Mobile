import * as Sentry from '@sentry/react-native';
import { SENTRY_DSN } from './config/env';

// Must be imported in index.js BEFORE `./src/App` — App.tsx calls Sentry.wrap()
// at module scope, and the SDK requires init to run before wrap or the
// app-start span is lost. Init always runs (disabled without a DSN) so dev
// builds don't warn "`Sentry.wrap` was called before `Sentry.init`".
Sentry.init({
  dsn: SENTRY_DSN,
  enabled: Boolean(SENTRY_DSN),
  environment: __DEV__ ? 'development' : 'production',
  sendDefaultPii: false,
});
