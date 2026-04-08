import type { StateCreator } from 'zustand';
import type { AppState, Draft, UISlice } from '../../types/store';

export const createUISlice: StateCreator<AppState, [], [], UISlice> = (
  set,
  get,
) => ({
  // Initial state
  colorScheme: 'system',
  activeTab: 'threads',
  composerDraft: null,
  isComposerOpen: false,
  syncOverallStatus: 'synced',

  // Actions
  setColorScheme: (scheme) =>
    set({ colorScheme: scheme }, false, 'ui/setColorScheme'),

  setActiveTab: (tab) => set({ activeTab: tab }, false, 'ui/setActiveTab'),

  setComposerDraft: (draft: Draft | null) =>
    set({ composerDraft: draft }, false, 'ui/setComposerDraft'),

  toggleComposer: () => {
    const { isComposerOpen } = get();
    set({ isComposerOpen: !isComposerOpen }, false, 'ui/toggleComposer');
  },

  setSyncStatus: (status) =>
    set({ syncOverallStatus: status }, false, 'ui/setSyncStatus'),
});
