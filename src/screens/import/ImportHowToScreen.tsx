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
import {
  cancelImport,
  importStore,
  pickAndStartParse,
  resumeImportAtLaunch,
} from '../../services/metaImport/importRunner';
import {
  ACCOUNTS_CENTER_LINK_LABEL,
  ACCOUNTS_CENTER_URL,
  CHOOSE_FILES_LABEL,
  HOW_TO_NOTES,
  HOW_TO_STEPS,
  HOW_TO_TITLE,
  PICK_FAILURE_COPY,
  SOURCE_CHOICE_BODY,
  SOURCE_CHOICE_CANCEL_LABEL,
  SOURCE_CHOICE_TITLE,
  SOURCE_LABEL,
  describeAllowances,
  describeHowToIntro,
  describeImportOtherCaption,
  describeIntoCaption,
} from './importCopy';

import type { SettingsStackParamList } from '../../navigation/types';
import type { ImportSource } from '../../services/metaImport/types';

/** The two platforms, in the order the chooser lists them. */
const SOURCES: readonly ImportSource[] = ['facebook', 'instagram'];

type HowToRoute = RouteProp<SettingsStackParamList, 'ImportHowTo'>;
type HowToNavigation = NativeStackNavigationProp<SettingsStackParamList, 'ImportHowTo'>;

export function ImportHowToScreen(): React.JSX.Element {
  const theme = useTheme();
  const navigation = useNavigation<HowToNavigation>();
  const route = useRoute<HowToRoute>();
  const { conversationId, preferredSource } = route.params;

  const orbitName = useAppStore((s) => s.conversations[conversationId]?.name ?? null);
  const availability = useImportAvailability(conversationId);
  const phase = useStore(importStore, (s) => s.phase);
  const parseProgress = useStore(importStore, (s) => s.parseProgress);

  const [error, setError] = useState<string | null>(null);

  /**
   * One pick at a time — as STATE, not a ref (#996 §7.3).
   *
   * The wait now spans the OS picker, the chooser dialog and the whole parse,
   * so the button has to show it: a ref would guard the second tap while
   * leaving the button looking idle for as long as the member takes to answer
   * "which posts first?".
   */
  const [picking, setPicking] = useState(false);
  const pickInFlight = useRef(false);
  const mounted = useRef(true);

  /**
   * The chooser's settle function while its Alert is up.
   *
   * It lives in a ref so UNMOUNT can settle it: the runner is awaiting that
   * promise, and a screen that goes away with the dialog still presented would
   * otherwise leave the pick hanging forever. It also makes the settle
   * single-shot, so a late tap on a dialog that outlived the screen (Android)
   * is a no-op rather than a second answer.
   */
  const pendingChoice = useRef<((source: ImportSource | null) => void) | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const settle = pendingChoice.current;
      pendingChoice.current = null;
      settle?.(null);
    };
  }, []);

  const handleOpenAccountsCenter = useCallback((source: ImportSource) => {
    // Fire and forget: a device with no browser is not worth an alert, and
    // every step is written out above the link.
    Linking.openURL(ACCOUNTS_CENTER_URL[source]).catch(() => {});
  }, []);

  /**
   * Posts left in one source's bucket, or null when the allowance is unknown.
   *
   * Unknown is NOT zero: it means the probe hasn't answered, and treating it
   * as exhausted would silently pick the other platform for the member.
   */
  const remainingPostsFor = useCallback(
    (source: ImportSource): number | null => {
      const allowance = availability.allowances?.[source];
      if (allowance === undefined) return null;
      return Math.max(0, allowance.postsLimit - allowance.postsUsed);
    },
    [availability.allowances],
  );

  /**
   * "Which posts first?" — asked ONLY when the archive holds both sources
   * (#996 §7.3). The runner calls this during the parse and awaits it.
   *
   * Two shortcuts answer without a dialog:
   *  - `preferredSource`, set by the "import the other one" offers, which is
   *    the member having already answered this question;
   *  - exactly one source out of posts, where the dialog would offer a choice
   *    that cannot be taken.
   */
  const chooseSource = useCallback((): Promise<ImportSource | null> => {
    if (preferredSource !== undefined) return Promise.resolve(preferredSource);

    const facebookLeft = remainingPostsFor('facebook');
    const instagramLeft = remainingPostsFor('instagram');
    if (facebookLeft !== null && instagramLeft !== null) {
      if (facebookLeft === 0 && instagramLeft > 0) return Promise.resolve('instagram');
      if (instagramLeft === 0 && facebookLeft > 0) return Promise.resolve('facebook');
    }

    return new Promise<ImportSource | null>((resolve) => {
      let settled = false;
      const settle = (source: ImportSource | null): void => {
        if (settled) return;
        settled = true;
        if (pendingChoice.current === settle) pendingChoice.current = null;
        resolve(source);
      };
      pendingChoice.current = settle;

      // Cancel FIRST in the array: Android assigns its three slots from the
      // END (positive, negative, neutral), so this order puts Instagram on
      // the positive button and leaves Cancel neutral. iOS keeps the written
      // order and pins the cancel style to the bottom either way. Tests
      // therefore match buttons by TEXT, never by index.
      Alert.alert(
        SOURCE_CHOICE_TITLE,
        SOURCE_CHOICE_BODY,
        [
          { text: SOURCE_CHOICE_CANCEL_LABEL, style: 'cancel', onPress: () => settle(null) },
          { text: SOURCE_LABEL.facebook, onPress: () => settle('facebook') },
          { text: SOURCE_LABEL.instagram, onPress: () => settle('instagram') },
        ],
        // `onDismiss` is Android-only (a back-press or an outside tap); iOS
        // always has the Cancel button, so both platforms can always answer.
        { cancelable: true, onDismiss: () => settle(null) },
      );
    });
  }, [preferredSource, remainingPostsFor]);

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
    setPicking(true);
    setError(null);

    (async () => {
      try {
        const result = await pickAndStartParse({ conversationId, chooseSource });
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
        if (mounted.current) setPicking(false);
      }
    })();
  }, [conversationId, chooseSource, navigation, handleRefused]);

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

  // BOTH buckets: the allowance is per source (#996/B#352), and a member who
  // has used one up still has the other.
  const facebookLeft = remainingPostsFor('facebook');
  const instagramLeft = remainingPostsFor('instagram');

  return (
    <SafeAreaView style={containerStyle} edges={['top']} testID="import-how-to-screen">
      <Header title={HOW_TO_TITLE} onBack={() => navigation.goBack()} />
      {phase === 'parsing' ? (
        <ImportParseView progress={parseProgress} onCancel={handleCancelParse} />
      ) : (
        <ScrollView contentContainerStyle={contentStyle}>
          <View style={{ paddingTop: theme.spacing.md }}>
            <ErrorBanner message={error} testID="import-how-to-error" />
          </View>

          {/*
            EmojiText, not Text: the intro INTERPOLATES the orbit's name, and
            a name with an emoji in it would render the system glyph here
            while every other surface shows OpenMoji.
          */}
          <EmojiText style={bodyStyle} testID="import-how-to-intro">
            {describeHowToIntro(orbitName)}
          </EmojiText>
          <EmojiText style={captionStyle} testID="import-how-to-orbit">
            {describeIntoCaption(orbitName)}
          </EmojiText>
          {preferredSource !== undefined && (
            <Text style={captionStyle} testID="import-how-to-preferred">
              {describeImportOtherCaption(preferredSource)}
            </Text>
          )}
          {facebookLeft !== null && instagramLeft !== null && (
            <Text style={captionStyle} testID="import-how-to-allowance">
              {describeAllowances(facebookLeft, instagramLeft)}
            </Text>
          )}

          <SectionHeader label="Export your posts" />
          {HOW_TO_STEPS.map((step, index) => (
            <View key={step} style={stepRowStyle}>
              <Text style={stepNumberStyle}>{`${index + 1}.`}</Text>
              <Text style={stepTextStyle}>{step}</Text>
            </View>
          ))}

          {/*
            One link per platform: an Instagram-only member cannot reach their
            download through the Facebook host, and vice versa.
          */}
          {SOURCES.map((source) => (
            <TouchableOpacity
              key={source}
              style={linkRowStyle}
              onPress={() => handleOpenAccountsCenter(source)}
              accessibilityRole="link"
              accessibilityLabel={ACCOUNTS_CENTER_LINK_LABEL[source]}
              testID={`import-accounts-center-link-${source}`}
            >
              <Text style={linkStyle}>{ACCOUNTS_CENTER_LINK_LABEL[source]}</Text>
            </TouchableOpacity>
          ))}

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
              loading={picking}
              testID="import-choose-files"
            />
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

export default ImportHowToScreen;
