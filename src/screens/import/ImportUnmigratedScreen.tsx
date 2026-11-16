/**
 * "What didn't migrate", grouped by reason (#928 §4.5) — PLACEHOLDER.
 *
 * Brief 2b replaces this body with the mixed-row `FlatList` (group header,
 * row, file issue, "…and N more") and the Share action. It exists now so the
 * route is registered and reachable.
 *
 * The shape 2b must keep: the list loads ONCE on mount through
 * `getImportUnmigratedItems()` into `useState`, capped at 1,000 rows plus
 * group counts, so the JS thread never materialises more rows than the screen
 * displays — and so dismissing the summary cannot empty a list the member is
 * reading.
 */

import React from 'react';
import { ScrollView, Text, type TextStyle, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../../theme';
import { Header } from '../../components/Header';
import { SEE_UNMIGRATED_LABEL } from './importCopy';

export function ImportUnmigratedScreen(): React.JSX.Element {
  const theme = useTheme();
  const navigation = useNavigation();

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

  return (
    <SafeAreaView style={containerStyle} edges={['top']} testID="import-unmigrated-screen">
      <Header title={SEE_UNMIGRATED_LABEL} onBack={() => navigation.goBack()} />
      <ScrollView>
        <Text style={bodyStyle}>{SEE_UNMIGRATED_LABEL}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

export default ImportUnmigratedScreen;
