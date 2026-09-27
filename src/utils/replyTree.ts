/**
 * Reply tree ordering — the single client-side source of display order for a
 * thread's replies (#821).
 *
 * The store keeps replies in an arbitrary, append-ordered list: `replyIdsByThread`
 * order has NO meaning. Every screen that renders replies derives its own order
 * here, from `parentReplyId` + `createdAt`, so a reply always sits under its
 * parent no matter which path put it in the store (REST page, WebSocket push,
 * optimistic send, SQLite hydration).
 *
 * CONTRACT — these functions are TOTAL:
 * - They never throw. Every entry point is wrapped; the degraded result is a
 *   flat, depth-0 list, never an empty one (the app has no ErrorBoundary, so a
 *   throw here would blank the thread screen).
 * - They never log, and they never build a string out of a reply's body,
 *   author or id. Nothing in here can reach telemetry as free text.
 * - They are pure: no store access, no Date.now(), no platform APIs.
 *
 * Ordering rules:
 * - Roots (`parentReplyId == null`) first, then orphan subtrees (parent not
 *   loaded, or self-parent) at depth 0, then any cycle leftovers at depth 0.
 * - Roots, orphans and every sibling list sort by `createdAt`, then by `id`.
 *   A missing or non-finite `createdAt` sorts as 0.
 * - Depth comes from the traversal, never from the stored `depth` hint.
 * - Every distinct input id is emitted exactly once. O(n log n).
 */

/** Minimal shape the tree needs. `Reply` from the store satisfies it. */
export interface ReplyTreeInput {
  id: string;
  parentReplyId: string | null;
  authorId: string;
  createdAt: number;
}

export interface ReplyTreeNode<T extends ReplyTreeInput> {
  reply: T;
  /** Display depth from the traversal (0 = top level). */
  depth: number;
  /** Normalized parent id — kept even when the parent is not loaded. */
  parentId: string | null;
  /** True when the parent is missing, self-referential, or unreachable. */
  orphan: boolean;
  /** Nodes emitted beneath this one. */
  descendantCount: number;
}

export interface ReplyTree<T extends ReplyTreeInput> {
  /** Preorder: the render order. */
  nodes: ReplyTreeNode<T>[];
  byId: Map<string, ReplyTreeNode<T>>;
}

/**
 * How a row should describe its parent.
 * - `none`     — top-level reply, no context line.
 * - `jumpable` — the parent is loaded and rendered.
 * - `orphan`   — the parent is not loaded (unloaded page, or deleted).
 * - `hidden`   — the parent's author is blocked. Rendering "hidden" instead of
 *                the name is also what keeps a blocked username off screen.
 */
export type ParentState = 'none' | 'jumpable' | 'orphan' | 'hidden';

export interface ReplyTreeRow<T extends ReplyTreeInput> {
  reply: T;
  depth: number;
  parentId: string | null;
  parentState: ParentState;
  /** Descendants of this row whose author is not hidden. */
  visibleDescendants: number;
  /** True when this row's subtree is collapsed (its descendants are skipped). */
  collapsed: boolean;
}

export interface VisibleRowsOptions {
  /** Authors whose rows are dropped; their descendants stay. */
  hiddenAuthorIds?: ReadonlySet<string> | null;
  /** Rows whose subtree is skipped. */
  collapsedIds?: ReadonlySet<string> | null;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

function sortKey(reply: ReplyTreeInput): number {
  const v = reply.createdAt;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function compareReplies(a: ReplyTreeInput, b: ReplyTreeInput): number {
  const diff = sortKey(a) - sortKey(b);
  if (diff !== 0) return diff;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function normalizeParentId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Degraded result: input order, everything at depth 0. Used on any throw. */
function flatTree<T extends ReplyTreeInput>(replies: readonly T[]): ReplyTree<T> {
  const nodes: ReplyTreeNode<T>[] = [];
  const byId = new Map<string, ReplyTreeNode<T>>();
  if (!Array.isArray(replies)) return { nodes, byId };
  for (const reply of replies) {
    const id = reply?.id;
    if (typeof id !== 'string' || id.length === 0 || byId.has(id)) continue;
    const node: ReplyTreeNode<T> = {
      reply,
      depth: 0,
      parentId: null,
      orphan: false,
      descendantCount: 0,
    };
    nodes.push(node);
    byId.set(id, node);
  }
  return { nodes, byId };
}

/**
 * Fill `descendantCount` from the preorder depths in one backward pass.
 * A DFS emits each subtree as a contiguous block whose depths never jump by
 * more than +1, so a per-depth accumulator is enough — no recursion, and no
 * second traversal of the children map.
 */
function fillDescendantCounts<T extends ReplyTreeInput>(nodes: ReplyTreeNode<T>[]): void {
  const perDepth: number[] = [];
  for (let i = nodes.length - 1; i >= 0; i--) {
    const d = nodes[i].depth;
    const below = perDepth[d + 1] ?? 0;
    nodes[i].descendantCount = below;
    perDepth[d + 1] = 0;
    perDepth[d] = (perDepth[d] ?? 0) + below + 1;
  }
}

/**
 * Same backward pass, weighting hidden-author rows as 0. Returns a parallel
 * array rather than mutating the nodes: the hidden set is a per-render input,
 * the tree is memoized across renders.
 */
function computeVisibleDescendants<T extends ReplyTreeInput>(
  nodes: readonly ReplyTreeNode<T>[],
  hidden: ReadonlySet<string>,
): number[] {
  const out = new Array<number>(nodes.length).fill(0);
  const perDepth: number[] = [];
  for (let i = nodes.length - 1; i >= 0; i--) {
    const d = nodes[i].depth;
    const below = perDepth[d + 1] ?? 0;
    out[i] = below;
    perDepth[d + 1] = 0;
    const self = hidden.has(nodes[i].reply.authorId) ? 0 : 1;
    perDepth[d] = (perDepth[d] ?? 0) + below + self;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the display tree for a thread's replies.
 *
 * @param replies - Replies in any order, possibly with duplicate ids, missing
 *                  parents, cycles or malformed timestamps.
 */
export function buildReplyTree<T extends ReplyTreeInput>(
  replies: readonly T[],
): ReplyTree<T> {
  try {
    if (!Array.isArray(replies) || replies.length === 0) {
      return { nodes: [], byId: new Map() };
    }

    // Deduplicate by id — last occurrence wins, matching store upsert semantics.
    const inputById = new Map<string, T>();
    for (const reply of replies) {
      if (reply == null || typeof reply !== 'object') continue;
      const id = (reply as { id?: unknown }).id;
      if (typeof id !== 'string' || id.length === 0) continue;
      inputById.set(id, reply);
    }

    const parentById = new Map<string, string | null>();
    const childrenByParent = new Map<string, T[]>();
    const roots: T[] = [];
    const orphans: T[] = [];

    for (const [id, reply] of inputById) {
      const parentId = normalizeParentId(reply.parentReplyId);
      parentById.set(id, parentId);
      if (parentId == null) {
        roots.push(reply);
        continue;
      }
      // Self-parent and unknown parent both render as orphan roots.
      if (parentId === id || !inputById.has(parentId)) {
        orphans.push(reply);
        continue;
      }
      const siblings = childrenByParent.get(parentId);
      if (siblings) siblings.push(reply);
      else childrenByParent.set(parentId, [reply]);
    }

    roots.sort(compareReplies);
    orphans.sort(compareReplies);
    for (const siblings of childrenByParent.values()) siblings.sort(compareReplies);

    const nodes: ReplyTreeNode<T>[] = [];
    const byId = new Map<string, ReplyTreeNode<T>>();

    // Iterative DFS with a visited set: a parent cycle can never loop forever,
    // and a 2000-deep chain can never blow the JS stack.
    const emitSubtree = (start: T, orphanRoot: boolean): void => {
      const stack: Array<{ reply: T; depth: number; orphan: boolean }> = [
        { reply: start, depth: 0, orphan: orphanRoot },
      ];
      while (stack.length > 0) {
        const frame = stack.pop() as { reply: T; depth: number; orphan: boolean };
        const id = frame.reply.id;
        if (byId.has(id)) continue;
        const node: ReplyTreeNode<T> = {
          reply: frame.reply,
          depth: frame.depth,
          parentId: parentById.get(id) ?? null,
          orphan: frame.orphan,
          descendantCount: 0,
        };
        nodes.push(node);
        byId.set(id, node);
        const children = childrenByParent.get(id);
        if (children) {
          // Reverse-push so the earliest sibling is popped first.
          for (let i = children.length - 1; i >= 0; i--) {
            stack.push({ reply: children[i], depth: frame.depth + 1, orphan: false });
          }
        }
      }
    };

    for (const root of roots) emitSubtree(root, false);
    for (const orphan of orphans) {
      if (!byId.has(orphan.id)) emitSubtree(orphan, true);
    }
    // Cycle leftovers: every remaining id is inside (or under) a parent cycle,
    // so no root reaches it. Sorted for determinism, then emitted as orphans.
    const leftovers: T[] = [];
    for (const [id, reply] of inputById) {
      if (!byId.has(id)) leftovers.push(reply);
    }
    if (leftovers.length > 0) {
      leftovers.sort(compareReplies);
      for (const leftover of leftovers) {
        if (!byId.has(leftover.id)) emitSubtree(leftover, true);
      }
    }

    fillDescendantCounts(nodes);
    return { nodes, byId };
  } catch {
    return flatTree(replies);
  }
}

/**
 * Flatten the tree into the rows a list should render.
 *
 * - A hidden (blocked) author's row is dropped; its descendants stay, at their
 *   own depth, and describe their parent as `hidden`.
 * - A collapsed id skips its contiguous subtree.
 */
export function visibleRows<T extends ReplyTreeInput>(
  nodes: readonly ReplyTreeNode<T>[],
  options?: VisibleRowsOptions,
): ReplyTreeRow<T>[] {
  const rows: ReplyTreeRow<T>[] = [];
  try {
    if (!Array.isArray(nodes) || nodes.length === 0) return rows;
    const hidden: ReadonlySet<string> = options?.hiddenAuthorIds ?? EMPTY_SET;
    const collapsed: ReadonlySet<string> = options?.collapsedIds ?? EMPTY_SET;

    const visible =
      hidden.size > 0 ? computeVisibleDescendants(nodes, hidden) : null;

    const nodeById = new Map<string, ReplyTreeNode<T>>();
    for (const node of nodes) nodeById.set(node.reply.id, node);

    // -1 = not skipping. Otherwise every following node deeper than this depth
    // belongs to the collapsed subtree.
    let skipBelowDepth = -1;
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];
      if (skipBelowDepth >= 0) {
        if (node.depth > skipBelowDepth) continue;
        skipBelowDepth = -1;
      }
      if (hidden.has(node.reply.authorId)) continue;

      let parentState: ParentState;
      if (node.parentId == null) {
        parentState = 'none';
      } else if (node.orphan) {
        parentState = 'orphan';
      } else {
        const parent = nodeById.get(node.parentId);
        if (!parent) parentState = 'orphan';
        else if (hidden.has(parent.reply.authorId)) parentState = 'hidden';
        else parentState = 'jumpable';
      }

      const isCollapsed = collapsed.has(node.reply.id);
      rows.push({
        reply: node.reply,
        depth: node.depth,
        parentId: node.parentId,
        parentState,
        visibleDescendants: visible ? visible[index] : node.descendantCount,
        collapsed: isCollapsed,
      });
      // Collapse only applies to a row that is actually rendered — a stale
      // collapsed id for a now-hidden author must not swallow its children.
      if (isCollapsed) skipBelowDepth = node.depth;
    }
    return rows;
  } catch {
    return rows;
  }
}

/**
 * Ids of the loaded ancestors of `id`, nearest first.
 * Stops at the first unloaded parent and cannot loop on a parent cycle.
 */
export function ancestorIds<T extends ReplyTreeInput>(
  byId: ReadonlyMap<string, ReplyTreeNode<T>>,
  id: string,
): string[] {
  const out: string[] = [];
  try {
    if (!byId || typeof byId.get !== 'function') return out;
    const seen = new Set<string>([id]);
    let cursor = byId.get(id)?.parentId ?? null;
    while (cursor != null && !seen.has(cursor)) {
      seen.add(cursor);
      const parent = byId.get(cursor);
      if (!parent) break;
      out.push(cursor);
      cursor = parent.parentId;
    }
    return out;
  } catch {
    return out;
  }
}
