/**
 * EmojiPicker — categorized OpenMoji emoji grid with search and recents.
 *
 * Replaces the system keyboard emoji tab so users see OpenMoji consistently.
 * Uses a single FlatList with mixed item types (headers + rows) since
 * SectionList does not support numColumns.
 *
 * Recently used emoji are persisted to MMKV (max 30 entries).
 * Search uses searchEmoji() from the emoji data module.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  FlatList,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
  type ListRenderItemInfo,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../theme';
import { Emoji } from './Emoji';
import {
  getCategories,
  getEmojiByCategory,
  getEmojiData,
  searchEmoji,
  unifiedToNative,
  type EmojiDataEntry,
} from '../emoji';
import { getMMKVInstance } from '../stores/middleware/persistence';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Touch target size for each emoji cell */
const CELL_SIZE = 44;
/** Emoji render size inside the cell */
const EMOJI_SIZE = 28;
/** Max number of recently used emoji to persist */
const MAX_RECENT = 30;
/** MMKV key for recently used emoji */
const RECENT_KEY = 'emoji-recent';

// ---------------------------------------------------------------------------
// Category mapping
// ---------------------------------------------------------------------------

interface CategoryInfo {
  /** Canonical name from emoji-datasource */
  canonical: string;
  /** Short display label for tab */
  displayLabel: string;
  /** Unified code of the representative emoji for the tab */
  tabIconUnified: string;
}

/**
 * Mapping from canonical emoji-datasource category names to display metadata.
 * Order determines tab order.
 */
const CATEGORY_MAP: CategoryInfo[] = [
  { canonical: 'Smileys & Emotion', displayLabel: 'Smileys', tabIconUnified: '1F600' },
  { canonical: 'People & Body', displayLabel: 'People', tabIconUnified: '1F44B' },
  { canonical: 'Animals & Nature', displayLabel: 'Animals', tabIconUnified: '1F43B' },
  { canonical: 'Food & Drink', displayLabel: 'Food', tabIconUnified: '1F354' },
  { canonical: 'Travel & Places', displayLabel: 'Travel', tabIconUnified: '1F697' },
  { canonical: 'Activities', displayLabel: 'Activities', tabIconUnified: '26BD' },
  { canonical: 'Objects', displayLabel: 'Objects', tabIconUnified: '1F4A1' },
  { canonical: 'Symbols', displayLabel: 'Symbols', tabIconUnified: '2764-FE0F' },
  { canonical: 'Flags', displayLabel: 'Flags', tabIconUnified: '1F3C1' },
];

// ---------------------------------------------------------------------------
// Recent emoji persistence (MMKV)
// ---------------------------------------------------------------------------

function getRecentEmoji(): string[] {
  try {
    const mmkv = getMMKVInstance();
    const json = mmkv.getString(RECENT_KEY);
    return json ? JSON.parse(json) : [];
  } catch {
    return [];
  }
}

function saveRecentEmoji(unified: string): void {
  try {
    const recent = getRecentEmoji().filter((u) => u !== unified);
    recent.unshift(unified);
    const mmkv = getMMKVInstance();
    mmkv.set(RECENT_KEY, JSON.stringify(recent.slice(0, MAX_RECENT)));
  } catch {
    // Silently fail — not critical
  }
}

// ---------------------------------------------------------------------------
// Grid item types
// ---------------------------------------------------------------------------

type GridItem =
  | { type: 'header'; label: string; key: string }
  | { type: 'row'; emoji: EmojiDataEntry[]; key: string };

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface EmojiPickerProps {
  /** Called when user taps an emoji — receives native unicode character */
  onSelectEmoji: (native: string) => void;
  /** Picker height in points (matches keyboard height) */
  height?: number;
  /** Whether the picker is visible */
  visible: boolean;
}

// ---------------------------------------------------------------------------
// Memoized cell component
// ---------------------------------------------------------------------------

interface EmojiCellProps {
  unified: string;
  cellSize: number;
  onPress: (unified: string) => void;
}

const EmojiCell = React.memo(function EmojiCell({
  unified,
  cellSize,
  onPress,
}: EmojiCellProps): React.JSX.Element {
  const handlePress = useCallback(() => onPress(unified), [unified, onPress]);

  return (
    <TouchableOpacity
      onPress={handlePress}
      activeOpacity={0.6}
      style={{
        width: cellSize,
        height: cellSize,
        alignItems: 'center',
        justifyContent: 'center',
      }}
      accessibilityRole="button"
    >
      <Emoji unified={unified} size={EMOJI_SIZE} />
    </TouchableOpacity>
  );
});

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export const EmojiPicker = React.memo(function EmojiPicker({
  onSelectEmoji,
  height = 300,
  visible,
}: EmojiPickerProps): React.JSX.Element | null {
  const theme = useTheme();
  const { width: screenWidth } = useWindowDimensions();
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState(0);
  const [recentUnified, setRecentUnified] = useState<string[]>([]);
  const flatListRef = useRef<FlatList<GridItem>>(null);

  // Calculate grid columns from available width
  const numColumns = useMemo(
    () => Math.floor((screenWidth - theme.spacing.sm * 2) / CELL_SIZE),
    [screenWidth, theme.spacing.sm],
  );

  // Load recent emoji on mount
  useEffect(() => {
    if (visible) {
      setRecentUnified(getRecentEmoji());
    }
  }, [visible]);

  // Get the actual available categories from the data
  const availableCategories = useMemo(() => {
    const dataCats = new Set(getCategories());
    return CATEGORY_MAP.filter((c) => dataCats.has(c.canonical));
  }, []);

  // ---------------------------------------------------------------------------
  // Build grid data
  // ---------------------------------------------------------------------------

  /**
   * Chunk an array of emoji entries into rows of numColumns.
   */
  const chunkRows = useCallback(
    (entries: EmojiDataEntry[], prefix: string): GridItem[] => {
      const items: GridItem[] = [];
      for (let i = 0; i < entries.length; i += numColumns) {
        items.push({
          type: 'row',
          emoji: entries.slice(i, i + numColumns),
          key: `${prefix}-row-${i}`,
        });
      }
      return items;
    },
    [numColumns],
  );

  /** Search results grid */
  const searchGridData = useMemo((): GridItem[] => {
    if (!searchQuery.trim()) return [];
    const results = searchEmoji(searchQuery.trim(), 50);
    if (results.length === 0) {
      return [{ type: 'header', label: 'No results', key: 'no-results' }];
    }
    return [
      { type: 'header', label: 'Search Results', key: 'search-header' },
      ...chunkRows(results, 'search'),
    ];
  }, [searchQuery, chunkRows]);

  /** Full category grid (with recents) */
  const categoryGridData = useMemo((): GridItem[] => {
    const items: GridItem[] = [];

    // Recently used section
    if (recentUnified.length > 0) {
      items.push({ type: 'header', label: 'Recently Used', key: 'recent-header' });
      // O(1) lookup per unified code via the emojiByUnified map
      const recentEntries: EmojiDataEntry[] = [];
      for (const u of recentUnified) {
        const entry = getEmojiData(u);
        if (entry) {
          recentEntries.push(entry);
        }
      }
      items.push(...chunkRows(recentEntries, 'recent'));
    }

    // All categories
    for (const cat of availableCategories) {
      items.push({
        type: 'header',
        label: cat.displayLabel,
        key: `cat-header-${cat.canonical}`,
      });
      const entries = getEmojiByCategory(cat.canonical);
      items.push(...chunkRows(entries, cat.canonical));
    }

    return items;
  }, [recentUnified, availableCategories, chunkRows]);

  // Precompute category header indices for scrolling
  const categoryHeaderIndices = useMemo(() => {
    const indices: number[] = [];
    const data = categoryGridData;
    for (let i = 0; i < data.length; i++) {
      const item = data[i];
      if (item.type === 'header') {
        // Match to a category
        const catIdx = availableCategories.findIndex(
          (c) => `cat-header-${c.canonical}` === item.key,
        );
        if (catIdx >= 0) {
          indices[catIdx] = i;
        }
      }
    }
    return indices;
  }, [categoryGridData, availableCategories]);

  const gridData = searchQuery.trim() ? searchGridData : categoryGridData;

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleEmojiPress = useCallback(
    (unified: string) => {
      const native = unifiedToNative(unified);
      saveRecentEmoji(unified);
      setRecentUnified((prev) => {
        const filtered = prev.filter((u) => u !== unified);
        return [unified, ...filtered].slice(0, MAX_RECENT);
      });
      onSelectEmoji(native);
    },
    [onSelectEmoji],
  );

  const handleCategoryPress = useCallback(
    (index: number) => {
      setActiveCategory(index);
      setSearchQuery('');
      const headerIndex = categoryHeaderIndices[index];
      if (headerIndex != null && flatListRef.current) {
        flatListRef.current.scrollToIndex({
          index: headerIndex,
          animated: true,
        });
      }
    },
    [categoryHeaderIndices],
  );

  const handleSearchChange = useCallback((text: string) => {
    setSearchQuery(text);
  }, []);

  const handleSearchClear = useCallback(() => {
    setSearchQuery('');
  }, []);

  // ---------------------------------------------------------------------------
  // Render items
  // ---------------------------------------------------------------------------

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<GridItem>) => {
      if (item.type === 'header') {
        return (
          <View
            style={{
              paddingHorizontal: theme.spacing.sm,
              paddingTop: theme.spacing.md,
              paddingBottom: theme.spacing.xs,
            }}
          >
            <Text
              style={{
                fontFamily: theme.typography.fontFamily.bodyBold,
                fontSize: theme.typography.fontSize.sm,
                color: theme.colors.textSecondary,
              }}
            >
              {item.label}
            </Text>
          </View>
        );
      }

      // Row of emoji
      return (
        <View
          style={{
            flexDirection: 'row',
            paddingHorizontal: theme.spacing.sm,
          }}
        >
          {item.emoji.map((entry) => (
            <EmojiCell
              key={entry.unified}
              unified={entry.unified}
              cellSize={CELL_SIZE}
              onPress={handleEmojiPress}
            />
          ))}
        </View>
      );
    },
    [theme, handleEmojiPress],
  );

  const keyExtractor = useCallback((item: GridItem) => item.key, []);

  const onScrollToIndexFailed = useCallback(
    (info: { index: number; averageItemLength: number }) => {
      // Fallback: scroll to approximate offset
      flatListRef.current?.scrollToOffset({
        offset: info.index * info.averageItemLength,
        animated: true,
      });
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------

  if (!visible) return null;

  const containerStyle: ViewStyle = {
    height,
    backgroundColor: theme.colors.surface,
    borderTopWidth: 1,
    borderTopColor: theme.colors.borderSubtle,
  };

  const searchRowStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.sm,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.xs,
  };

  const searchInputStyle: TextStyle = {
    flex: 1,
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderSubtle,
    borderRadius: theme.borderRadius.base,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
    height: 32,
  };

  const categoryTabsStyle: ViewStyle = {
    flexDirection: 'row',
    backgroundColor: theme.colors.surfaceElevated,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderSubtle,
    paddingVertical: theme.spacing.xs,
  };

  return (
    <View style={containerStyle} testID="emoji-picker">
      {/* Search bar */}
      <View style={searchRowStyle}>
        <TextInput
          style={searchInputStyle}
          value={searchQuery}
          onChangeText={handleSearchChange}
          placeholder="Search emoji..."
          placeholderTextColor={theme.colors.textTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          testID="emoji-search-input"
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity
            onPress={handleSearchClear}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={{ marginLeft: theme.spacing.xs }}
            accessibilityRole="button"
            accessibilityLabel="Clear search"
          >
            <Text
              style={{
                fontFamily: theme.typography.fontFamily.body,
                fontSize: theme.typography.fontSize.base,
                color: theme.colors.textSecondary,
              }}
            >
              X
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Category tabs */}
      {!searchQuery.trim() && (
        <View style={categoryTabsStyle}>
          {availableCategories.map((cat, index) => {
            const isActive = index === activeCategory;
            const tabStyle: ViewStyle = {
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
              paddingVertical: theme.spacing.xs,
              borderBottomWidth: isActive ? 2 : 0,
              borderBottomColor: isActive ? theme.colors.blue : 'transparent',
            };
            return (
              <TouchableOpacity
                key={cat.canonical}
                style={tabStyle}
                onPress={() => handleCategoryPress(index)}
                accessibilityRole="tab"
                accessibilityLabel={cat.displayLabel}
                accessibilityState={{ selected: isActive }}
              >
                <Emoji unified={cat.tabIconUnified} size={20} />
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {/* Emoji grid */}
      <FlatList
        ref={flatListRef}
        data={gridData}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        style={{ flex: 1 }}
        keyboardShouldPersistTaps="always"
        initialNumToRender={15}
        maxToRenderPerBatch={10}
        windowSize={5}
        onScrollToIndexFailed={onScrollToIndexFailed}
      />
    </View>
  );
});
