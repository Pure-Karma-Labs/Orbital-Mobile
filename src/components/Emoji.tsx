/**
 * Emoji component — renders a single OpenMoji emoji from a per-emoji asset.
 *
 * Each emoji is a pre-rendered 128px WebP file loaded via the generated
 * emojiAssetMap. This avoids the memory-pressure problem of the previous
 * sprite-sheet approach (decoding the full 18-67 MB sheet per visible emoji).
 */

import React from 'react';
import { Image } from 'react-native';
import { getEmojiData } from '../emoji';
import { emojiAssetMap } from '../emoji/assetMap';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface EmojiProps {
  /** Unified hex code, e.g. "1F600" for grinning face */
  unified: string;
  /** Display size in logical pixels (default 20) */
  size?: number;
  /** Optional testID for testing */
  testID?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const Emoji = React.memo(function Emoji({
  unified,
  size = 20,
  testID,
}: EmojiProps): React.JSX.Element | null {
  const data = getEmojiData(unified);
  const source = data ? emojiAssetMap[data.unified] : undefined;

  if (!source) {
    return null;
  }

  return (
    <Image
      source={source}
      resizeMode="contain"
      style={{ width: size, height: size }}
      testID={testID}
    />
  );
});
