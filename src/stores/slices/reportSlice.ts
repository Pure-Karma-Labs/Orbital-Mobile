/**
 * Report slice — transient UI state for the content reporting modal.
 *
 * NOT persisted — this is ephemeral modal state that should not survive
 * app restarts. Do NOT add to PersistedState or the partialize whitelist.
 */

import type { StateCreator } from 'zustand';
import type { AppState, ReportSlice, ReportTarget } from '../../types/store';

export const createReportSlice: StateCreator<
  AppState,
  [['zustand/devtools', never]],
  [],
  ReportSlice
> = (set) => ({
  // Initial state
  reportTarget: null,

  // Actions
  openReportSheet: (target: ReportTarget) => {
    set({ reportTarget: target }, false, 'report/openReportSheet');
  },

  closeReportSheet: () => {
    set({ reportTarget: null }, false, 'report/closeReportSheet');
  },
});
