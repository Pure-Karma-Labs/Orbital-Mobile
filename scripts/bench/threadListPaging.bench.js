/**
 * #923 "Bounds" — how expensive is one walked page of an orbit's thread list?
 *
 * WHAT IT MEASURES, at 5,000 and 10,000 threads:
 *
 *   1. `buildListRows(threads)` — the full list rebuild: a copy-then-sort on
 *      `compareThreadsByActivityDesc`, then a pass that inserts a `day` row at
 *      every local-day change and a `section` rule between day groups. This is
 *      the work a screen redoes from scratch whenever the thread array changes
 *      identity, which is once per arriving page.
 *   2. `mergeThreads` — the store slice's body: the `{ ...existingThreads }`
 *      entity-map copy, the per-row `resolveRecency`, and the id-union loop
 *      (`Set` of existing ids + `[...existingIds, ...newIds]`). Measured as a
 *      100-row page merged into a list that already holds 5,000 / 10,000 rows.
 *   3. The two together — the real per-page cost of the paging walk: merge the
 *      page into the store, then rebuild the rows the list renders.
 *   4. `createThreadListRowsCache()` — the cache the two list screens now call
 *      instead of `buildListRows`, measured on all three of its paths:
 *        - `cache: +100 page (path 2)` — a cache primed with the whole list,
 *          then handed those same objects plus one 100-row page. THIS IS THE
 *          NUMBER THAT MATTERS: it is what a page landing costs now.
 *        - `cache: same rows (path 1)` — a cache primed with the whole list,
 *          then handed a NEW array holding the same objects, which is what
 *          every `threads` map write produces for a list it did not touch.
 *        - `cache: reply lands (path 3)` — one element replaced by a copy with
 *          a newer `lastReplyAt`, so the prefix scan stops mid-array and the
 *          cache falls through to a full rebuild.
 *      Each cached call ADVANCES the cache, so every timed repetition consumes
 *      a cache primed OUTSIDE the timed region (see `runPooledCase`).
 *
 *   Two extra `diag:` rows split (1) into copy+sort and day-grouping, because
 *   a cache of SORTED THREADS removes only the first of the two while a cache
 *   of finished ROWS removes both — the numbers decide which one is worth
 *   building.
 *
 *   The 100-row page is shaped like a real walked page: the first 10 rows are
 *   ids the list ALREADY holds (the overlap the walk produces by construction,
 *   which exercises `resolveRecency`'s existing-row branch) and the other 90
 *   are new ids that the union loop has to append.
 *
 * HAND-TRANSCRIBED, NOT IMPORTED. Hermes has no `require` and the repo carries
 * no esbuild/babel CLI in `node_modules/.bin`, so every function below was
 * copied by hand from the TypeScript sources with the types stripped and NO
 * other change. Each one carries a comment naming its source file and lines.
 * Sources (as of this commit):
 *   - src/utils/threadListRows.ts
 *   - src/utils/threadActivity.ts
 *   - src/utils/formatPostTimestamp.ts
 *   - src/stores/slices/threadsSlice.ts
 *   - src/testUtils/makeThread.ts (fixture shape only)
 * If any of those change, re-transcribe before trusting a number from here.
 * TWO SELF-CHECKS are printed at the top of every run, to catch a botched
 * transcription before any number is believed:
 *   1. the row-key sequence for a small fixed fixture, so day grouping, the
 *      between-groups-only `section` rule, and NaN-sorts-last are visible by
 *      eye;
 *   2. the transcribed cache against the transcribed `buildListRows` over the
 *      exact inputs of the four cached cases — same rows, key for key, or the
 *      cached numbers mean nothing. It prints PASS/FAIL per case and the first
 *      differing index on a failure.
 *
 * THESE NUMBERS ARE A LOWER BOUND. This runs the Mac's arm64 Hermes (or Node's
 * V8) on a desktop CPU with no RN bridge, no React reconciliation and no
 * FlatList work. A phone's Hermes is roughly 3-8x slower, so a budget decision
 * wants the number here multiplied by that factor before it is compared with a
 * frame budget.
 *
 * METHOD. Deterministic LCG fixtures (never Math.random), 3 warmup iterations
 * then 10 timed iterations per case, min/median/mean reported in ms. Timing is
 * `Date.now()` on both VMs: Hermes under `-O` exposes no `performance`, and
 * using V8's `performance.now()` for only one leg would make the legs
 * incomparable. Because `Date.now()` has 1 ms resolution, each timed iteration
 * runs a calibrated number of repetitions (printed as `reps`) and divides.
 * The input array is re-shuffled (deterministically, outside the timed region)
 * before every iteration, so no iteration ever sorts an already-sorted array.
 *
 * RE-RUN BOTH LEGS (from the Orbital-Mobile checkout root):
 *   ios/Pods/hermes-engine/destroot/bin/hermes -O scripts/bench/threadListPaging.bench.js
 *   node scripts/bench/threadListPaging.bench.js
 */

/* global print */

const out =
  // eslint-disable-next-line no-console -- bench output is stdout; print() is Hermes-only, console.log is the Node leg
  typeof print === 'undefined' ? console.log : print;

const VM = typeof print === 'undefined' ? 'node (V8)' : 'hermes -O';

// ---------------------------------------------------------------------------
// Deterministic PRNG — Lehmer / MINSTD. Every product stays under 2^53, so it
// is exact in doubles on both VMs and two runs are directly comparable.
// ---------------------------------------------------------------------------

function createRandom(seed) {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return function next() {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

// ===========================================================================
// TRANSCRIBED SOURCE — types stripped, logic untouched.
// ===========================================================================

// src/utils/threadActivity.ts lines 52-54
function isValidTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

// src/utils/threadActivity.ts lines 61-69
function compareTimestampDesc(a, b) {
  const aValid = isValidTimestamp(a);
  const bValid = isValidTimestamp(b);
  if (!aValid && !bValid) return 0;
  if (!aValid) return 1;
  if (!bValid) return -1;
  if (a === b) return 0;
  return a > b ? -1 : 1;
}

// src/utils/threadActivity.ts lines 88-98
function threadActivityAt(t) {
  const created = t?.createdAt;
  const replied = t?.lastReplyAt;
  const createdOk = isValidTimestamp(created);
  const repliedOk = isValidTimestamp(replied);

  if (createdOk && repliedOk) return created > replied ? created : replied;
  if (createdOk) return created;
  if (repliedOk) return replied;
  return NaN;
}

// src/utils/threadActivity.ts lines 123-136
function compareThreadsByActivityDesc(a, b) {
  const byActivity = compareTimestampDesc(threadActivityAt(a), threadActivityAt(b));
  if (byActivity !== 0) return byActivity;

  const byCreated = compareTimestampDesc(a?.createdAt, b?.createdAt);
  if (byCreated !== 0) return byCreated;

  const aId = typeof a?.id === 'string' ? a.id : '';
  const bId = typeof b?.id === 'string' ? b.id : '';
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

// src/utils/threadActivity.ts lines 186-197
function maxTimestamp(a, b) {
  const aOk = isValidTimestamp(a);
  const bOk = isValidTimestamp(b);

  if (aOk && bOk) return a > b ? a : b;
  if (aOk) return a;
  if (bOk) return b;
  return null;
}

// src/utils/formatPostTimestamp.ts lines 39-52
const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

// src/utils/formatPostTimestamp.ts lines 103-123
function toParts(timestamp, zone = 'local') {
  if (!Number.isFinite(timestamp)) return null;

  const date = new Date(timestamp);
  const ms = date.getTime();
  if (Number.isNaN(ms)) return null;

  const utc = zone === 'utc';
  const rawHour = utc ? date.getUTCHours() : date.getHours();
  const hour12 = rawHour % 12 === 0 ? 12 : rawHour % 12;
  const minute = utc ? date.getUTCMinutes() : date.getMinutes();

  return {
    monthIndex: utc ? date.getUTCMonth() : date.getMonth(),
    day: utc ? date.getUTCDate() : date.getDate(),
    year: utc ? date.getUTCFullYear() : date.getFullYear(),
    hour12,
    minute: minute.toString().padStart(2, '0'),
    meridiem: rawHour < 12 ? 'AM' : 'PM',
  };
}

// src/utils/formatPostTimestamp.ts lines 149-151
function resolveNow(now) {
  return Number.isFinite(now) ? now : Date.now();
}

// src/utils/formatPostTimestamp.ts lines 126-133
function isCurrentYear(year, now) {
  const reference = new Date(resolveNow(now));
  // resolveNow only rules out non-finite values; a finite-but-unrenderable one
  // (1e20) still yields a NaN year, which matches no year at all.
  const referenceYear = reference.getFullYear();
  if (Number.isNaN(referenceYear)) return false;
  return year === referenceYear;
}

// src/utils/formatPostTimestamp.ts lines 139-142
function startOfPreviousLocalDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1).getTime();
}

// src/utils/formatPostTimestamp.ts lines 154-156
function shortDate(parts) {
  return `${MONTHS_SHORT[parts.monthIndex]} ${parts.day}`;
}

// src/utils/formatPostTimestamp.ts lines 173-181
function dayBucket(timestamp, now) {
  const key = localDayKey(timestamp);
  if (key === '') return null;

  const reference = resolveNow(now);
  if (key === localDayKey(reference)) return 'today';
  if (key === localDayKey(startOfPreviousLocalDay(reference))) return 'yesterday';
  return 'other';
}

// src/utils/formatPostTimestamp.ts lines 281-290
function formatDayLabel(timestamp, now = Date.now()) {
  const parts = toParts(timestamp);
  if (parts === null) return '';

  const bucket = dayBucket(timestamp, now);
  if (bucket === 'today') return 'Today';
  if (bucket === 'yesterday') return 'Yesterday';
  if (isCurrentYear(parts.year, now)) return shortDate(parts);
  return `${shortDate(parts)}, ${parts.year}`;
}

// src/utils/formatPostTimestamp.ts lines 440-447
function localDayKey(timestamp) {
  const parts = toParts(timestamp);
  if (parts === null) return '';

  const month = String(parts.monthIndex + 1).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  return `${parts.year}-${month}-${day}`;
}

// src/utils/threadListRows.ts lines 37-43
function buildListRows(threads) {
  if (threads.length === 0) {
    return [];
  }

  return groupByDay([...threads].sort(compareThreadsByActivityDesc));
}

// src/utils/threadListRows.ts lines 46-74
function groupByDay(sorted) {
  const rows = [];
  let lastDayKey = null;
  let groupIndex = 0;

  for (const thread of sorted) {
    const activityTime = threadActivityAt(thread);
    const dayKey = localDayKey(activityTime);
    // An unrenderable timestamp has no day, so it opens no group and closes
    // none: it joins whatever group it lands in. Letting '' through would both
    // render a bare `───  ───` and split a real day in two, re-emitting its
    // `day-<key>` (a duplicate FlatList key) and an extra section row.
    if (dayKey !== '' && dayKey !== lastDayKey) {
      if (lastDayKey !== null) {
        rows.push({ type: 'section', key: `section-${groupIndex}` });
        groupIndex++;
      }
      rows.push({
        type: 'day',
        label: formatDayLabel(activityTime),
        key: `day-${dayKey}`,
      });
      lastDayKey = dayKey;
    }
    rows.push({ type: 'thread', thread, key: `thread-${thread.id}` });
  }

  return rows;
}

// src/utils/threadListRows.ts lines 108-145
function createThreadListRowsCache() {
  let lastInput = [];
  let lastSorted = [];
  let lastRows = [];

  return function rowsFor(threads) {
    if (threads.length === 0) {
      lastInput = threads;
      lastSorted = [];
      lastRows = [];
      return lastRows;
    }

    // Path 1 and path 2 share one scan: walk the previous input against the
    // new one and stop at the first difference.
    const prefixLength = Math.min(lastInput.length, threads.length);
    let i = 0;
    while (i < prefixLength && lastInput[i] === threads[i]) i++;

    if (i === lastInput.length && i === threads.length) {
      lastInput = threads;
      return lastRows;
    }

    if (i === lastInput.length && i > 0) {
      const appended = threads.slice(i).sort(compareThreadsByActivityDesc);
      lastSorted = mergeSorted(lastSorted, appended);
      lastRows = groupByDay(lastSorted);
      lastInput = threads;
      return lastRows;
    }

    lastSorted = [...threads].sort(compareThreadsByActivityDesc);
    lastRows = groupByDay(lastSorted);
    lastInput = threads;
    return lastRows;
  };
}

// src/utils/threadListRows.ts lines 148-159
/* eslint-disable no-shadow -- transcribed verbatim: `out` is the source's local name, and the print helper of that name is not used in here */
function mergeSorted(left, right) {
  const out = new Array(left.length + right.length);
  let a = 0;
  let b = 0;
  let o = 0;
  while (a < left.length && b < right.length) {
    out[o++] = compareThreadsByActivityDesc(left[a], right[b]) <= 0 ? left[a++] : right[b++];
  }
  while (a < left.length) out[o++] = left[a++];
  while (b < right.length) out[o++] = right[b++];
  return out;
}
/* eslint-enable no-shadow */

// src/stores/slices/threadsSlice.ts lines 43-52
function resolveRecency(incoming, existing, authoritative) {
  const resolved = authoritative
    ? maxTimestamp(incoming.lastReplyAt, null)
    : maxTimestamp(existing?.lastReplyAt, incoming.lastReplyAt);
  return resolved === incoming.lastReplyAt ? incoming : { ...incoming, lastReplyAt: resolved };
}

/**
 * src/stores/slices/threadsSlice.ts lines 106-142 — the `mergeThreads` action
 * body. Zustand's `get()` and `set()` are the only things changed: `get()`
 * becomes the `state` argument and `set()` becomes the returned object, so the
 * entity-map copy, the `resolveRecency` loop, the `Set` id union and the
 * `[...existingIds, ...newIds]` concat are all still inside the measurement.
 */
function mergeThreads(state, conversationId, threads, options) {
  const authoritative = options?.authoritativeRecency === true;
  const { threads: existingThreads, threadIdsByConversation } = state;
  const updatedThreads = { ...existingThreads };
  for (const t of threads) {
    updatedThreads[t.id] = resolveRecency(t, existingThreads[t.id], authoritative);
  }

  const existingIds = threadIdsByConversation[conversationId] ?? [];
  const listed = new Set(existingIds);
  const newIds = [];
  for (const t of threads) {
    // `listed` is updated as we go: a page that repeats an id within itself
    // must count once, not twice.
    if (!listed.has(t.id)) {
      listed.add(t.id);
      newIds.push(t.id);
    }
  }

  const next = {
    threads: updatedThreads,
    threadIdsByConversation:
      newIds.length === 0
        ? threadIdsByConversation
        : {
            ...threadIdsByConversation,
            [conversationId]: [...existingIds, ...newIds],
          },
  };

  return { state: next, gained: newIds.length };
}

// ===========================================================================
// FIXTURES — the real `Thread` field set (src/testUtils/makeThread.ts 26-46).
// ===========================================================================

function makeThread(overrides) {
  const t = {
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
    createdAt: 1704067200000,
    updatedAt: 1704067200000,
    syncStatus: 'synced',
    isImport: false,
    importSource: null,
    mediaCount: 0,
  };
  for (const k of Object.keys(overrides)) t[k] = overrides[k];
  return t;
}

const DAY_MS = 86400000;
/** 2022-01-01T00:00:00Z — the start of the ~2-year span the fixture covers. */
const SPAN_START = Date.UTC(2022, 0, 1);
/** Distinct calendar days the fixture spreads over (~2 years). */
const SPAN_DAYS = 730;

/**
 * `count` threads spread over ~2 years of distinct days — roughly the shape of
 * a 5,000-post Facebook import. ~10% carry a `lastReplyAt` NEWER than their
 * `createdAt` (so `threadActivityAt` has to pick), and two rows carry an
 * invalid timestamp (NaN, and the `0` sentinel the SQLite read path produces),
 * which is the case `compareThreadsByActivityDesc` has to sort last and
 * `localDayKey` has to answer `''` for.
 */
function buildThreads(count, seed) {
  const rand = createRandom(seed);
  const threads = new Array(count);
  for (let i = 0; i < count; i++) {
    const dayIndex = Math.floor((i * SPAN_DAYS) / count);
    const createdAt = SPAN_START + dayIndex * DAY_MS + Math.floor(rand() * DAY_MS * 0.9);
    const hasReply = rand() < 0.1;
    threads[i] = makeThread({
      id: `thread-${i}`,
      authorId: `author-${i % 37}`,
      authorUsername: `member${i % 37}`,
      title: `Imported post ${i}`,
      body: `Body text for imported post ${i} — a sentence or two of content.`,
      replyCount: hasReply ? 1 + Math.floor(rand() * 8) : 0,
      lastReplyAt: hasReply ? createdAt + Math.floor(rand() * 30 * DAY_MS) + 1000 : null,
      createdAt,
      updatedAt: createdAt,
      isImport: true,
      importSource: 'facebook',
      mediaCount: rand() < 0.2 ? 1 : 0,
    });
  }
  // A couple of rows with an unusable timestamp, as the API path can produce.
  if (count > 7) {
    threads[7].createdAt = NaN;
    threads[7].lastReplyAt = null;
  }
  if (count > 4242) {
    threads[4242].createdAt = 0;
    threads[4242].lastReplyAt = null;
  }
  return threads;
}

/** In-place Fisher-Yates with the deterministic PRNG. Never timed. */
function shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/** The store state a conversation holds once `count` rows are loaded. */
function buildStoreState(threads, conversationId) {
  const entities = {};
  const ids = new Array(threads.length);
  for (let i = 0; i < threads.length; i++) {
    entities[threads[i].id] = threads[i];
    ids[i] = threads[i].id;
  }
  const byConversation = {};
  byConversation[conversationId] = ids;
  // A real store holds a handful of other conversations too.
  byConversation['conv-other-1'] = [];
  byConversation['conv-other-2'] = [];
  return { threads: entities, threadIdsByConversation: byConversation };
}

/**
 * One walked page: 10 rows the list already holds (the overlap the walk
 * produces by construction) followed by 90 ids the list has never seen.
 */
function buildPage(existingThreads, count, seed) {
  const rand = createRandom(seed);
  const base = existingThreads.length;
  const page = [];
  for (let i = 0; i < 10; i++) {
    const src = existingThreads[Math.floor(rand() * existingThreads.length)];
    page.push(makeThread(src));
  }
  for (let i = 0; i < count - 10; i++) {
    const createdAt = SPAN_START - (i + 1) * DAY_MS - Math.floor(rand() * DAY_MS * 0.9);
    page.push(
      makeThread({
        id: `thread-${base + i}`,
        authorId: `author-${i % 37}`,
        authorUsername: `member${i % 37}`,
        title: `Older imported post ${base + i}`,
        body: `Body text for imported post ${base + i} — a sentence or two.`,
        createdAt,
        updatedAt: createdAt,
        isImport: true,
        importSource: 'facebook',
      }),
    );
  }
  return page;
}

/**
 * The three inputs the cached cases hand a primed cache, for one list size.
 *
 *   base        the array the list already holds, in STORE order (shuffled,
 *               never pre-sorted). Priming a cache with it costs a full
 *               rebuild, which is why priming never happens inside a timed
 *               region.
 *   appended    `base` plus one 100-row page. The first `base.length` elements
 *               are the SAME objects — that is what `mergeThreads` produces,
 *               since it appends ids and leaves existing entities' identities
 *               alone — so the cache takes path 2. The page is OLDER than
 *               everything held, which is the direction the walk pages in and
 *               also the worse of the two merge shapes: every appended row
 *               loses its comparison, so `mergeSorted` compares all the way
 *               down the kept run instead of winning in the first 100.
 *   rewrapped() a NEW array holding exactly the same objects: what every
 *               `threads` map write hands a list it did not touch. Path 1.
 *   replied     the same objects except ONE, swapped for a copy carrying a
 *               newer `lastReplyAt`. The prefix scan stops mid-array, so the
 *               cache falls through to a full rebuild. Path 3.
 */
function buildCacheFixtures(size) {
  const base = shuffle(buildThreads(size, 1337 + size), createRandom(99 + size));

  const rand = createRandom(31337 + size);
  const appended = base.slice();
  for (let i = 0; i < 100; i++) {
    const createdAt = SPAN_START - (i + 1) * DAY_MS - Math.floor(rand() * DAY_MS * 0.9);
    appended.push(
      makeThread({
        id: `page-${i}`,
        authorId: `author-${i % 37}`,
        authorUsername: `member${i % 37}`,
        title: `Older imported post ${i}`,
        body: `Body text for imported post ${i} — a sentence or two.`,
        createdAt,
        updatedAt: createdAt,
        isImport: true,
        importSource: 'facebook',
      }),
    );
  }

  // A reply landing on a row halfway down the array the store holds.
  const repliedIndex = Math.floor(size / 2);
  const replied = base.slice();
  const bumped = makeThread(base[repliedIndex]);
  bumped.lastReplyAt = SPAN_START + (SPAN_DAYS + 1) * DAY_MS;
  bumped.replyCount = base[repliedIndex].replyCount + 1;
  replied[repliedIndex] = bumped;

  return {
    size,
    label: size === 5000 ? '5k' : '10k',
    base,
    appended,
    replied,
    repliedIndex,
    rewrapped: () => base.slice(),
  };
}

// ===========================================================================
// SELF-CHECK — a botched transcription has to be visible before any number is.
// ===========================================================================

function selfCheck() {
  const day15 = (h, m) => new Date(2024, 0, 15, h, m, 0, 0).getTime();
  const day16 = (h, m) => new Date(2024, 0, 16, h, m, 0, 0).getTime();
  const day14 = (h, m) => new Date(2024, 0, 14, h, m, 0, 0).getTime();

  const fixture = [
    makeThread({ id: 'a', createdAt: day15(9, 0) }),
    makeThread({ id: 'b', createdAt: day15(18, 30) }),
    makeThread({ id: 'c', createdAt: day16(8, 0) }),
    // Created on the 14th, replied to on the 16th: groups under the 16th.
    makeThread({ id: 'd', createdAt: day14(10, 0), lastReplyAt: day16(20, 0) }),
    makeThread({ id: 'nan', createdAt: NaN, lastReplyAt: null }),
  ];

  const rows = buildListRows(shuffle(fixture.slice(), createRandom(99)));

  out('SELF-CHECK — buildListRows on a 5-row fixture (2 local days + 1 unrenderable row)');
  out(
    '  expect: day-2024-01-16, d, c, section-0, day-2024-01-15, b, a, thread-nan (last, no day of its own)',
  );
  out('  keys:   ' + rows.map((r) => r.key).join(' | '));
  out(
    '  labels: ' +
      rows
        .filter((r) => r.type === 'day')
        .map((r) => `${r.key}="${r.label}"`)
        .join(' | '),
  );
  out('');
}

/** First index where two row arrays disagree, or -1 when they are identical. */
function firstKeyDifference(a, b) {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    if (a[i].key !== b[i].key) return i;
  }
  return a.length === b.length ? -1 : shared;
}

function keyAt(rows, i) {
  return i < rows.length ? rows[i].key : '(past end)';
}

/**
 * SELF-CHECK 2 — the cache against `buildListRows`, over the exact inputs the
 * four cached cases below are timed on. Path 2 in particular claims that a
 * merge of two sorted runs is the array a full sort would have produced; this
 * is that claim, checked key for key on 5,000 and 10,000 real rows.
 *
 * Each case also records whether the cache returned the PREVIOUS rows array
 * unchanged, which is observable from outside and separates path 1 from the
 * other two. It cannot separate path 2 from path 3 — but a path-2 fixture that
 * quietly fell through to a full rebuild shows up in the table as a
 * rebuild-sized number, which is just as loud.
 */
function selfCheckCache(f5k, f10k) {
  const cases = [
    {
      name: 'path 2 — one walked page (+100) @ 10k',
      prime: f10k.base,
      input: f10k.appended,
      expectReuse: false,
    },
    {
      name: 'path 2 — one walked page (+100) @ 5k',
      prime: f5k.base,
      input: f5k.appended,
      expectReuse: false,
    },
    {
      name: 'path 1 — unrelated store write @ 10k',
      prime: f10k.base,
      input: f10k.rewrapped(),
      expectReuse: true,
    },
    {
      name: 'path 3 — a reply lands @ 10k',
      prime: f10k.base,
      input: f10k.replied,
      expectReuse: false,
    },
  ];

  out('SELF-CHECK 2 — createThreadListRowsCache vs buildListRows over the SAME input');
  out('  a FAIL here invalidates every `cache:` number in the table below.');

  let failures = 0;
  for (const c of cases) {
    const cache = createThreadListRowsCache();
    const primedRows = cache(c.prime);
    const rows = cache(c.input);
    const reference = buildListRows(c.input);
    const diff = firstKeyDifference(rows, reference);
    const reuse = rows === primedRows;
    const ok = diff === -1 && reuse === c.expectReuse;
    if (!ok) failures++;

    out(
      '  ' +
        (ok ? 'PASS' : 'FAIL') +
        '  ' +
        pad(c.name, 38) +
        ' rows=' +
        padLeft(rows.length, 6) +
        '  returns previous array: ' +
        pad(reuse ? 'yes' : 'no', 3) +
        ' (expect ' +
        (c.expectReuse ? 'yes' : 'no') +
        ')',
    );
    if (diff !== -1) {
      out(
        `        first difference at index ${diff}: cache "${keyAt(rows, diff)}" vs ` +
          `buildListRows "${keyAt(reference, diff)}" (lengths ${rows.length} / ${reference.length})`,
      );
    }
  }

  if (failures > 0) {
    out('');
    out('  **************************************************************');
    out(`  *** ${failures} CACHED PATH(S) FAILED — the numbers below are MEANINGLESS ***`);
    out('  **************************************************************');
  } else {
    out('  all four cached paths produce the uncached row sequence exactly.');
  }
  out('');
}

// ===========================================================================
// HARNESS
// ===========================================================================

const WARMUPS = 3;
const ITERATIONS = 10;
/** Target wall time per timed iteration — Date.now() is only 1 ms-resolution. */
const TARGET_MS = 25;
const MAX_REPS = 100000;

/** Kept alive so neither VM can decide a measured call is dead code. */
let sink = 0;

function nowMs() {
  return Date.now();
}

function median(values) {
  const s = values.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function calibrateReps(prepare, run) {
  let reps = 1;
  for (let guard = 0; guard < 24; guard++) {
    const input = prepare(0);
    const t0 = nowMs();
    for (let i = 0; i < reps; i++) sink += run(input);
    const elapsed = nowMs() - t0;
    if (elapsed >= TARGET_MS || reps >= MAX_REPS) return reps;
    const scaled = elapsed <= 0 ? reps * 8 : Math.ceil(reps * (TARGET_MS / elapsed) * 1.25);
    reps = Math.min(MAX_REPS, Math.max(reps + 1, scaled));
  }
  return reps;
}

/**
 * `prepare(i)` builds (or re-shuffles) the input for iteration `i` and is
 * NEVER timed; `run(input)` is the measured operation and returns a number
 * that is folded into `sink`.
 */
function runCase(name, prepare, run) {
  const reps = calibrateReps(prepare, run);

  for (let w = 0; w < WARMUPS; w++) {
    const input = prepare(-1 - w);
    for (let i = 0; i < reps; i++) sink += run(input);
  }

  const samples = [];
  for (let it = 0; it < ITERATIONS; it++) {
    const input = prepare(it);
    const t0 = nowMs();
    for (let i = 0; i < reps; i++) sink += run(input);
    samples.push((nowMs() - t0) / reps);
  }

  return summarize(name, reps, samples);
}

function summarize(name, reps, samples) {
  let total = 0;
  for (const s of samples) total += s;
  return {
    name,
    reps,
    min: Math.min.apply(null, samples),
    median: median(samples),
    mean: total / samples.length,
  };
}

// ---------------------------------------------------------------------------
// POOLED HARNESS — for the cached cases.
//
// A cached call ADVANCES the cache: calling a path-2 cache a second time with
// the same array would take path 1 and measure nothing. So a rep loop cannot
// reuse one primed cache, and the fix is a POOL built by `makePool(reps)`
// before the clock starts — priming costs a full rebuild and must never land
// inside a measurement. `run(pool, i)` is handed the rep index and the pool
// decides what rep `i` consumes. Everything else (3 warmups, >=10 timed
// iterations, calibrated reps, min/median/mean) is identical to `runCase`.
// ---------------------------------------------------------------------------

/**
 * A pool entry for path 2 / path 3 costs a primed cache (a full rebuild, plus
 * the rows it retains), so these cases are capped well below `MAX_REPS`. They
 * cost milliseconds each, so calibration lands at a handful of reps anyway and
 * the cap is only a guard; the chosen count is printed in the `reps` column.
 */
const MAX_POOLED_REPS = 64;

function calibratePooledReps(makePool, run, maxReps) {
  let reps = 1;
  for (let guard = 0; guard < 24; guard++) {
    const pool = makePool(reps);
    const t0 = nowMs();
    for (let i = 0; i < reps; i++) sink += run(pool, i);
    const elapsed = nowMs() - t0;
    if (elapsed >= TARGET_MS || reps >= maxReps) return reps;
    const scaled = elapsed <= 0 ? reps * 8 : Math.ceil(reps * (TARGET_MS / elapsed) * 1.25);
    reps = Math.min(maxReps, Math.max(reps + 1, scaled));
  }
  return reps;
}

function runPooledCase(name, makePool, run, maxReps) {
  const reps = calibratePooledReps(makePool, run, maxReps);

  for (let w = 0; w < WARMUPS; w++) {
    const pool = makePool(reps);
    for (let i = 0; i < reps; i++) sink += run(pool, i);
  }

  const samples = [];
  for (let it = 0; it < ITERATIONS; it++) {
    const pool = makePool(reps); // priming — OUTSIDE the timed region
    const t0 = nowMs();
    for (let i = 0; i < reps; i++) sink += run(pool, i);
    samples.push((nowMs() - t0) / reps);
  }

  return summarize(name, reps, samples);
}

/** A cache primed with `base` — one full rebuild, never timed. */
function primeCache(base) {
  const cache = createThreadListRowsCache();
  cache(base);
  return cache;
}

/**
 * Paths 2 and 3 CHANGE the cache, so each rep gets its own freshly primed one.
 * The input array is shared: every cache in the pool sees the same first call.
 */
function advancingPool(base, input) {
  return function makePool(reps) {
    const caches = new Array(reps);
    for (let i = 0; i < reps; i++) caches[i] = primeCache(base);
    return { caches, input };
  };
}

function runAdvancing(pool, i) {
  return pool.caches[i](pool.input).length;
}

/**
 * Path 1 is the exception: it leaves the cache's rows and sorted list alone
 * (only `lastInput` moves) and the scan it does is the same length every time,
 * so one primed cache serves the whole rep loop — as long as each call is
 * handed a DIFFERENT array object, which is the case being measured. A small
 * ring of same-content arrays does that in constant memory; cycling back to an
 * earlier array is still a new array as far as the cache is concerned, because
 * `lastInput` is whichever array the previous call passed.
 */
const PATH1_RING = 16;

function rewrapPool(base) {
  return function makePool(reps) {
    const cache = primeCache(base);
    const ring = new Array(Math.min(reps, PATH1_RING));
    for (let i = 0; i < ring.length; i++) ring[i] = base.slice();
    return { cache, ring };
  };
}

function runRewrap(pool, i) {
  return pool.cache(pool.ring[i % pool.ring.length]).length;
}

function pad(s, width) {
  let v = String(s);
  while (v.length < width) v += ' ';
  return v;
}

function padLeft(s, width) {
  let v = String(s);
  while (v.length < width) v = ' ' + v;
  return v;
}

function fmt(ms) {
  return ms.toFixed(3);
}

function printTable(results) {
  const nameWidth = Math.max(4, ...results.map((r) => r.name.length));
  out(
    pad('case', nameWidth) +
      '  ' +
      padLeft('min ms', 10) +
      padLeft('median ms', 12) +
      padLeft('mean ms', 10) +
      padLeft('reps/iter', 11),
  );
  out('-'.repeat(nameWidth + 2 + 10 + 12 + 10 + 11));
  for (const r of results) {
    out(
      pad(r.name, nameWidth) +
        '  ' +
        padLeft(fmt(r.min), 10) +
        padLeft(fmt(r.median), 12) +
        padLeft(fmt(r.mean), 10) +
        padLeft(r.reps, 11),
    );
  }
}

// ===========================================================================
// MAIN
// ===========================================================================

function main() {
  out('');
  out(`#923 thread-list paging bench — VM: ${VM}`);
  out(
    `timer: Date.now() (1 ms resolution; performance.now() is ${typeof performance === 'undefined' ? 'absent' : 'present but unused, for leg comparability'})`,
  );
  out(
    `warmups: ${WARMUPS}, timed iterations: ${ITERATIONS}, per-iteration reps calibrated to ~${TARGET_MS} ms`,
  );
  out('NOTE: desktop Hermes/V8 — a device is roughly 3-8x slower, so these are a LOWER bound.');
  out('');

  selfCheck();

  const cacheFixtures5k = buildCacheFixtures(5000);
  const cacheFixtures10k = buildCacheFixtures(10000);
  selfCheckCache(cacheFixtures5k, cacheFixtures10k);

  const CONV = 'conv-1';
  const results = [];

  for (const size of [5000, 10000]) {
    const cached = size === 5000 ? cacheFixtures5k : cacheFixtures10k;
    const threads = buildThreads(size, 1337 + size);
    const shuffleRand = createRandom(4242 + size);
    const label = size === 5000 ? '5k' : '10k';

    results.push(
      runCase(
        `buildListRows @ ${label}`,
        () => shuffle(threads, shuffleRand),
        (input) => buildListRows(input).length,
      ),
    );

    const state = buildStoreState(threads, CONV);
    const page = buildPage(threads, 100, 777 + size);

    results.push(
      runCase(
        `mergeThreads 100 -> ${label}`,
        () => ({ state, page }),
        (input) => mergeThreads(input.state, CONV, input.page, undefined).gained,
      ),
    );

    if (size === 10000) {
      results.push(
        runCase(
          `merge+rebuild (one page) @ ${label}`,
          () => ({ state, page, threads: shuffle(threads, shuffleRand) }),
          (input) => {
            const merged = mergeThreads(input.state, CONV, input.page, undefined);
            return merged.gained + buildListRows(input.threads).length;
          },
        ),
      );

      // Where the rebuild's time actually goes: copy+sort vs the day-grouping
      // pass. A sorted-rows cache only removes the first of the two — and
      // since path 2 re-runs the grouping pass over the whole list, this row
      // is also the floor under the cached page cost above.
      results.push(
        runCase(
          `  diag: copy+sort only @ ${label}`,
          () => shuffle(threads, shuffleRand),
          (input) => [...input].sort(compareThreadsByActivityDesc).length,
        ),
      );
      // The source factored this pass out as `groupByDay`, so the diagnostic
      // calls the transcription directly instead of keeping a second copy.
      const presorted = [...threads].sort(compareThreadsByActivityDesc);
      results.push(
        runCase(
          `  diag: day-group pass only @ ${label}`,
          () => presorted,
          (input) => groupByDay(input).length,
        ),
      );
    }

    // --- the same list through createThreadListRowsCache ---

    // The cached walked page: a primed cache handed those same objects plus a
    // 100-row page. This is what a page landing costs the list now.
    results.push(
      runPooledCase(
        `cache: +100 page (path 2) @ ${label}`,
        advancingPool(cached.base, cached.appended),
        runAdvancing,
        MAX_POOLED_REPS,
      ),
    );

    if (size === 10000) {
      // Every `threads` map write hands this list a new array holding the same
      // objects; path 1 is the reference scan that recognises it.
      results.push(
        runPooledCase(
          `cache: same rows (path 1) @ ${label}`,
          rewrapPool(cached.base),
          runRewrap,
          MAX_REPS,
        ),
      );

      // A reply landing on a row the list holds breaks the prefix, so the
      // cache falls through to a full rebuild: this should cost what
      // `buildListRows @ 10k` costs, and that is the point of printing it.
      results.push(
        runPooledCase(
          `cache: reply lands (path 3) @ ${label}`,
          advancingPool(cached.base, cached.replied),
          runAdvancing,
          MAX_POOLED_REPS,
        ),
      );
    }
  }

  printTable(results);
  out('');
  out(`(checksum ${sink} — folds every measured result so neither VM can elide the work;`);
  out(' it depends on the calibrated rep counts, so the two VMs are NOT expected to agree)');
  out('');
}

main();
