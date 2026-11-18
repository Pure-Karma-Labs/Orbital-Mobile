/**
 * How an IMPORTED THREAD marks itself, outside the import flow (#927 §8).
 *
 * Two presentational pieces, each used once:
 *
 * - {@link ImportedIndicator} — the glyph alone, for a list row. The row's own
 *   accessibility label carries "imported from Facebook" in words, so the
 *   glyph is hidden from screen readers rather than read twice.
 * - {@link ImportedCaption} — glyph plus one line, under the author row on the
 *   thread detail screen.
 *
 * Neither is touchable, and neither takes an `onPress`: there is nowhere to go
 * from "this is an import". A tap target here would also sit on top of the
 * row's own, which is the whole surface.
 *
 * They live under `screens/import/` with the copy they render, rather than in
 * `components/`, because the glyph and the wording are this flow's brand
 * decisions — one neutral tray, no Meta logo or colour, for either source.
 */

import React from 'react';
import { Text, View, type TextStyle, type ViewStyle } from 'react-native';
import { useTheme } from '../../theme';
import { Emoji } from '../../components/Emoji';
import { IMPORT_GLYPH, describeImportedLabel } from './importCopy';

import type { ImportSource } from '../../services/metaImport/types';

/** Glyph size relative to the text beside it — the EmojiText ratio. */
const GLYPH_SCALE = 1.15;

export interface ImportedIndicatorProps {
  /** Glyph size in points. Defaults to the caption's own 13pt. */
  size?: number;
}

/**
 * The bare glyph, for a list row's right slot.
 *
 * Hidden from accessibility on purpose: an `Image` with no label is announced
 * as nothing useful, and the row above it already says "imported from
 * Facebook" in words.
 */
export function ImportedIndicator({ size }: ImportedIndicatorProps): React.JSX.Element {
  const theme = useTheme();
  const glyphSize = size ?? Math.round(theme.typography.fontSize.sm * GLYPH_SCALE);

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="thread-imported-indicator"
    >
      <Emoji unified={IMPORT_GLYPH} size={glyphSize} />
    </View>
  );
}

export interface ImportedCaptionProps {
  /** `null` when the envelope was absent or did not open. */
  source: ImportSource | null;
  /** Positioning only — the parent owns where this line sits. */
  style?: ViewStyle;
}

/**
 * "📥 Imported from Facebook" — the thread detail caption.
 *
 * One accessible element: the glyph and the words are a single fact, and the
 * label is the words alone, so a screen reader never has to describe a tray.
 */
export function ImportedCaption({ source, style }: ImportedCaptionProps): React.JSX.Element {
  const theme = useTheme();
  const label = describeImportedLabel(source);
  const fontSize = theme.typography.fontSize.sm;

  const rowStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    ...style,
  };

  const textStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize,
    color: theme.colors.textTertiary,
    marginLeft: theme.spacing.xs,
    flexShrink: 1,
  };

  return (
    <View style={rowStyle} accessible accessibilityLabel={label} testID="thread-imported-caption">
      <Emoji unified={IMPORT_GLYPH} size={Math.round(fontSize * GLYPH_SCALE)} />
      <Text style={textStyle} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}
