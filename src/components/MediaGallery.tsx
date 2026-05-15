/**
 * MediaGallery — Adaptive grid layout for media items in thread/reply bubbles.
 *
 * Layout adapts based on media count:
 * - 1 photo:  Full width, aspect ratio preserved (capped 150-300px height)
 * - 2 photos: Side by side, square (1:1)
 * - 3 photos: L-shape (60% left, 40% right with 2 stacked)
 * - 4+ photos: 2x2 grid; 4th cell shows "+N" overlay if count > 4
 *
 * Each cell renders a <MediaItemView> component.
 */

import React from 'react';
import { Text, View, type TextStyle, type ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import type { Theme } from '../theme/tokens';
import type { MediaItem } from '../types/store';
import { MediaItemView } from './MediaItemView';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface MediaGalleryProps {
  mediaItems: MediaItem[];
  maxWidth: number;
  onItemPress: (index: number) => void;
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

interface CellLayout {
  mediaIndex: number;
  width: number;
  height: number;
}

interface GalleryLayout {
  rows: CellLayout[][];
  totalHeight: number;
}

function getGalleryLayout(
  count: number,
  maxWidth: number,
  gap: number,
  firstItem: MediaItem | undefined,
): GalleryLayout {
  if (count === 0) {
    return { rows: [], totalHeight: 0 };
  }

  if (count === 1) {
    // Single photo — preserve aspect ratio, capped height
    let height: number;
    if (firstItem?.width && firstItem?.height && firstItem.width > 0) {
      const aspectRatio = firstItem.height / firstItem.width;
      height = Math.min(300, Math.max(150, Math.round(maxWidth * aspectRatio)));
    } else {
      // Unknown dimensions — use 4:3 default
      height = Math.round(maxWidth * 0.75);
      height = Math.min(300, Math.max(150, height));
    }
    return {
      rows: [[{ mediaIndex: 0, width: maxWidth, height }]],
      totalHeight: height,
    };
  }

  if (count === 2) {
    // Side by side, square
    const cellWidth = Math.floor((maxWidth - gap) / 2);
    const cellHeight = cellWidth;
    return {
      rows: [
        [
          { mediaIndex: 0, width: cellWidth, height: cellHeight },
          { mediaIndex: 1, width: cellWidth, height: cellHeight },
        ],
      ],
      totalHeight: cellHeight,
    };
  }

  if (count === 3) {
    // L-shape: left 60%, right 40% with 2 stacked
    const totalHeight = 200;
    const leftWidth = Math.floor(maxWidth * 0.6);
    const rightWidth = maxWidth - leftWidth - gap;
    const rightCellHeight = Math.floor((totalHeight - gap) / 2);
    return {
      rows: [
        [
          { mediaIndex: 0, width: leftWidth, height: totalHeight },
        ],
        [
          { mediaIndex: 1, width: rightWidth, height: rightCellHeight },
          { mediaIndex: 2, width: rightWidth, height: rightCellHeight },
        ],
      ],
      totalHeight,
    };
  }

  // 4+ photos — 2x2 grid
  const cellWidth = Math.floor((maxWidth - gap) / 2);
  const cellHeight = cellWidth;
  const totalHeight = cellHeight * 2 + gap;
  return {
    rows: [
      [
        { mediaIndex: 0, width: cellWidth, height: cellHeight },
        { mediaIndex: 1, width: cellWidth, height: cellHeight },
      ],
      [
        { mediaIndex: 2, width: cellWidth, height: cellHeight },
        { mediaIndex: 3, width: cellWidth, height: cellHeight },
      ],
    ],
    totalHeight,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const MediaGallery = React.memo(function MediaGallery({
  mediaItems,
  maxWidth,
  onItemPress,
}: MediaGalleryProps): React.JSX.Element | null {
  const theme = useTheme();

  if (mediaItems.length === 0 || maxWidth <= 0) return null;

  const gap = theme.spacing.xs;
  const count = mediaItems.length;
  const layout = getGalleryLayout(count, maxWidth, gap, mediaItems[0]);

  const containerStyle: ViewStyle = {
    borderRadius: theme.borderRadius.base,
    overflow: 'hidden',
    marginTop: theme.spacing.sm,
  };

  // For 3-photo L-shape layout, we need a special arrangement
  if (count === 3) {
    return (
      <View style={containerStyle} testID="media-gallery">
        <View style={{ flexDirection: 'row', height: 200 }}>
          {/* Left large image */}
          <MediaItemView
            mediaId={mediaItems[0].id}
            width={layout.rows[0][0].width}
            height={layout.rows[0][0].height}
            onPress={() => onItemPress(0)}
          />
          <View style={{ width: gap }} />
          {/* Right column — 2 stacked */}
          <View style={{ flex: 1 }}>
            <MediaItemView
              mediaId={mediaItems[1].id}
              width={layout.rows[1][0].width}
              height={layout.rows[1][0].height}
              onPress={() => onItemPress(1)}
            />
            <View style={{ height: gap }} />
            <MediaItemView
              mediaId={mediaItems[2].id}
              width={layout.rows[1][1].width}
              height={layout.rows[1][1].height}
              onPress={() => onItemPress(2)}
            />
          </View>
        </View>
      </View>
    );
  }

  // For 1, 2, or 4+ photos — standard row-based layout
  const extraCount = count > 4 ? count - 3 : 0;

  return (
    <View style={containerStyle} testID="media-gallery">
      {layout.rows.map((row, rowIndex) => (
        <View
          key={rowIndex}
          style={{
            flexDirection: 'row',
            marginTop: rowIndex > 0 ? gap : 0,
          }}
        >
          {row.map((cell, cellIndex) => {
            const isLastCell =
              rowIndex === layout.rows.length - 1 &&
              cellIndex === row.length - 1;
            const showOverlay = isLastCell && extraCount > 0;
            const itemIndex = cell.mediaIndex;

            // Don't render items beyond our media array
            if (itemIndex >= mediaItems.length) return null;

            return (
              <View
                key={itemIndex}
                style={{ marginLeft: cellIndex > 0 ? gap : 0 }}
              >
                <MediaItemView
                  mediaId={mediaItems[itemIndex].id}
                  width={cell.width}
                  height={cell.height}
                  onPress={() => onItemPress(itemIndex)}
                />
                {showOverlay && (
                  <OverlayCount
                    count={extraCount}
                    width={cell.width}
                    height={cell.height}
                    theme={theme}
                  />
                )}
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
});

// ---------------------------------------------------------------------------
// "+N" Overlay
// ---------------------------------------------------------------------------

interface OverlayCountProps {
  count: number;
  width: number;
  height: number;
  theme: Theme;
}

function OverlayCount({ count, width, height, theme }: OverlayCountProps): React.JSX.Element {
  const overlayStyle: ViewStyle = {
    position: 'absolute',
    top: 0,
    left: 0,
    width,
    height,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  };

  const textStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.xl,
    color: '#FFFFFF',
  };

  return (
    <View style={overlayStyle} pointerEvents="none">
      <Text style={textStyle}>{`+${count}`}</Text>
    </View>
  );
}
