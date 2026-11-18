/**
 * The one `Thread` fixture builder (#927).
 *
 * `Thread` is a wide, required-field store type: before this existed, every
 * suite that needed one either hand-wrote all thirteen fields or wrote a short
 * object literal and cast it `as Thread`, which told the compiler to stop
 * checking. Adding a required field (`isImport`, `importSource`, `mediaCount`)
 * then failed only in the honest suites and silently produced rows missing
 * those fields in the casting ones — rows whose shape no longer matched
 * anything the service layer can produce.
 *
 * So: build fixtures here, never with a cast. A missing field is a compile
 * error in exactly one file, and every suite's rows stay shaped like the real
 * mappers' output.
 *
 * The defaults describe an ORDINARY, server-confirmed, text-only orbit thread.
 * Anything a test cares about it should pass explicitly — including
 * `isImport: true`, which no default will ever set.
 */

import type { Thread } from '../types/store';

/** Fixed epoch ms (2024-01-01T00:00:00.000Z) so fixtures never depend on now. */
export const THREAD_FIXTURE_CREATED_AT = 1704067200000;

export function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-1',
    conversationId: 'conv-1',
    authorId: 'author-1',
    authorUsername: 'alice',
    title: 'Thread title',
    body: 'Thread body',
    contentType: 'text',
    pinned: false,
    replyCount: 0,
    lastReplyAt: null,
    createdAt: THREAD_FIXTURE_CREATED_AT,
    updatedAt: THREAD_FIXTURE_CREATED_AT,
    syncStatus: 'synced',
    isImport: false,
    importSource: null,
    mediaCount: 0,
    ...overrides,
  };
}
