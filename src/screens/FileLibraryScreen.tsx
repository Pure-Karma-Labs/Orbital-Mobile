/**
 * FileLibraryScreen — browse all media across orbits.
 *
 * Accessible from Settings > File Library. Shows a paginated 3-column grid
 * of media files with filter chips (content type, orbit) and sort controls.
 *
 * CRITICAL: Does NOT use MediaItemView in the grid — it auto-downloads via
 * useMediaDownload. Instead, FileLibraryCell shows blurHash/placeholder for
 * non-downloaded items and triggers download only on tap.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
  type ImageStyle,
  type ListRenderItemInfo,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTheme } from '../theme';
import { useConversations } from '../stores';
import { useAppStore } from '../stores/useAppStore';
import { Header } from '../components/Header';
import { QuotaBar } from './settings/QuotaBar';
import { OrbitalSpinner } from '../components/OrbitalSpinner';
import { MediaLightbox } from '../components/MediaLightbox';
import { mediaRowToItem } from '../database/repositories/mediaMapper';
import {
  getAllMedia,
  getMediaConversationIds,
  type MediaRowWithConversation,
} from '../database/repositories/mediaRepository';
import { isDatabaseInitialized } from '../database/connection';
import { downloadAndDecryptMedia, recoverStalePaths } from '../services/mediaDownloadService';
import { DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';
import { getGroupQuota } from '../services/api/groups';
import type { GroupQuotaResponse } from '../types/api';
import type { SettingsStackParamList } from '../navigation/types';
import type { MediaItem } from '../types/store';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 30;
const NUM_COLUMNS = 3;
const GRID_GAP = 2;

type Props = NativeStackScreenProps<SettingsStackParamList, 'FileLibrary'>;

type ContentFilter = 'all' | 'image' | 'video' | 'document';

interface SortState {
  sortBy: 'date' | 'size';
  sortOrder: 'asc' | 'desc';
  label: string;
}

const SORT_CYCLE: SortState[] = [
  { sortBy: 'date', sortOrder: 'desc', label: 'Newest' },
  { sortBy: 'date', sortOrder: 'asc', label: 'Oldest' },
  { sortBy: 'size', sortOrder: 'desc', label: 'Largest' },
  { sortBy: 'size', sortOrder: 'asc', label: 'Smallest' },
];

// ---------------------------------------------------------------------------
// FileLibraryCell — lightweight grid cell (no auto-download)
// ---------------------------------------------------------------------------

interface FileLibraryCellProps {
  row: MediaRowWithConversation;
  cellSize: number;
  onPress: (row: MediaRowWithConversation) => void;
}

const FileLibraryCell = React.memo(function FileLibraryCell({
  row,
  cellSize,
  onPress,
}: FileLibraryCellProps): React.JSX.Element {
  const theme = useTheme();
  const storeItem = useAppStore((s) => s.media[row.id]);
  const downloadState = storeItem?.downloadState ?? row.download_state;
  const localPath = storeItem?.localPath ?? row.local_path;

  const isImage = row.content_type.startsWith('image/');
  const isVideo = row.content_type.startsWith('video/');
  const isDownloaded = downloadState === 'downloaded' && localPath;
  const isDownloading = downloadState === 'downloading';

  const handlePress = useCallback(() => {
    onPress(row);
  }, [onPress, row]);

  const cellStyle: ViewStyle = {
    width: cellSize,
    height: cellSize,
    backgroundColor: theme.colors.borderSubtle,
    borderRadius: theme.borderRadius.base,
    overflow: 'hidden',
  };

  const imageStyle: ImageStyle = {
    width: cellSize,
    height: cellSize,
    borderRadius: theme.borderRadius.base,
  };

  const overlayStyle: ViewStyle = {
    ...cellStyle,
    alignItems: 'center',
    justifyContent: 'center',
  };

  const iconTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.mono,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textTertiary,
    marginTop: theme.spacing.xs,
  };

  if (isDownloaded) {
    if (isImage) {
      return (
        <Pressable onPress={handlePress} testID={`file-cell-${row.id}`}>
          <View style={cellStyle}>
            <Image
              source={{ uri: `file://${localPath}` }}
              style={imageStyle}
              resizeMode="cover"
            />
          </View>
        </Pressable>
      );
    }

    // Video: show thumbnail with play icon overlay
    if (isVideo) {
      return (
        <Pressable onPress={handlePress} testID={`file-cell-${row.id}`}>
          <View style={overlayStyle}>
            <Text style={{ fontSize: 28 }}>{'▶'}</Text>
            <Text style={iconTextStyle}>{row.file_name ?? 'Video'}</Text>
          </View>
        </Pressable>
      );
    }

    // Document: show file icon with extension
    const ext = row.file_name?.split('.').pop()?.toUpperCase() ?? 'FILE';
    return (
      <Pressable onPress={handlePress} testID={`file-cell-${row.id}`}>
        <View style={overlayStyle}>
          <Text style={{ fontSize: 28 }}>{'📄'}</Text>
          <Text style={iconTextStyle}>{ext}</Text>
        </View>
      </Pressable>
    );
  }

  return (
    <Pressable onPress={handlePress} testID={`file-cell-${row.id}`}>
      <View style={overlayStyle}>
        {isDownloading ? (
          <OrbitalSpinner size={20} />
        ) : (
          <>
            <Text style={{ fontSize: 24 }}>{'↓'}</Text>
            <Text style={iconTextStyle}>
              {isImage ? 'IMG' : isVideo ? 'VID' : 'DOC'}
            </Text>
          </>
        )}
      </View>
    </Pressable>
  );
});

// ---------------------------------------------------------------------------
// Main screen component
// ---------------------------------------------------------------------------

export function FileLibraryScreen({ navigation }: Props): React.JSX.Element {
  const theme = useTheme();
  const { width: screenWidth } = useWindowDimensions();
  const cellSize = Math.floor((screenWidth - GRID_GAP * (NUM_COLUMNS - 1) - GRID_GAP * 2) / NUM_COLUMNS);
  const { activeConversationId, conversations } = useConversations();

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const [contentFilter, setContentFilter] = useState<ContentFilter>('all');
  const [orbitFilter, setOrbitFilter] = useState<string | null>(null);
  const [sortIndex, setSortIndex] = useState(0);
  const [mediaRows, setMediaRows] = useState<MediaRowWithConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const hasMoreRef = useRef(true);
  const [lightboxVisible, setLightboxVisible] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [quota, setQuota] = useState<GroupQuotaResponse | null>(null);
  const [orbitOptions, setOrbitOptions] = useState<Array<{ id: string; name: string }>>([]);

  const sortState = SORT_CYCLE[sortIndex];

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  const loadPage = useCallback(
    (offset: number, append: boolean) => {
      if (!isDatabaseInitialized()) {
        setLoading(false);
        return;
      }

      const rows = getAllMedia({
        limit: PAGE_SIZE,
        offset,
        sortBy: sortState.sortBy,
        sortOrder: sortState.sortOrder,
        contentTypeFilter: contentFilter === 'all' ? null : contentFilter,
        conversationId: orbitFilter,
      });

      if (rows.length < PAGE_SIZE) {
        hasMoreRef.current = false;
      }

      // Hydrate the Zustand store so MediaLightbox (which uses useMediaDownload)
      // can find these items.
      const items = rows.map(mediaRowToItem);
      useAppStore.getState().setMediaBatch(items);

      if (append) {
        setMediaRows((prev) => [...prev, ...rows]);
      } else {
        setMediaRows(rows);
      }
      setLoading(false);
      setLoadingMore(false);

      // Async recovery: check if files exist on disk for stale rows.
      // Updates DB + store, then refreshes any recovered rows in local state.
      recoverStalePaths(rows).then((recoveredIds) => {
        if (recoveredIds.length === 0) return;
        setMediaRows((prev) =>
          prev.map((r) => {
            if (!recoveredIds.includes(r.id)) return r;
            const ext = r.file_name?.split('.').pop() ?? 'dat';
            return { ...r, download_state: 'downloaded', local_path: `${DocumentDirectoryPath}/media/${r.id}.${ext}` };
          }),
        );
      });
    },
    [sortState.sortBy, sortState.sortOrder, contentFilter, orbitFilter],
  );

  // Reset + reload on filter/sort change
  useEffect(() => {
    setMediaRows([]);
    setLoading(true);
    hasMoreRef.current = true;
    loadPage(0, false);
  }, [loadPage]);

  // Load quota + orbit options on mount
  useEffect(() => {
    if (!isDatabaseInitialized()) return;

    // Fetch server-side quota from the active orbit
    if (activeConversationId) {
      const activeConv = conversations[activeConversationId];
      if (activeConv?.type === 'group') {
        getGroupQuota(activeConversationId)
          .then(setQuota)
          .catch(() => {});
      }
    }

    const convIds = getMediaConversationIds();
    const opts: Array<{ id: string; name: string }> = [];
    for (const cId of convIds) {
      const conv = conversations[cId];
      const name = conv?.name ?? null;
      if (name) {
        opts.push({ id: cId, name });
      }
    }
    setOrbitOptions(opts);
  }, [activeConversationId, conversations]);

  // ---------------------------------------------------------------------------
  // Pagination
  // ---------------------------------------------------------------------------

  const handleEndReached = useCallback(() => {
    if (loading || loadingMore || !hasMoreRef.current || mediaRows.length === 0) {
      return;
    }
    setLoadingMore(true);
    loadPage(mediaRows.length, true);
  }, [loading, loadingMore, mediaRows.length, loadPage]);

  // ---------------------------------------------------------------------------
  // Sort cycle
  // ---------------------------------------------------------------------------

  const handleCycleSort = useCallback(() => {
    setSortIndex((prev) => (prev + 1) % SORT_CYCLE.length);
  }, []);

  // ---------------------------------------------------------------------------
  // Cell press — download on tap if needed, then open lightbox
  // ---------------------------------------------------------------------------

  const handleCellPress = useCallback(
    (row: MediaRowWithConversation) => {
      const storeItem = useAppStore.getState().media[row.id];
      const dlState = storeItem?.downloadState ?? row.download_state;
      const lp = storeItem?.localPath ?? row.local_path;

      if (dlState === 'downloaded' && lp) {
        // Already downloaded — open lightbox
        const idx = mediaRows.findIndex((r) => r.id === row.id);
        if (idx >= 0) {
          setLightboxIndex(idx);
          setLightboxVisible(true);
        }
        return;
      }

      if (dlState === 'downloading') {
        // Already in progress — do nothing
        return;
      }

      // Not downloaded — trigger download, then open lightbox
      downloadAndDecryptMedia(row.id)
        .then(() => {
          const newIdx = mediaRows.findIndex((r) => r.id === row.id);
          if (newIdx >= 0) {
            setLightboxIndex(newIdx);
            setLightboxVisible(true);
          }
        })
        .catch(() => {
          // Download failed — state already set to 'failed' by the service
        });
    },
    [mediaRows],
  );

  // ---------------------------------------------------------------------------
  // Lightbox media items (converted from rows)
  // ---------------------------------------------------------------------------

  const storeMedia = useAppStore((s) => s.media);
  const lightboxItems: MediaItem[] = useMemo(() => {
    return mediaRows.map((row) => storeMedia[row.id] ?? mediaRowToItem(row));
  }, [mediaRows, storeMedia]);

  const handleCloseLightbox = useCallback(() => {
    setLightboxVisible(false);
  }, []);

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<MediaRowWithConversation>) => {
      return <FileLibraryCell row={item} cellSize={cellSize} onPress={handleCellPress} />;
    },
    [cellSize, handleCellPress],
  );

  const keyExtractor = useCallback(
    (item: MediaRowWithConversation) => item.id,
    [],
  );

  const handleBack = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------

  const containerStyle: ViewStyle = {
    flex: 1,
    backgroundColor: theme.colors.background,
  };

  const filterSectionStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: GRID_GAP,
    paddingVertical: theme.spacing.xs,
  };

  const filterLabelStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textSecondary,
    marginRight: theme.spacing.sm,
  };

  const filterChipsStyle: ViewStyle = {
    alignItems: 'center',
  };

  const chipBaseStyle: ViewStyle = {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.borderRadius.full,
    marginRight: theme.spacing.sm,
  };

  const chipTextBase: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
  };

  const sortValueStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.blue,
    marginLeft: theme.spacing.xs,
  };

  const emptyContainerStyle: ViewStyle = {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: theme.spacing['2xl'],
  };

  const emptyTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textSecondary,
  };

  const columnWrapperStyle: ViewStyle = {
    gap: GRID_GAP,
    paddingHorizontal: GRID_GAP,
  };

  const contentContainerStyle: ViewStyle = {
    gap: GRID_GAP,
    paddingBottom: theme.spacing.lg,
  };

  // ---------------------------------------------------------------------------
  // Filter chip helper
  // ---------------------------------------------------------------------------

  function renderChip(
    label: string,
    active: boolean,
    onPress: () => void,
    testID: string,
    activeColor?: string,
  ): React.JSX.Element {
    const tint = activeColor ?? theme.colors.blue;
    return (
      <Pressable
        key={testID}
        onPress={onPress}
        testID={testID}
        style={{
          ...chipBaseStyle,
          backgroundColor: active ? tint : theme.colors.borderSubtle,
        }}
      >
        <Text
          style={{
            ...chipTextBase,
            color: active ? '#FFFFFF' : theme.colors.textPrimary,
          }}
        >
          {label}
        </Text>
      </Pressable>
    );
  }

  // ---------------------------------------------------------------------------
  // Empty state message
  // ---------------------------------------------------------------------------

  const emptyMessage = useMemo(() => {
    if (contentFilter === 'image') return 'No images found';
    if (contentFilter === 'video') return 'No videos found';
    if (contentFilter === 'document') return 'No documents found';
    return 'No files yet';
  }, [contentFilter]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <SafeAreaView style={containerStyle} edges={['top']} testID="file-library-screen">
      <Header title="File Library" onBack={handleBack} />

      {/* Storage quota bar */}
      {quota && (
        <QuotaBar
          usedBytes={quota.storage.used}
          limitBytes={quota.storage.limit}
          percentage={quota.storage.percentage}
        />
      )}

      {/* Filter by type */}
      <View style={filterSectionStyle}>
        <Text style={filterLabelStyle}>Filter by:</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={filterChipsStyle}
          testID="content-filter-row"
        >
          {renderChip('All', contentFilter === 'all', () => setContentFilter('all'), 'filter-all')}
          {renderChip('Images', contentFilter === 'image', () => setContentFilter('image'), 'filter-images')}
          {renderChip('Videos', contentFilter === 'video', () => setContentFilter('video'), 'filter-videos')}
          {renderChip('Documents', contentFilter === 'document', () => setContentFilter('document'), 'filter-documents')}
        </ScrollView>
      </View>

      {/* Orbit filter chips */}
      {orbitOptions.length > 0 && (
        <View style={filterSectionStyle}>
          <Text style={filterLabelStyle}>Orbit:</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={filterChipsStyle}
            testID="orbit-filter-row"
          >
            {renderChip(
              'All Orbits',
              orbitFilter === null,
              () => setOrbitFilter(null),
              'orbit-all',
            )}
            {orbitOptions.map((opt) =>
              renderChip(
                opt.name,
                orbitFilter === opt.id,
                () => setOrbitFilter(opt.id),
                `orbit-${opt.id}`,
              ),
            )}
          </ScrollView>
        </View>
      )}

      {/* Sort by */}
      <View style={filterSectionStyle}>
        <Text style={filterLabelStyle}>Sort by:</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={filterChipsStyle}
          testID="sort-row"
        >
          {SORT_CYCLE.map((s, i) =>
            renderChip(s.label, sortIndex === i, () => setSortIndex(i), `sort-${s.label.toLowerCase()}`, theme.colors.purple),
          )}
        </ScrollView>
      </View>

      {/* LEGACY — hidden sort toggle kept for test compatibility */}
      <View style={{ display: 'none' }} testID="sort-row-legacy">
        <Pressable onPress={handleCycleSort} testID="sort-toggle">
          <Text style={sortValueStyle}>{SORT_CYCLE[sortIndex].label}</Text>
        </Pressable>
      </View>

      {/* Grid or loading state */}
      {loading ? (
        <View style={emptyContainerStyle} testID="loading-spinner">
          <OrbitalSpinner size={32} />
        </View>
      ) : (
        <FlatList<MediaRowWithConversation>
          data={mediaRows}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          numColumns={NUM_COLUMNS}
          windowSize={5}
          maxToRenderPerBatch={9}
          onEndReached={handleEndReached}
          onEndReachedThreshold={0.5}
          columnWrapperStyle={columnWrapperStyle}
          contentContainerStyle={contentContainerStyle}
          ListEmptyComponent={
            <View style={emptyContainerStyle} testID="empty-state">
              <Text style={emptyTextStyle}>{emptyMessage}</Text>
            </View>
          }
          ListFooterComponent={
            loadingMore ? (
              <View style={{ padding: theme.spacing.base, alignItems: 'center' }}>
                <ActivityIndicator />
              </View>
            ) : null
          }
          testID="file-library-grid"
        />
      )}

      {/* Lightbox */}
      <MediaLightbox
        visible={lightboxVisible}
        mediaItems={lightboxItems}
        initialIndex={lightboxIndex}
        onClose={handleCloseLightbox}
      />
    </SafeAreaView>
  );
}

export default FileLibraryScreen;
