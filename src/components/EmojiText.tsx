/**
 * EmojiText component — renders text with inline OpenMoji emoji and tappable URLs.
 *
 * Parses the children string for Unicode emoji characters and URLs, replaces emoji
 * with inline <Emoji> components rendered from the OpenMoji sprite sheet, and
 * renders URLs as tappable blue underlined links.
 *
 * Uses <View> inside <Text> for inline emoji rendering. The Emoji views
 * are given explicit width/height matching the computed emoji size so
 * they flow inline with text on both iOS and Android.
 *
 * Default emoji size: fontSize * 1.15 (per design spec).
 */

import React, { useMemo } from 'react';
import { Linking, Text, View, type TextStyle, StyleSheet } from 'react-native';
import { findEmojiInText } from '../emoji';
import { Emoji } from './Emoji';
import { useTheme } from '../theme';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface EmojiTextProps {
  /** The text content that may contain emoji */
  children: string;
  /** Text style — fontSize is used to compute inline emoji size */
  style?: TextStyle;
  /** Number of lines before truncation */
  numberOfLines?: number;
  /** Optional testID */
  testID?: string;
  /** Override emoji size multiplier (default: 1.15). Use ~1.6 for composer inputs. */
  emojiScale?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Emoji size multiplier relative to font size (per design spec) */
const EMOJI_SIZE_MULTIPLIER = 1.15;

/** Default font size if none specified in style */
const DEFAULT_FONT_SIZE = 13;

/** Margin around each emoji (per design spec: 0 0.08em) */
const EMOJI_MARGIN_MULTIPLIER = 0.08;

/** Vertical offset for emoji alignment (per design spec: -0.15em) */
const EMOJI_VERTICAL_OFFSET_MULTIPLIER = -0.15;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const EmojiText = React.memo(function EmojiText({
  children,
  style,
  numberOfLines,
  testID,
  emojiScale,
}: EmojiTextProps): React.JSX.Element {
  const theme = useTheme();
  const fontSize = StyleSheet.flatten(style)?.fontSize ?? DEFAULT_FONT_SIZE;
  const emojiSize = Math.round(fontSize * (emojiScale ?? EMOJI_SIZE_MULTIPLIER));
  const emojiMarginH = Math.round(fontSize * EMOJI_MARGIN_MULTIPLIER);
  const emojiVerticalOffset = Math.round(
    fontSize * EMOJI_VERTICAL_OFFSET_MULTIPLIER,
  );

  const segments = useMemo(() => findEmojiInText(children), [children]);

  // If no emoji or links found, render as plain text for performance
  const hasSpecialSegments = segments.some((s) => s.type === 'emoji' || s.type === 'link');
  if (!hasSpecialSegments) {
    return (
      <Text style={style} numberOfLines={numberOfLines} testID={testID}>
        {children}
      </Text>
    );
  }

  return (
    <Text style={style} numberOfLines={numberOfLines} testID={testID}>
      {segments.map((segment, index) => {
        if (segment.type === 'text') {
          return (
            <Text key={index}>{segment.value}</Text>
          );
        }

        if (segment.type === 'link') {
          return (
            <Text
              key={index}
              style={{ color: theme.colors.blue, textDecorationLine: 'underline' }}
              onPress={() => {
                const url = segment.url;
                if (url.startsWith('http://') || url.startsWith('https://')) {
                  Linking.openURL(url).catch(() => {});
                }
              }}
              accessibilityRole="link"
              testID="emoji-text-link"
            >
              {segment.value}
            </Text>
          );
        }

        // Emoji segment — render inline via View-in-Text
        return (
          <View
            key={index}
            style={{
              width: emojiSize + emojiMarginH * 2,
              height: emojiSize,
              marginHorizontal: emojiMarginH,
              top: emojiVerticalOffset,
            }}
          >
            <Emoji
              unified={segment.unified}
              size={emojiSize}
            />
          </View>
        );
      })}
    </Text>
  );
});
