/**
 * @format
 */

import 'react-native-gesture-handler';
import { AppRegistry } from 'react-native';
import { enableScreens } from 'react-native-screens';
import { bootstrap } from './src/bootstrap';
import App from './src/App';
import { name as appName } from './app.json';

enableScreens();

// Register the app immediately so the UI renders while bootstrap runs.
// Bootstrap initializes storage, database, and crypto — if it fails,
// the app still shows (auth gate will show login screen).
AppRegistry.registerComponent(appName, () => App);

bootstrap().catch((error) => {
  console.error('[Bootstrap] Failed:', error);
});
