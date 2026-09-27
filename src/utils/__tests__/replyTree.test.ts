/**
 * replyTree — display order for a thread's replies (#821).
 *
 * The bug this file guards: a reply to any non-last post used to render at the
 * bottom of the thread. Order is now derived from parentReplyId + createdAt, so
 * these tests treat the INPUT order as meaningless on purpose.
 *
 * The functions are contractually total (no throws, no logs), so the degenerate
 * cases below assert a returned value rather than a rejection.
 */

import {
  ancestorIds,
  buildReplyTree,
  visibleRows,
  type ReplyTreeInput,
} from '../replyTree';

type R = ReplyTreeInput;

function reply(
  id: string,
  parentReplyId: string | null,
  createdAt: number,
  authorId = 'author-1',
): R {
  return { id, parentReplyId, authorId, createdAt };
}

/** `id:depth` for compact order assertions. */
function shape(nodes: ReadonlyArray<{ reply: R; depth: number }>): string[] {
  return nodes.map((n) => `${n.reply.id}:${n.depth}`);
}

describe('buildReplyTree — order', () => {
  it('nests a reply under its parent instead of at the bottom (#821)', () => {
    // Store order is exactly what the old append produced: A, B, then A1
    // (the confirmed nested reply) landing last.
    const { nodes } = buildReplyTree([
      reply('A', null, 1000),
      reply('B', null, 2000),
      reply('A1', 'A', 3000),
    ]);

    expect(shape(nodes)).toEqual(['A:0', 'A1:1', 'B:0']);
  });

  it('produces identical output for shuffled input', () => {
    const replies = [
      reply('A', null, 1000),
      reply('A1', 'A', 1500),
      reply('A1a', 'A1', 1600),
      reply('A2', 'A', 1700),
      reply('B', null, 2000),
      reply('B1', 'B', 2100),
    ];
    const expected = shape(buildReplyTree(replies).nodes);

    const shuffles = [
      [5, 0, 3, 1, 4, 2],
      [2, 4, 1, 5, 0, 3],
      [3, 2, 5, 4, 0, 1],
    ];
    for (const order of shuffles) {
      const shuffled = order.map((i) => replies[i]);
      expect(shape(buildReplyTree(shuffled).nodes)).toEqual(expected);
    }
  });

  it('ignores the stored depth hint and uses the traversal depth', () => {
    // messageHandler hardcodes depth 1 on every WebSocket reply.
    const lying = [
      { ...reply('A', null, 1000), depth: 7 },
      { ...reply('A1', 'A', 1100), depth: 1 },
      { ...reply('A1a', 'A1', 1200), depth: 1 },
    ];

    expect(shape(buildReplyTree(lying).nodes)).toEqual(['A:0', 'A1:1', 'A1a:2']);
  });

  it('breaks createdAt ties by id', () => {
    const { nodes } = buildReplyTree([
      reply('c', null, 1000),
      reply('a', null, 1000),
      reply('b', null, 1000),
    ]);

    expect(shape(nodes)).toEqual(['a:0', 'b:0', 'c:0']);
  });

  it('sorts a clamped optimistic child last among its siblings', () => {
    // postReply clamps the optimistic createdAt past the newest sibling.
    const { nodes } = buildReplyTree([
      reply('A', null, 1000),
      reply('A1', 'A', 5000),
      reply('A2', 'A', 5001), // clamped optimistic row
      reply('B', null, 9000),
    ]);

    expect(shape(nodes)).toEqual(['A:0', 'A1:1', 'A2:1', 'B:0']);
  });

  it('emits orphan subtrees after the loaded trees, intact', () => {
    const { nodes } = buildReplyTree([
      reply('A', null, 1000),
      reply('A1', 'A', 1100),
      reply('X', 'not-loaded', 500), // parent on an unloaded page
      reply('X1', 'X', 600),
    ]);

    expect(shape(nodes)).toEqual(['A:0', 'A1:1', 'X:0', 'X1:1']);
    const rows = visibleRows(nodes);
    expect(rows.map((r) => r.parentState)).toEqual([
      'none',
      'jumpable',
      'orphan',
      'jumpable',
    ]);
  });

  it('terminates on a self-parent and on a 2-cycle', () => {
    const selfParent = buildReplyTree([
      reply('A', null, 1000),
      reply('S', 'S', 1100),
    ]);
    expect(shape(selfParent.nodes)).toEqual(['A:0', 'S:0']);
    expect(selfParent.nodes[1].orphan).toBe(true);

    const cycle = buildReplyTree([
      reply('A', null, 1000),
      reply('P', 'Q', 1100),
      reply('Q', 'P', 1200),
    ]);
    // Both cycle members are emitted exactly once, after the real tree.
    expect(cycle.nodes).toHaveLength(3);
    expect(cycle.nodes[0].reply.id).toBe('A');
    expect(new Set(cycle.nodes.map((n) => n.reply.id))).toEqual(
      new Set(['A', 'P', 'Q']),
    );
  });

  it('handles a 2000-deep chain without recursing', () => {
    const chain: R[] = [reply('n0', null, 0)];
    for (let i = 1; i < 2000; i++) {
      chain.push(reply(`n${i}`, `n${i - 1}`, i));
    }

    const { nodes } = buildReplyTree(chain);
    expect(nodes).toHaveLength(2000);
    expect(nodes[1999].depth).toBe(1999);
    expect(nodes[0].descendantCount).toBe(1999);
  });

  it('emits exactly one node per distinct input id', () => {
    const replies = [
      reply('A', null, 1000),
      reply('A1', 'A', 1100),
      reply('A', null, 1000), // duplicate
      reply('X', 'gone', 900),
      reply('S', 'S', 800),
    ];

    const { nodes, byId } = buildReplyTree(replies);
    const distinct = new Set(replies.map((r) => r.id));
    expect(nodes).toHaveLength(distinct.size);
    expect(byId.size).toBe(distinct.size);
  });

  it('counts descendants across the whole subtree', () => {
    const { byId } = buildReplyTree([
      reply('A', null, 1000),
      reply('A1', 'A', 1100),
      reply('A1a', 'A1', 1200),
      reply('A2', 'A', 1300),
      reply('B', null, 2000),
    ]);

    expect(byId.get('A')?.descendantCount).toBe(3);
    expect(byId.get('A1')?.descendantCount).toBe(1);
    expect(byId.get('A1a')?.descendantCount).toBe(0);
    expect(byId.get('B')?.descendantCount).toBe(0);
  });
});

describe('buildReplyTree — degenerate input never throws', () => {
  it('returns an empty tree for an empty array', () => {
    const { nodes, byId } = buildReplyTree([]);
    expect(nodes).toEqual([]);
    expect(byId.size).toBe(0);
  });

  it('deduplicates repeated ids, keeping one row', () => {
    const { nodes } = buildReplyTree([
      reply('A', null, 1000),
      reply('A', null, 4000),
      reply('A', null, 2000),
    ]);
    expect(shape(nodes)).toEqual(['A:0']);
  });

  it('treats NaN and missing createdAt as 0', () => {
    const { nodes } = buildReplyTree([
      reply('later', null, 5000),
      { id: 'nan', parentReplyId: null, authorId: 'a', createdAt: NaN },
      { id: 'missing', parentReplyId: null, authorId: 'a' } as unknown as R,
    ]);

    expect(shape(nodes)).toEqual(['missing:0', 'nan:0', 'later:0']);
  });

  it('tolerates a non-string parent id', () => {
    const { nodes } = buildReplyTree([
      reply('A', null, 1000),
      { id: 'weird', parentReplyId: 42, authorId: 'a', createdAt: 1100 } as unknown as R,
    ]);

    expect(nodes).toHaveLength(2);
    expect(shape(nodes)).toEqual(['A:0', 'weird:0']);
  });

  it('skips null entries and rows without a usable id', () => {
    const { nodes } = buildReplyTree([
      null as unknown as R,
      undefined as unknown as R,
      { id: '', parentReplyId: null, authorId: 'a', createdAt: 1 } as R,
      { id: 7, parentReplyId: null, authorId: 'a', createdAt: 1 } as unknown as R,
      reply('A', null, 1000),
    ]);

    expect(shape(nodes)).toEqual(['A:0']);
  });

  it('returns rows for a non-array argument instead of throwing', () => {
    expect(() =>
      buildReplyTree(undefined as unknown as R[]),
    ).not.toThrow();
    expect(buildReplyTree(undefined as unknown as R[]).nodes).toEqual([]);
  });
});

describe('visibleRows', () => {
  const blocked = 'blocked-author';

  it('drops a blocked author row but keeps its children in place', () => {
    const { nodes } = buildReplyTree([
      reply('A', null, 1000),
      reply('A1', 'A', 1100, blocked),
      reply('A1a', 'A1', 1200),
      reply('B', null, 2000),
    ]);

    const rows = visibleRows(nodes, { hiddenAuthorIds: new Set([blocked]) });

    expect(rows.map((r) => r.reply.id)).toEqual(['A', 'A1a', 'B']);
    // The child keeps its depth and never names the blocked parent.
    const child = rows[1];
    expect(child.depth).toBe(2);
    expect(child.parentState).toBe('hidden');
  });

  it('collapses a subtree, including nested collapse', () => {
    const { nodes } = buildReplyTree([
      reply('A', null, 1000),
      reply('A1', 'A', 1100),
      reply('A1a', 'A1', 1200),
      reply('A2', 'A', 1300),
      reply('B', null, 2000),
    ]);

    expect(
      visibleRows(nodes, { collapsedIds: new Set(['A1']) }).map((r) => r.reply.id),
    ).toEqual(['A', 'A1', 'A2', 'B']);

    expect(
      visibleRows(nodes, { collapsedIds: new Set(['A']) }).map((r) => r.reply.id),
    ).toEqual(['A', 'B']);

    // A collapsed id inside an already-collapsed subtree changes nothing.
    expect(
      visibleRows(nodes, { collapsedIds: new Set(['A', 'A1']) }).map((r) => r.reply.id),
    ).toEqual(['A', 'B']);

    expect(
      visibleRows(nodes, { collapsedIds: new Set(['A1']) })[1].collapsed,
    ).toBe(true);
  });

  it('excludes hidden authors from visibleDescendants', () => {
    const { nodes } = buildReplyTree([
      reply('A', null, 1000),
      reply('A1', 'A', 1100, blocked),
      reply('A1a', 'A1', 1200),
      reply('A2', 'A', 1300),
    ]);

    expect(visibleRows(nodes)[0].visibleDescendants).toBe(3);
    expect(
      visibleRows(nodes, { hiddenAuthorIds: new Set([blocked]) })[0]
        .visibleDescendants,
    ).toBe(2);
  });

  it('labels the parent state of every row', () => {
    const { nodes } = buildReplyTree([
      reply('A', null, 1000),
      reply('A1', 'A', 1100),
      reply('X', 'unloaded', 1200),
    ]);

    const rows = visibleRows(nodes);
    expect(rows.map((r) => [r.reply.id, r.parentState])).toEqual([
      ['A', 'none'],
      ['A1', 'jumpable'],
      ['X', 'orphan'],
    ]);
  });

  it('returns an empty list for degenerate input instead of throwing', () => {
    expect(visibleRows([])).toEqual([]);
    expect(visibleRows(undefined as never)).toEqual([]);
  });
});

describe('ancestorIds', () => {
  it('walks up the parent chain, nearest first', () => {
    const { byId } = buildReplyTree([
      reply('A', null, 1000),
      reply('A1', 'A', 1100),
      reply('A1a', 'A1', 1200),
    ]);

    expect(ancestorIds(byId, 'A1a')).toEqual(['A1', 'A']);
    expect(ancestorIds(byId, 'A')).toEqual([]);
    expect(ancestorIds(byId, 'not-loaded')).toEqual([]);
  });

  it('stops at an unloaded parent', () => {
    const { byId } = buildReplyTree([reply('X', 'gone', 1000)]);
    expect(ancestorIds(byId, 'X')).toEqual([]);
  });

  it('terminates on a cycle', () => {
    const { byId } = buildReplyTree([
      reply('P', 'Q', 1000),
      reply('Q', 'P', 1100),
      reply('S', 'S', 1200),
    ]);

    expect(() => ancestorIds(byId, 'P')).not.toThrow();
    expect(ancestorIds(byId, 'P').length).toBeLessThanOrEqual(2);
    expect(ancestorIds(byId, 'S')).toEqual([]);
  });
});
