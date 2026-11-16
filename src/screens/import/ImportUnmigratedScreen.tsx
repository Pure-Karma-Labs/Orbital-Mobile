/**
 * "What didn't migrate", grouped by reason (#928 §4.5).
 *
 * Alex's transparency requirement: a member must be able to see the items
 * themselves, not just a count — with enough to recognise each one (its
 * original date and the file it came from) and a plain-language reason.
 *
 * ## Three things this screen is careful about
 *
 *  1. **It snapshots on MOUNT.** The read, the file issues and the source are
 *     all taken once, so dismissing the summary from underneath it cannot
 *     empty a list the member is reading. The list lives for the session;
 *     Share is how they keep it.
 *  2. **It never materialises more rows than it displays.** The read is capped
 *     at 1,000 (op-sqlite's `executeSync` blocks the JS thread, and an export
 *     can hold fifty thousand). The GROUP COUNTS come from a
 *     `COUNT … GROUP BY`, so the headers stay truthful above a capped list,
 *     and the footer says how many are not shown.
 *  3. **One FlatList of mixed rows**, not a SectionList: the app has no
 *     SectionList precedent, and the group headers are just another row type.
 *
 * Nothing here is logged. The basenames on these rows are local-UI class
 * (F18): they are rendered, never sent anywhere but the OS share sheet, and
 * never written to a log line.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  InteractionManager,
  Share,
  Text,
  TouchableOpacity,
  View,
  type ListRenderItemInfo,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../../theme';
import { Header } from '../../components/Header';
import { OrbitalSpinner } from '../../components/OrbitalSpinner';
import { SectionHeader } from '../settings/SectionHeader';
import { SKIP_REASON_CLASS } from '../../services/metaImport/types';
import { getImportUnmigratedItems, importStore } from '../../services/metaImport/importRunner';
import {
  FILE_ISSUE_GROUP_HEADER,
  SHARE_LIST_LABEL,
  UNMIGRATED_EMPTY_COPY,
  UNMIGRATED_SCREEN_TITLE,
  buildUnmigratedShareText,
  describeFileIssueRow,
  describeMoreFooter,
  describeUnmigratedReason,
  describeUnmigratedRow,
  describeUnmigratedRowA11y,
  groupUnmigrated,
  plural,
  totalUnmigrated,
} from './importCopy';

import type { FileIssue, ImportSource, SkipReason } from '../../services/metaImport/types';
import type {
  UnmigratedCounts,
  UnmigratedImportItem,
  UnmigratedImportList,
} from '../../services/metaImport/importRunner';
import type { UnmigratedGroupKey } from './importCopy';

/** One line of the list. The group headers are rows like any other. */
type UnmigratedRow =
  | {
      kind: 'header';
      key: string;
      header: string;
      subline: string | null;
      /** The FULL count for this group, which can exceed the rows shown. */
      count: number;
    }
  | { kind: 'row'; key: string; item: UnmigratedImportItem }
  | { kind: 'fileIssueHeader'; key: string }
  | { kind: 'fileIssue'; key: string; issue: FileIssue }
  | { kind: 'moreFooter'; key: string; truncated: number };

/** Sum a `Partial<Record<…, number>>`, treating a missing key as zero. */
function sumValues(values: Readonly<Partial<Record<string, number>>>): number {
  let total = 0;
  for (const value of Object.values(values)) total += value ?? 0;
  return total;
}

/**
 * The group's true size, from the `COUNT … GROUP BY` rather than from the
 * capped row list.
 *
 * Per-group, so it cannot go through `totalUnmigrated` — that one is the sum
 * across every group, and this screen uses it for exactly that (below).
 */
function groupCount(key: UnmigratedGroupKey, counts: UnmigratedCounts): number {
  if (key === 'not_sent') return counts.notSent;
  if (key === 'failed') return sumValues(counts.failed);
  const inThisGroup: Record<string, number> = {};
  for (const [reason, value] of Object.entries(counts.skipped)) {
    if (SKIP_REASON_CLASS[reason as SkipReason] === key) inThisGroup[reason] = value ?? 0;
  }
  return sumValues(inThisGroup);
}

interface UnmigratedSnapshot {
  readonly list: UnmigratedImportList;
  readonly fileIssues: readonly FileIssue[];
  readonly source: ImportSource | null;
}

export function ImportUnmigratedScreen(): React.JSX.Element {
  const theme = useTheme();
  const navigation = useNavigation();

  /**
   * Read ONCE — but AFTER the push transition, never during it.
   *
   * `getImportUnmigratedItems` is two synchronous op-sqlite reads, and
   * op-sqlite's `executeSync` blocks the JS thread: doing that inside render
   * would stall the navigator's slide-in by however long the query takes on a
   * large archive. `runAfterInteractions` lets the animation finish first and
   * costs a spinner frame.
   *
   * The snapshot-once semantics are unchanged, which is the point of it:
   * dismissing the summary later cannot empty a list the member is reading,
   * and the read still happens before any dismiss reachable from THIS screen.
   */
  const [snapshot, setSnapshot] = useState<UnmigratedSnapshot | null>(null);

  useEffect(() => {
    let active = true;
    const handle = InteractionManager.runAfterInteractions(() => {
      if (!active) return;
      const state = importStore.getState();
      setSnapshot({
        list: getImportUnmigratedItems(),
        fileIssues: state.preflight?.summary?.fileIssues ?? ([] as readonly FileIssue[]),
        source: state.source,
      });
    });
    return () => {
      active = false;
      handle.cancel();
    };
  }, []);

  const rows = useMemo<readonly UnmigratedRow[]>(() => {
    if (snapshot === null) return [];
    const out: UnmigratedRow[] = [];
    for (const group of groupUnmigrated(snapshot.list.items)) {
      out.push({
        kind: 'header',
        key: `h-${group.key}`,
        header: group.header,
        subline: group.subline,
        count: groupCount(group.key, snapshot.list.counts),
      });
      for (const item of group.items) {
        out.push({ kind: 'row', key: `i-${item.id}`, item });
      }
    }
    if (snapshot.list.truncated > 0) {
      out.push({ kind: 'moreFooter', key: 'more', truncated: snapshot.list.truncated });
    }
    if (snapshot.fileIssues.length > 0) {
      out.push({ kind: 'fileIssueHeader', key: 'h-file-issues' });
      snapshot.fileIssues.forEach((issue, index) => {
        out.push({ kind: 'fileIssue', key: `f-${index}`, issue });
      });
    }
    return out;
  }, [snapshot]);

  const handleShare = useCallback(() => {
    if (snapshot === null || snapshot.source === null) return;
    Share.share({
      message: buildUnmigratedShareText(
        snapshot.list.items,
        snapshot.list.counts,
        snapshot.fileIssues,
        snapshot.source,
      ),
    }).catch(() => {
      // The member dismissed the sheet, or the OS refused it. Neither is
      // worth an alert, and nothing here may be logged.
    });
  }, [snapshot]);

  /**
   * Is there anything to share? The TOTALS decide, not the rendered rows: the
   * row list is capped at a thousand and the counts are not, so a list that is
   * all footer still has something worth keeping.
   */
  const shareable =
    snapshot !== null &&
    snapshot.source !== null &&
    (totalUnmigrated(snapshot.list.counts) > 0 || snapshot.fileIssues.length > 0);

  const containerStyle: ViewStyle = {
    flex: 1,
    backgroundColor: theme.colors.background,
  };

  const loadingStyle: ViewStyle = {
    flex: 1,
    alignItems: 'center',
    paddingTop: theme.spacing.xl,
  };

  const rowStyle: ViewStyle = {
    paddingHorizontal: theme.spacing.base,
    paddingVertical: theme.spacing.sm,
  };

  const identityStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
  };

  const reasonStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textSecondary,
    marginTop: 2,
  };

  const captionStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textTertiary,
    paddingHorizontal: theme.spacing.base,
    paddingBottom: theme.spacing.sm,
  };

  const shareStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.blue,
  };

  const renderRow = ({ item: row }: ListRenderItemInfo<UnmigratedRow>): React.JSX.Element => {
    switch (row.kind) {
      case 'header':
        return (
          <View testID={`unmigrated-header-${row.key}`}>
            <SectionHeader label={row.header} />
            <Text style={captionStyle}>
              {row.subline === null
                ? plural(row.count, 'post')
                : `${plural(row.count, 'post')}. ${row.subline}`}
            </Text>
          </View>
        );

      case 'row':
        return (
          <View
            style={rowStyle}
            accessible
            accessibilityLabel={describeUnmigratedRowA11y(row.item)}
            testID="unmigrated-row"
          >
            <Text style={identityStyle}>{describeUnmigratedRow(row.item)}</Text>
            <Text style={reasonStyle}>{describeUnmigratedReason(row.item)}</Text>
          </View>
        );

      case 'fileIssueHeader':
        return <SectionHeader label={FILE_ISSUE_GROUP_HEADER} />;

      case 'fileIssue':
        return (
          <View style={rowStyle} testID="unmigrated-file-issue">
            <Text style={identityStyle}>{describeFileIssueRow(row.issue)}</Text>
          </View>
        );

      case 'moreFooter':
        return (
          <Text style={[captionStyle, { paddingTop: theme.spacing.md }]} testID="unmigrated-more">
            {describeMoreFooter(row.truncated)}
          </Text>
        );
    }
  };

  return (
    <SafeAreaView style={containerStyle} edges={['top']} testID="import-unmigrated-screen">
      <Header
        title={UNMIGRATED_SCREEN_TITLE}
        onBack={() => navigation.goBack()}
        right={
          !shareable ? undefined : (
            <TouchableOpacity
              onPress={handleShare}
              accessibilityRole="button"
              accessibilityLabel={SHARE_LIST_LABEL}
              testID="unmigrated-share"
            >
              <Text style={shareStyle}>{SHARE_LIST_LABEL}</Text>
            </TouchableOpacity>
          )
        }
      />
      {snapshot === null ? (
        // The read has not run yet. An empty-state line here would say
        // "nothing to list" about a list nobody has read.
        <View style={loadingStyle} testID="unmigrated-loading">
          <OrbitalSpinner size={32} />
        </View>
      ) : (
        <FlatList
          data={rows}
          renderItem={renderRow}
          keyExtractor={(row: UnmigratedRow) => row.key}
          ListEmptyComponent={
            <Text
              style={[captionStyle, { paddingTop: theme.spacing.base }]}
              testID="unmigrated-empty"
            >
              {UNMIGRATED_EMPTY_COPY}
            </Text>
          }
          contentContainerStyle={{ paddingBottom: theme.spacing.xl }}
          testID="unmigrated-list"
        />
      )}
    </SafeAreaView>
  );
}

export default ImportUnmigratedScreen;
