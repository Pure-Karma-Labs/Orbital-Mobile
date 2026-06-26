import { queryMany } from '../queryHelpers';
import { isDatabaseInitialized } from '../connection';

const FTS5_RESERVED = new Set(['NOT', 'AND', 'OR', 'NEAR']);

/**
 * Sanitize user input for FTS5 MATCH with prefix support on the last token.
 */
export function sanitizeFtsQuery(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) return '""';

  const cleaned = trimmed.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const tokens = cleaned
    .split(/\s+/)
    .filter(t => t.length > 0 && !FTS5_RESERVED.has(t.toUpperCase()));

  if (tokens.length === 0) return '""';
  if (tokens.length === 1 && tokens[0].length < 2) return '""';

  return tokens
    .map((t, i) => (i === tokens.length - 1 ? `"${t}"*` : `"${t}"`))
    .join(' ');
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
  if (sanitized === '""') return [];

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
