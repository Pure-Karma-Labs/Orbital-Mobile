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

/**
 * True when this author is blocked — the one store-backed author check shared
 * by the export path and the thread-gallery hydrate path.
 *
 * ## The "bulk only" carve-out is RETIRED
 *
 * This docblock used to read "BULK ONLY — a blocked author's media stays
 * saveable one item at a time (Alex 2026-10-09)". That carve-out is SUPERSEDED
 * by Alex's 2026-10-16 addendum on #897: author exclusion now travels on ONE
 * channel, `GetAllMediaOptions.excludeAuthorIds`, and every list surface
 * applies it — the File Library grid, `threadService.hydrateMediaFromLocal`
 * and the bulk-export snapshot alike. With the grid and the gallery filtered
 * there is no LIST surface left to save a blocked author's item FROM, so what
 * the single-item path keeps (see below) is a deliberate RETAINED exemption,
 * not a live carve-out that widens exposure.
 *
 * ## What the per-item re-asks are still for
 *
 * A snapshot — or a hydrated gallery index — is taken once, and a run can last
 * minutes. Blocking someone part-way through has to stop their media from
 * being saved by the items still queued (#889 review). Catching a block that
 * lands MID-RUN is now the sole reason `mediaExportService` re-asks per item,
 * at three points, all of them on the BULK paths:
 *
 *   - `exportMediaItemInBulk` — the per-item gate, before the download.
 *   - `prepareWrite` — the access re-check after the download, behind its
 *     `rejectBlockedAuthor` option.
 *   - `isBulkExportAllowedAt` — called by `flushStagedBulkDocuments` for every
 *     staged iOS document immediately before the picker.
 *
 * The SINGLE-ITEM save path (`saveMediaItem`) deliberately keeps
 * `rejectBlockedAuthor: false` — kept and documented by Alex on 2026-10-16,
 * not an oversight — so the per-item re-ask covers the bulk paths only. Those
 * are the only two `rejectBlockedAuthor` call sites.
 *
 * A NULL author is NOT treated as blocked. That is the same deliberate
 * fail-open as the SQL's `COALESCE(…, '')`: a deleted reply leaves its media
 * with no resolvable author, and refusing those would make a blocked-user
 * list silently un-saveable for unrelated rows.
 */
export function isBlockedAuthor(authorId: string | null | undefined): boolean {
  if (!authorId) return false;
  const { blockedUserIds } = useAppStore.getState();
  return Array.isArray(blockedUserIds) && blockedUserIds.includes(authorId);
}
