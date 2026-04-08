/**
 * Minimal error recovery screen rendered when bootstrap() fails.
 *
 * Intentionally does NOT use the theme system — it must render before the
 * app has fully initialized.
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  AppRegistry,
} from 'react-native';
import { bootstrap } from '../bootstrap';
import { clearAll } from '../services/secure-storage';
import App from '../App';
import { name as appName } from '../../app.json';

type Status = 'idle' | 'retrying' | 'resetting';

export default function BootstrapErrorScreen(): React.JSX.Element {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);

  async function handleRetry(): Promise<void> {
    setStatus('retrying');
    setError(null);
    try {
      await bootstrap();
      AppRegistry.registerComponent(appName, () => App);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
      setStatus('idle');
    }
  }

  async function handleReset(): Promise<void> {
    setStatus('resetting');
    setError(null);
    try {
      await clearAll();
      await bootstrap();
      AppRegistry.registerComponent(appName, () => App);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
      setStatus('idle');
    }
  }

  const busy = status !== 'idle';

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Unable to initialize secure storage</Text>
      <Text style={styles.body}>
        Orbital could not access the device keychain. Please try again, or
        reset the app to start fresh.
      </Text>
      {error !== null && <Text style={styles.errorDetail}>{error}</Text>}
      <TouchableOpacity
        style={[styles.button, busy && styles.buttonDisabled]}
        onPress={handleRetry}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel="Retry initialization"
      >
        {status === 'retrying' ? (
          <ActivityIndicator color="#ffffff" />
        ) : (
          <Text style={styles.buttonText}>Retry</Text>
        )}
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.button, styles.buttonDestructive, busy && styles.buttonDisabled]}
        onPress={handleReset}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel="Reset app and retry"
      >
        {status === 'resetting' ? (
          <ActivityIndicator color="#ffffff" />
        ) : (
          <Text style={styles.buttonText}>Reset App</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#0f0f0f',
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    color: '#ffffff',
    textAlign: 'center',
    marginBottom: 12,
  },
  body: {
    fontSize: 14,
    color: '#aaaaaa',
    textAlign: 'center',
    marginBottom: 8,
    lineHeight: 20,
  },
  errorDetail: {
    fontSize: 12,
    color: '#ff6b6b',
    textAlign: 'center',
    marginBottom: 24,
    fontFamily: 'monospace',
  },
  button: {
    backgroundColor: '#4a6fa5',
    paddingVertical: 12,
    paddingHorizontal: 32,
    borderRadius: 6,
    marginTop: 16,
    minWidth: 160,
    alignItems: 'center',
  },
  buttonDestructive: {
    backgroundColor: '#8b3a3a',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
});
