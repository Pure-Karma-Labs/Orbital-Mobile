/**
 * FTS5 search repository — full-text search over threads and replies.
 *
 * Uses FTS5 MATCH queries against thread_fts and reply_fts virtual tables.
 * Returns deduplicated thread IDs ranked by relevance (thread matches first,
 * then reply-surfaced parent threads).
 *
 * All inputs are sanitized to prevent FTS5 parse errors from special
 * characters (*, ", NOT, NEAR, etc.) by wrapping in escaped double quotes.
 */

import { queryMany } from '../queryHelpers';
import { isDatabaseInitialized } from '../connection';

/**
 * Sanitize user input for FTS5 MATCH queries.
 * Wraps in double quotes to treat as a literal phrase,
 * preventing parse errors from special chars (*, ", NOT, etc).
 */
export function sanitizeFtsQuery(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) return '""';
  return `"${trimmed.replace(/"/g, '""')}"`;
}

/**
 * Search threads and replies within a conversation.
 * Returns deduplicated thread IDs ranked by relevance.
 * Reply matches surface their parent thread ID.
 */
export function searchAll(conversationId: string, query: string): string[] {
  if (!isDatabaseInitialized()) return [];
  if (query.trim().length === 0) return [];

  const sanitized = sanitizeFtsQuery(query);

  // Search thread content
  const threadMatches = queryMany<{ thread_id: string; rank: number }>(
    `SELECT thread_id, rank
     FROM thread_fts
     WHERE thread_fts MATCH ? AND conversation_id = ?
     ORDER BY rank`,
    [sanitized, conversationId],
  );

  // Search reply content -- return parent thread IDs
  const replyMatches = queryMany<{ thread_id: string; rank: number }>(
    `SELECT thread_id, MIN(rank) as rank
     FROM reply_fts
     WHERE reply_fts MATCH ? AND conversation_id = ?
     GROUP BY thread_id
     ORDER BY rank`,
    [sanitized, conversationId],
  );

  // Deduplicate: thread matches first, then reply-surfaced threads
  const seen = new Set<string>();
  const result: string[] = [];

  for (const m of threadMatches) {
    if (!seen.has(m.thread_id)) {
      seen.add(m.thread_id);
      result.push(m.thread_id);
    }
  }
  for (const m of replyMatches) {
    if (!seen.has(m.thread_id)) {
      seen.add(m.thread_id);
      result.push(m.thread_id);
    }
  }

  return result;
}
