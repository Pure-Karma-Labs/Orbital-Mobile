/**
 * @format
 */

import 'react-native-get-random-values';
import 'react-native-gesture-handler';
import './src/sentryInit';
import { AppRegistry } from 'react-native';
import { enableScreens } from 'react-native-screens';
import App from './src/App';
import { name as appName } from './app.json';
import { registerBackgroundPushHandlers } from './src/services/backgroundPush';

enableScreens();

// Android background/killed-state push: channel + background message handler +
// notifee onBackgroundEvent. Must run BEFORE AppRegistry.registerComponent —
// without it, data-only payloads are silently consumed when the app is killed
// or backgrounded and no system notification appears.
//
// This is a CALL, not a side-effect `import './src/services/backgroundPush'`.
// Metro's inlineRequires (on by default, not overridden here) requires named
// imports lazily at first use but runs bare side-effect imports eagerly, ahead
// of enableScreens() — so only an explicit call keeps the shipped order. Jest
// does not apply inlineRequires and therefore cannot catch a conversion back
// to a side-effect import; see the module header in backgroundPush.ts.
registerBackgroundPushHandlers();

AppRegistry.registerComponent(appName, () => App);
