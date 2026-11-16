/**
 * The import's accessibility announcements (#928 §3.5). Renders nothing.
 *
 * ## Why it is not part of the strip
 *
 * `CustomTabBar` returns null while the Android keyboard is open
 * (`MainTabNavigator.tsx`), so an announcer living inside the strip would
 * unmount mid-import and silently swallow every transition that happened while
 * the member was typing. This one is mounted in `App.tsx`'s authenticated
 * branch, beside `IdentityRestoreBanner`, and stays mounted for the session.
 *
 * ## It announces TRANSITIONS, never ticks
 *
 * The last announced view KIND is held in a ref, seeded from the store's
 * current state the way `BulkExportStatus` seeds its phase — so coming back to
 * the app mid-run does not re-announce "Importing 300 posts". The counters and
 * the countdown are deliberately never announced: a live region on either
 * would talk over everything else the member is doing.
 */

import { useEffect, useRef } from 'react';
import { AccessibilityInfo } from 'react-native';
import { useStore } from 'zustand';
import { importViewStore } from './runnerContract';
import { deriveImportView, describeImportAnnouncement } from './importCopy';

import type { ImportViewKind } from './importCopy';

export function ImportStatusAnnouncer(): null {
  const state = useStore(importViewStore);
  const view = deriveImportView(state);

  /**
   * The kind we last announced, seeded from the CURRENT store rather than from
   * a null: mounting mid-run must not announce the state the member is
   * already in.
   */
  const announcedRef = useRef<ImportViewKind>(deriveImportView(importViewStore.getState()).kind);

  const kind = view.kind;
  const cause = view.cause;
  const total = state.total;
  const summary = state.summary;

  useEffect(() => {
    const previous = announcedRef.current;
    // The KIND is the whole gate. A pause that swaps one cause for another, a
    // counter tick and a re-publish of the same state all land here and say
    // nothing.
    if (previous === kind) return;
    announcedRef.current = kind;

    const message = describeImportAnnouncement({ kind, cause }, previous, total, summary);
    if (message !== null) AccessibilityInfo.announceForAccessibility(message);
  }, [kind, cause, total, summary]);

  return null;
}
