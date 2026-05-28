import type { StateCreator } from 'zustand';
import type { AppState, Contact, ContactsSlice } from '../../types/store';

export const createContactsSlice: StateCreator<
  AppState,
  [['zustand/devtools', never]],
  [],
  ContactsSlice
> = (set, get) => ({
  // Initial state
  contacts: {},

  // Actions
  setContacts: (contacts) => {
    const map: Record<string, Contact> = {};
    for (const c of contacts) {
      map[c.id] = c;
    }
    set({ contacts: map }, false, 'contacts/setContacts');
  },

  mergeContacts: (incoming) => {
    const { contacts } = get();
    const merged = { ...contacts };
    for (const c of incoming) {
      const existing = merged[c.id];
      merged[c.id] = {
        id: c.id,
        username: c.username ?? existing?.username ?? null,
        displayName: c.displayName ?? existing?.displayName ?? null,
        avatarPath: c.avatarPath ?? existing?.avatarPath ?? null,
        conversationIds: [
          ...new Set([
            ...(existing?.conversationIds ?? []),
            ...(c.conversationIds ?? []),
          ]),
        ],
      };
    }
    set({ contacts: merged }, false, 'contacts/mergeContacts');
  },

  upsertContact: (contact) => {
    const { contacts } = get();
    set(
      { contacts: { ...contacts, [contact.id]: contact } },
      false,
      'contacts/upsertContact',
    );
  },

  removeContact: (id) => {
    const { contacts } = get();
    const updated = { ...contacts };
    delete updated[id];
    set({ contacts: updated }, false, 'contacts/removeContact');
  },
});
