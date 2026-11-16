/**
 * One screen for the whole run (#928 §3.1) — PLACEHOLDER.
 *
 * Brief 2b replaces this body with the `deriveImportView` switch into the
 * preflight, run, paused and summary views. It exists now so the route is
 * registered, reachable and navigable, and so Brief 2a's Settings section can
 * be exercised end to end.
 *
 * It is a single screen rather than a preflight→progress→summary `replace`
 * chain because the store changes phase on its OWN: a launch-time auto-resume,
 * a pause and the settle all move it with no member action to hang a
 * navigation on.
 */

import React from 'react';
import { ScrollView, Text, type TextStyle, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useStore } from 'zustand';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../../theme';
import { Header } from '../../components/Header';
import { importViewStore } from './runnerContract';
import { CHECKING_COPY, NO_IMPORT_COPY, deriveImportView, describeStripLine } from './importCopy';

export function ImportStatusScreen(): React.JSX.Element {
  const theme = useTheme();
  const navigation = useNavigation();
  const state = useStore(importViewStore);
  const view = deriveImportView(state);

  const containerStyle: ViewStyle = {
    flex: 1,
    backgroundColor: theme.colors.background,
  };

  const bodyStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
    padding: theme.spacing.base,
  };

  const line =
    view.kind === 'checking' ? CHECKING_COPY : (describeStripLine(view) ?? NO_IMPORT_COPY);

  return (
    <SafeAreaView style={containerStyle} edges={['top']} testID="import-status-screen">
      <Header title="Import" onBack={() => navigation.goBack()} />
      <ScrollView>
        <Text style={bodyStyle}>{line}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

export default ImportStatusScreen;
