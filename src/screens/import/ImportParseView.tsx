/**
 * "Reading your export…" — the parse view (#928 §4.2).
 *
 * Flat in `src/screens/import/` rather than in a `views/` subfolder: no other
 * screen folder in this app has one.
 *
 * It is rendered INLINE by the how-to screen as well as by the status screen,
 * so a parse that fails lands on the screen that started the pick instead of
 * bouncing the member somewhere they did not ask to be. Cancel needs no
 * confirmation — nothing has been uploaded yet.
 */

import React from 'react';
import { Text, View, type TextStyle, type ViewStyle } from 'react-native';
import { useTheme } from '../../theme';
import { Button } from '../../components/Button';
import { OrbitalSpinner } from '../../components/OrbitalSpinner';
import { PARSE_CANCEL_LABEL, PARSING_TITLE, describeParseProgress } from './importCopy';

import type { ParseProgress } from '../../services/metaImport/types';

export interface ImportParseViewProps {
  /** `null` until the parser's first progress callback. */
  progress: ParseProgress | null;
  onCancel: () => void;
  testID?: string;
}

export function ImportParseView({
  progress,
  onCancel,
  testID = 'import-parse-view',
}: ImportParseViewProps): React.JSX.Element {
  const theme = useTheme();

  const containerStyle: ViewStyle = {
    alignItems: 'center',
    paddingHorizontal: theme.spacing.base,
    paddingVertical: theme.spacing.xl,
  };

  const titleStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
    marginTop: theme.spacing.base,
    textAlign: 'center',
  };

  const lineStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textSecondary,
    marginTop: theme.spacing.xs,
    textAlign: 'center',
  };

  const buttonStyle: ViewStyle = {
    marginTop: theme.spacing.lg,
    alignSelf: 'stretch',
  };

  const lines = describeParseProgress(progress?.postsSeen ?? 0, progress?.mediaPeeked ?? 0);

  return (
    <View style={containerStyle} testID={testID}>
      <OrbitalSpinner size={32} />
      <Text style={titleStyle} accessibilityRole="header">
        {PARSING_TITLE}
      </Text>
      {lines.map((line) => (
        <Text key={line} style={lineStyle}>
          {line}
        </Text>
      ))}
      <View style={buttonStyle}>
        <Button
          title={PARSE_CANCEL_LABEL}
          variant="secondary"
          onPress={onCancel}
          testID="import-parse-cancel"
        />
      </View>
    </View>
  );
}
