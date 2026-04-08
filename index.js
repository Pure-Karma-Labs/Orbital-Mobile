/**
 * @format
 */

import { AppRegistry } from 'react-native';
import { bootstrap } from './src/bootstrap';
import App from './src/App';
import { name as appName } from './app.json';

bootstrap()
  .then(() => {
    AppRegistry.registerComponent(appName, () => App);
  })
  .catch((error) => {
    console.error('[Bootstrap] Failed:', error);
    // Register error recovery screen — renders without the theme system so
    // it works before MMKV/Zustand are initialized.
    const BootstrapErrorScreen =
      require('./src/screens/BootstrapErrorScreen').default;
    AppRegistry.registerComponent(appName, () => BootstrapErrorScreen);
  });
