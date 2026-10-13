/**
 * The export membership predicate — ONE definition, two callers (#878).
 *
 * An item may be saved iff its resolved conversation is one the signed-in user
 * is currently in. The STORE, not SQL, is the authority: DMs are threads and
 * their conversations live in the same Zustand map, while the SQLite
 * `conversations` table is a group-key store that keeps rows for orbits you
 * have left. A NULL conversation is an orphan (leaving an orbit deletes its
 * threads and replies but leaves `orbital_media` rows behind) or the
 * uploader's own row before the post exists; neither is exportable.
 *
 * ## Why it is its own module
 *
 * `mediaExportService` enforces it per item (before AND after the download),
 * and `FileLibraryScreen` projects it over a whole page to build the lightbox's
 * `canExport` set — the screen cannot call the service's per-item
 * `isMediaExportAllowed`, which issues a DB round-trip per id, because plan §3
 * requires the lightbox path to stay synchronous and query-free.
 *
 * Before this module the screen carried its own copy and it had already
 * drifted: the copy used `conversations[id]` and so was defeated by a
 * conversation id of `constructor` or `toString`, which resolve to functions
 * through the prototype chain. One definition, with the `hasOwnProperty`
 * guard, is the fix (deferred from the #879 review by Alex).
 *
 * Imports the store and nothing else, so a screen can take it without
 * dragging in the native export module, RNFS or the download service.
 */

import { useAppStore } from '../../stores/useAppStore';

/** True when `conversationId` is a conversation the user is currently in. */
export function isExportableConversation(conversationId: string | null | undefined): boolean {
  if (!conversationId) return false;
  const { conversations } = useAppStore.getState();
  if (conversations === null || typeof conversations !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(conversations, conversationId);
}
