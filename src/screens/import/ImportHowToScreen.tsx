/**
 * How to export your posts from Meta, and the file picker (#928 §3.2, §4.1).
 *
 * ## The orbit comes from the ROUTE, never from `activeConversationId`
 *
 * A member can switch the active orbit from another tab while this screen is
 * open. The import must still go into the orbit they started from, so every
 * read of the orbit here goes through `route.params.conversationId`.
 *
 * ## `Linking.openURL`, never a WebView
 *
 * "Open Accounts Center" hands the URL to the system browser. A WebView would
 * mean hosting a Meta login inside Orbital — exactly the thing the intro copy
 * promises we do not do — and a new native dependency for one link.
 *
 * ## The parse is rendered INLINE
 *
 * `pickAndStartParse` resolves only once the whole archive has been read, so
 * this screen shows the parse itself. Any failure therefore lands on the
 * screen that started the pick, where the member can simply try again.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Linking,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useStore } from 'zustand';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../../theme';
import { useAppStore } from '../../stores/useAppStore';
import { Button } from '../../components/Button';
import { EmojiText } from '../../components/EmojiText';
import { ErrorBanner } from '../../components/ErrorBanner';
import { Header } from '../../components/Header';
import { SectionHeader } from '../settings/SectionHeader';
import { ImportParseView } from './ImportParseView';
import { useImportAvailability } from './useImportAvailability';
import { importViewStore, pickAndStartParse } from './runnerContract';
import { cancelImport, resumeImportAtLaunch } from '../../services/metaImport/importRunner';
import {
  ACCOUNTS_CENTER_LINK_LABEL,
  ACCOUNTS_CENTER_URL,
  CHOOSE_FILES_LABEL,
  HOW_TO_NOTES,
  PICK_FAILURE_COPY,
  describeAllowance,
  describeHowToIntro,
  describeHowToSteps,
  describeIntoCaption,
  describeStartRow,
} from './importCopy';

import type { SettingsStackParamList } from '../../navigation/types';

type HowToRoute = RouteProp<SettingsStackParamList, 'ImportHowTo'>;
type HowToNavigation = NativeStackNavigationProp<SettingsStackParamList, 'ImportHowTo'>;

export function ImportHowToScreen(): React.JSX.Element {
  const theme = useTheme();
  const navigation = useNavigation<HowToNavigation>();
  const route = useRoute<HowToRoute>();
  const { source, conversationId } = route.params;

  const orbitName = useAppStore((s) => s.conversations[conversationId]?.name ?? null);
  const availability = useImportAvailability(conversationId);
  const phase = useStore(importViewStore, (s) => s.phase);
  const parseProgress = useStore(importViewStore, (s) => s.parseProgress);

  const [error, setError] = useState<string | null>(null);

  // One pick at a time. `pickAndStartParse` already refuses a second job, but
  // a double tap would answer `cancelled` for the second one and read as a
  // picker that silently closed.
  const pickInFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const handleOpenAccountsCenter = useCallback(() => {
    // Fire and forget: a device with no browser is not worth an alert, and
    // every step is written out above the link.
    Linking.openURL(ACCOUNTS_CENTER_URL[source]).catch(() => {});
  }, [source]);

  const handleRefused = useCallback(
    async (jobConversationId: string) => {
      // Re-hydrate first: the store can read `idle` while SQLite holds an
      // active job (a launch whose rebuild failed, or a job this process has
      // not adopted yet). This goes through the runner's pre-run latch.
      await resumeImportAtLaunch();
      if (!mounted.current) return;

      if (jobConversationId === conversationId) {
        navigation.replace('ImportStatus');
        return;
      }

      // The ONE place an orbit name is shown without EmojiText: a native
      // alert cannot host a custom renderer.
      const name = useAppStore.getState().conversations[jobConversationId]?.name;
      Alert.alert(
        'An import is already running',
        `An import is already running in ${name ?? "an orbit you've left"}. ` +
          'Orbital imports one archive at a time.',
        [
          { text: 'Not now', style: 'cancel' },
          { text: 'View', onPress: () => navigation.replace('ImportStatus') },
        ],
      );
    },
    [conversationId, navigation],
  );

  const handleChooseFiles = useCallback(() => {
    if (pickInFlight.current) return;
    pickInFlight.current = true;
    setError(null);

    (async () => {
      try {
        const result = await pickAndStartParse({ conversationId, source });
        if (!mounted.current) return;
        switch (result.kind) {
          case 'preflight':
            navigation.replace('ImportStatus');
            break;
          case 'cancelled':
            // The member closed the picker. Nothing to say.
            break;
          case 'failed':
            setError(PICK_FAILURE_COPY[result.reason]);
            break;
          case 'refused':
            await handleRefused(result.conversationId);
            break;
        }
      } catch {
        // `pickAndStartParse` types its refusals rather than throwing, so this
        // is the unexpected tail (a rejected re-hydration, say). It is shown,
        // never logged: this directory is held to a zero-log bar.
        if (mounted.current) setError(PICK_FAILURE_COPY.other);
      } finally {
        pickInFlight.current = false;
      }
    })();
  }, [conversationId, source, navigation, handleRefused]);

  const handleCancelParse = useCallback(() => {
    cancelImport();
  }, []);

  const containerStyle: ViewStyle = {
    flex: 1,
    backgroundColor: theme.colors.background,
  };

  const contentStyle: ViewStyle = {
    paddingHorizontal: theme.spacing.base,
    paddingBottom: theme.spacing.xl,
  };

  const bodyStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
    lineHeight: theme.typography.fontSize.base * theme.typography.lineHeight.normal,
    marginTop: theme.spacing.md,
  };

  const captionStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textTertiary,
    marginTop: theme.spacing.sm,
  };

  const stepRowStyle: ViewStyle = {
    flexDirection: 'row',
    marginTop: theme.spacing.md,
  };

  const stepNumberStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.mono,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textTertiary,
    width: 24,
  };

  const stepTextStyle: TextStyle = {
    flex: 1,
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
    lineHeight: theme.typography.fontSize.base * theme.typography.lineHeight.normal,
  };

  const linkStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.blue,
  };

  const linkRowStyle: ViewStyle = {
    minHeight: 44,
    justifyContent: 'center',
    marginTop: theme.spacing.sm,
  };

  const buttonStyle: ViewStyle = { marginTop: theme.spacing.lg };

  const allowance = availability.allowance;
  const remainingPosts =
    allowance === null ? null : Math.max(0, allowance.postsLimit - allowance.postsUsed);

  return (
    <SafeAreaView style={containerStyle} edges={['top']} testID="import-how-to-screen">
      <Header title={describeStartRow(source)} onBack={() => navigation.goBack()} />
      {phase === 'parsing' ? (
        <ImportParseView progress={parseProgress} onCancel={handleCancelParse} />
      ) : (
        <ScrollView contentContainerStyle={contentStyle}>
          <View style={{ paddingTop: theme.spacing.md }}>
            <ErrorBanner message={error} testID="import-how-to-error" />
          </View>

          <Text style={bodyStyle}>{describeHowToIntro(source, orbitName)}</Text>
          <EmojiText style={captionStyle} testID="import-how-to-orbit">
            {describeIntoCaption(orbitName)}
          </EmojiText>
          {remainingPosts !== null && (
            <Text style={captionStyle} testID="import-how-to-allowance">
              {describeAllowance(remainingPosts)}
            </Text>
          )}

          <SectionHeader label="Export your posts" />
          {describeHowToSteps(source).map((step, index) => (
            <View key={step} style={stepRowStyle}>
              <Text style={stepNumberStyle}>{`${index + 1}.`}</Text>
              <Text style={stepTextStyle}>{step}</Text>
            </View>
          ))}

          <TouchableOpacity
            style={linkRowStyle}
            onPress={handleOpenAccountsCenter}
            accessibilityRole="link"
            accessibilityLabel={ACCOUNTS_CENTER_LINK_LABEL}
            testID="import-accounts-center-link"
          >
            <Text style={linkStyle}>{ACCOUNTS_CENTER_LINK_LABEL}</Text>
          </TouchableOpacity>

          <SectionHeader label="Before you start" />
          {HOW_TO_NOTES.map((note) => (
            <Text key={note} style={bodyStyle}>
              {note}
            </Text>
          ))}

          <View style={buttonStyle}>
            <Button
              title={CHOOSE_FILES_LABEL}
              onPress={handleChooseFiles}
              testID="import-choose-files"
            />
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

export default ImportHowToScreen;
