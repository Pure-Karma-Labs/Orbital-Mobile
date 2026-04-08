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
