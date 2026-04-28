/**
 * Emoji component — renders a single OpenMoji emoji from a sprite sheet.
 *
 * Uses a clipped View with a positioned Image to show one cell from the
 * OpenMoji sprite sheet. The 32px sheet is used for sizes <= 32, and the
 * 64px sheet for larger sizes.
 *
 * Sprite math:
 *   container: { width: size, height: size, overflow: 'hidden' }
 *   image positioned with left: -(sheetX * cellSize + 1), top: -(sheetY * cellSize + 1)
 *   image dimensions: SHEET_COLUMNS * cellSize
 */

import React from 'react';
import { Image, View, type ImageSourcePropType } from 'react-native';
import { getEmojiData, SHEET_COLUMNS, CELL_SIZE_32, CELL_SIZE_64 } from '../emoji';

// ---------------------------------------------------------------------------
// Sprite sheet sources
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sheet32: ImageSourcePropType = require('emoji-datasource-openmoji/img/sheets/32.webp');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sheet64: ImageSourcePropType = require('emoji-datasource-openmoji/img/sheets/64.webp');

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
  if (!data) {
    return null;
  }

  // Choose the appropriate sheet and cell size
  const useSmallSheet = size <= 32;
  const sheetSource = useSmallSheet ? sheet32 : sheet64;
  const cellSize = useSmallSheet ? CELL_SIZE_32 : CELL_SIZE_64;

  // Calculate the full sheet dimensions
  const sheetDimension = SHEET_COLUMNS * cellSize;

  // Calculate the scale factor to map from cell coordinate space to display space
  const scale = size / (cellSize - 2); // cellSize includes 2px margin; emoji is cellSize - 2

  // Position within the sprite sheet
  const offsetX = -(data.sheet_x * cellSize + 1) * scale;
  const offsetY = -(data.sheet_y * cellSize + 1) * scale;

  return (
    <View
      testID={testID}
      style={{
        width: size,
        height: size,
        overflow: 'hidden',
      }}
    >
      <Image
        source={sheetSource}
        style={{
          width: sheetDimension * scale,
          height: sheetDimension * scale,
          position: 'absolute',
          left: offsetX,
          top: offsetY,
        }}
      />
    </View>
  );
});
