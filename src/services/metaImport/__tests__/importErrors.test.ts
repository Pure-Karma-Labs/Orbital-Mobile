/**
 * `importErrors.ts` — the #926 §4.7 disposition table, row by row.
 *
 * The errors are the REAL ones: `api/errors`' classes built from the exact
 * bodies the backend sends (so `ConflictError.importRefusal` and
 * `ValidationError.reason` are produced by the shipped parsers, not by a
 * fixture that agrees with this suite), and `ArchiveReaderError` from the
 * archive reader's own class through the sanctioned `archiveAccess` door.
 *
 * `importCrypto` is factory-mocked: it reaches `useAppStore` → MMKV/nitro, and
 * what matters here is the disposition → verdict mapping, not the crypto
 * classifier's own `instanceof` table (which `importCrypto`'s suite owns).
 *
 * No fake timers anywhere (#834): `ctx.nowMs` is the injected clock.
 */

import { ArchiveReaderError } from '../archiveAccess';
import { classifyImportCryptoError } from '../../crypto/importCrypto';
import {
  AuthError,
  ConflictError,
  NetworkError,
  NotFoundError,
  QuotaExceededError,
  RateLimitError,
  ServerError,
  ValidationError,
} from '../../api/errors';
import {
  ARCHIVE_BUSY_MAX_ATTEMPTS,
  ARCHIVE_BUSY_RETRY_MS,
  CHUNK_ALLOWANCE_PAUSE_MS,
  CLIENT_BUG_THRESHOLD,
  DEFAULT_RATE_LIMIT_PAUSE_MS,
  IMPORT_TERMINAL_CODES,
  NETWORK_STAGE_LADDER_MS,
  classifyImportFailure,
  isImportCancellation,
  isPayloadTooLarge,
  isRunStale,
} from '../importErrors';

import type { ImportFailureContext, ImportStage } from '../importErrors';

jest.mock('../../crypto/importCrypto', () => ({
  classifyImportCryptoError: jest.fn(() => null),
}));

/** The factory mock's own handle, for per-test dispositions. */
const cryptoVerdict = classifyImportCryptoError as unknown as jest.Mock;

const NOW = 1_700_000_000_000;
const RUN = 7;

function ctx(overrides: Partial<ImportFailureContext> = {}): ImportFailureContext {
  return {
    stage: 'batch',
    run: RUN,
    currentRun: () => RUN,
    nowMs: NOW,
    ...overrides,
  };
}

/** A 409 body exactly as `importService.js` composes it. */
function refusal(code: string, details: Record<string, unknown> = {}): ConflictError {
  return new ConflictError(
    JSON.stringify({ error: 'IMPORT_REFUSED', details: { code, ...details } }),
  );
}

function validation(code?: string): ValidationError {
  return new ValidationError(
    400,
    JSON.stringify(
      code === undefined
        ? { error: 'VALIDATION_ERROR' }
        : { error: 'VALIDATION_ERROR', details: { code } },
    ),
  );
}

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  cryptoVerdict.mockReset();
  cryptoVerdict.mockReturnValue(null);
});

// ---------------------------------------------------------------------------
// Rule 0
// ---------------------------------------------------------------------------

describe('rule 0 — the run token comes first', () => {
  it('collapses a would-be terminal crypto error to cancelled when the run moved on', () => {
    cryptoVerdict.mockReturnValue('terminal-for-run');

    const verdict = classifyImportFailure(new Error('Import key session is closed'), {
      stage: 'crypto',
      run: RUN,
      currentRun: () => RUN + 1,
    });

    expect(verdict).toEqual({ kind: 'cancelled' });
    // Nothing about the error was even inspected.
    expect(cryptoVerdict).not.toHaveBeenCalled();
  });

  it('collapses to cancelled when the run controller is aborted', () => {
    const controller = new AbortController();
    controller.abort();

    expect(
      classifyImportFailure(
        new ArchiveReaderError('ARCHIVE_SESSION_CLOSED'),
        ctx({ signal: controller.signal }),
      ),
    ).toEqual({ kind: 'cancelled' });
  });

  it('isRunStale reports both shapes and nothing else', () => {
    const controller = new AbortController();
    expect(isRunStale({ run: RUN, currentRun: () => RUN })).toBe(false);
    expect(isRunStale({ run: RUN, currentRun: () => RUN, signal: controller.signal })).toBe(false);
    expect(isRunStale({ run: RUN, currentRun: () => RUN + 1 })).toBe(true);
    controller.abort();
    expect(isRunStale({ run: RUN, currentRun: () => RUN, signal: controller.signal })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe('cancellation', () => {
  it('matches the upload sentinel, the transcoder code and the archive reader', () => {
    expect(isImportCancellation(new Error('Upload cancelled'))).toBe(true);
    expect(isImportCancellation({ code: 'ECANCELLED' })).toBe(true);
    expect(isImportCancellation(new ArchiveReaderError('ECANCELLED'))).toBe(true);
  });

  it('does not match an ordinary error, a string or null', () => {
    expect(isImportCancellation(new Error('Upload failed'))).toBe(false);
    expect(isImportCancellation('ECANCELLED')).toBe(false);
    expect(isImportCancellation(null)).toBe(false);
  });

  it('classifies every cancellation shape as cancelled', () => {
    for (const e of [
      new Error('Upload cancelled'),
      { code: 'ECANCELLED' },
      new ArchiveReaderError('ECANCELLED'),
    ]) {
      expect(classifyImportFailure(e, ctx({ stage: 'media-chunk' }))).toEqual({
        kind: 'cancelled',
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------

describe('crypto dispositions', () => {
  it('pauses on key_pending and never fails the item', () => {
    cryptoVerdict.mockReturnValue('retryable-pause');
    expect(classifyImportFailure(new Error('pending wrap'), ctx({ stage: 'crypto' }))).toEqual({
      kind: 'pause',
      cause: 'key_pending',
    });
  });

  it('stops the run on terminal-for-run', () => {
    cryptoVerdict.mockReturnValue('terminal-for-run');
    expect(classifyImportFailure(new Error('key changed'), ctx({ stage: 'crypto' }))).toEqual({
      kind: 'job-terminal',
      code: 'CRYPTO',
    });
  });

  it('falls through to the HTTP taxonomy when the crypto verdict is null', () => {
    cryptoVerdict.mockReturnValue(null);
    expect(classifyImportFailure(new NotFoundError(), ctx())).toEqual({
      kind: 'job-terminal',
      code: 'IMPORTS_UNAVAILABLE',
    });
  });
});

// ---------------------------------------------------------------------------
// Staged media
// ---------------------------------------------------------------------------

describe('ImportMediaStagedError', () => {
  const staged = (cause: unknown) => {
    const e = new Error('Import media upload failed after chunks were staged');
    e.name = 'ImportMediaStagedError';
    (e as Error & { cause: unknown }).cause = cause;
    return e;
  };

  it('is the backstop arm: a wrapper that reaches here never retries in place', () => {
    // `importMedia` unwraps the wrapper itself and never rethrows it — an id
    // binding is rebound and retried there, an import refusal is rebound and
    // reported as the `refused` outcome. So this arm answers a wrapper that
    // arrived with nothing to unwrap, and `file-fresh-id` is what the runner
    // charges to the item. What it must never be is `retry-same-call`: the
    // server holds this attempt's envelope and IV under that `media_id`.
    for (const cause of [new NetworkError(), new ConflictError(), new RateLimitError()]) {
      expect(classifyImportFailure(staged(cause), ctx({ stage: 'media-chunk' }))).toEqual({
        kind: 'file-fresh-id',
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Archive reader
// ---------------------------------------------------------------------------

describe('archive reader dispositions', () => {
  it('retries ARCHIVE_BUSY in place, then pauses', () => {
    expect(
      classifyImportFailure(new ArchiveReaderError('ARCHIVE_BUSY'), ctx({ stage: 'archive' })),
    ).toEqual({
      kind: 'retry-same-call',
      delayMs: ARCHIVE_BUSY_RETRY_MS,
    });
    expect(
      classifyImportFailure(
        new ArchiveReaderError('ARCHIVE_BUSY'),
        ctx({ stage: 'archive', busyAttempt: ARCHIVE_BUSY_MAX_ATTEMPTS - 1 }),
      ),
    ).toEqual({ kind: 'retry-same-call', delayMs: ARCHIVE_BUSY_RETRY_MS });
    expect(
      classifyImportFailure(
        new ArchiveReaderError('ARCHIVE_BUSY'),
        ctx({ stage: 'archive', busyAttempt: ARCHIVE_BUSY_MAX_ATTEMPTS }),
      ),
    ).toEqual({ kind: 'pause', cause: 'archive_retry' });
  });

  it.each(['ARCHIVE_READ_FAILED', 'ARCHIVE_STAGING_UNAVAILABLE', 'ARCHIVE_NO_SPACE'] as const)(
    'pauses with the archive ladder on %s',
    (code) => {
      expect(
        classifyImportFailure(new ArchiveReaderError(code), ctx({ stage: 'archive' })),
      ).toEqual({
        kind: 'pause',
        cause: 'archive_retry',
      });
    },
  );

  it.each(['ARCHIVE_ACCESS_LOST', 'ARCHIVE_CHANGED', 'ARCHIVE_NOT_SEEKABLE'] as const)(
    'asks for a re-pick on %s only while nothing has been created',
    (code) => {
      expect(
        classifyImportFailure(
          new ArchiveReaderError(code),
          ctx({ stage: 'archive', createdItems: 0 }),
        ),
      ).toEqual({ kind: 'pause', cause: 'needs_repick' });
      expect(
        classifyImportFailure(
          new ArchiveReaderError(code),
          ctx({ stage: 'archive', createdItems: 1 }),
        ),
      ).toEqual({ kind: 'job-terminal', code: 'ARCHIVE' });
    },
  );

  it.each(['ARCHIVE_CORRUPT', 'ARCHIVE_SESSION_CLOSED', 'ARCHIVE_INTERNAL'] as const)(
    'stops the run on %s',
    (code) => {
      expect(
        classifyImportFailure(new ArchiveReaderError(code), ctx({ stage: 'archive' })),
      ).toEqual({
        kind: 'job-terminal',
        code: 'ARCHIVE',
      });
    },
  );

  it('treats PICKER_BUSY reaching a running job as terminal, never a pause', () => {
    expect(
      classifyImportFailure(new ArchiveReaderError('PICKER_BUSY'), ctx({ stage: 'archive' })),
    ).toEqual({
      kind: 'job-terminal',
      code: 'ARCHIVE',
    });
  });

  it('does not treat an unknown archive code as an archive verdict', () => {
    const e = new ArchiveReaderError('ARCHIVE_CORRUPT');
    (e as unknown as { code: string }).code = 'ARCHIVE_FROM_A_NEWER_BUILD';
    expect(classifyImportFailure(e, ctx({ stage: 'archive' }))).toEqual({
      kind: 'item-failed',
      code: 'IMPORT_ITEM_INVALID',
    });
  });
});

// ---------------------------------------------------------------------------
// 429
// ---------------------------------------------------------------------------

describe('rate limiting', () => {
  it("pauses until the server's own Retry-After", () => {
    expect(classifyImportFailure(new RateLimitError({ get: () => '5' }), ctx())).toEqual({
      kind: 'pause',
      cause: 'rate_limited',
      untilMs: NOW + 5_000,
    });
  });

  it('falls back to a fixed wait when the header is absent or unusable', () => {
    expect(classifyImportFailure(new RateLimitError(), ctx())).toEqual({
      kind: 'pause',
      cause: 'rate_limited',
      untilMs: NOW + DEFAULT_RATE_LIMIT_PAUSE_MS,
    });
    expect(
      classifyImportFailure(
        new RateLimitError({ get: () => 'Wed, 21 Oct 2026 07:28:00 GMT' }),
        ctx(),
      ),
    ).toEqual({
      kind: 'pause',
      cause: 'rate_limited',
      untilMs: NOW + DEFAULT_RATE_LIMIT_PAUSE_MS,
    });
  });
});

// ---------------------------------------------------------------------------
// 409 IMPORT_REFUSED
// ---------------------------------------------------------------------------

describe('409 IMPORT_REFUSED', () => {
  it('adopts the session named by IMPORT_IN_PROGRESS', () => {
    expect(
      classifyImportFailure(
        refusal('IMPORT_IN_PROGRESS', { import_id: SESSION_ID }),
        ctx({ stage: 'start' }),
      ),
    ).toEqual({ kind: 'adopt-session', importId: SESSION_ID });
  });

  it('passes the open session SOURCE through without judging it', () => {
    expect(
      classifyImportFailure(
        refusal('IMPORT_IN_PROGRESS', { import_id: SESSION_ID, source: 'instagram' }),
        ctx({ stage: 'start' }),
      ),
    ).toEqual({ kind: 'adopt-session', importId: SESSION_ID, source: 'instagram' });
  });

  it('adopts without an id on the insert race, so the runner re-reads the preflight', () => {
    expect(classifyImportFailure(refusal('IMPORT_IN_PROGRESS'), ctx({ stage: 'start' }))).toEqual({
      kind: 'adopt-session',
    });
  });

  it('omits the source key entirely when the server named none', () => {
    const verdict = classifyImportFailure(
      refusal('IMPORT_IN_PROGRESS', { import_id: SESSION_ID }),
      ctx({ stage: 'start' }),
    );
    // Absent, not `undefined`-valued: the runner distinguishes "not stated"
    // from "stated and different" only by presence, and both mean foreign.
    expect(verdict).toEqual({ kind: 'adopt-session', importId: SESSION_ID });
    expect('source' in verdict).toBe(false);
  });

  it('restarts the session on IMPORT_CLOSED + abandoned', () => {
    expect(classifyImportFailure(refusal('IMPORT_CLOSED', { status: 'abandoned' }), ctx())).toEqual(
      {
        kind: 'session-restart',
      },
    );
  });

  it('finishes locally on IMPORT_CLOSED + completed', () => {
    expect(
      classifyImportFailure(
        refusal('IMPORT_CLOSED', { status: 'completed' }),
        ctx({ stage: 'complete' }),
      ),
    ).toEqual({
      kind: 'finish-completed',
    });
  });

  it.each([
    ['closed', 'closed'],
    ['open (a server bug)', 'open'],
    ['a status this build does not know', 'brand-new'],
  ])('is terminal on IMPORT_CLOSED + %s', (_label, status) => {
    expect(classifyImportFailure(refusal('IMPORT_CLOSED', { status }), ctx())).toEqual({
      kind: 'job-terminal',
      code: 'SESSION_CLOSED',
    });
  });

  it('is terminal on IMPORT_CLOSED with no status at all', () => {
    expect(classifyImportFailure(refusal('IMPORT_CLOSED'), ctx())).toEqual({
      kind: 'job-terminal',
      code: 'SESSION_CLOSED',
    });
  });

  it.each(['start', 'batch', 'media-complete'] as const)(
    'is terminal on IMPORT_ALLOWANCE_EXCEEDED at stage %s',
    (stage) => {
      expect(classifyImportFailure(refusal('IMPORT_ALLOWANCE_EXCEEDED'), ctx({ stage }))).toEqual({
        kind: 'job-terminal',
        code: 'ALLOWANCE',
      });
    },
  );

  it('treats a chunk-route allowance refusal as its own backed-off pause', () => {
    expect(
      classifyImportFailure(refusal('IMPORT_ALLOWANCE_EXCEEDED'), ctx({ stage: 'media-chunk' })),
    ).toEqual({
      kind: 'pause',
      // NOT `network`: nothing about reaching the server failed, the foreground
      // wake-up must not shorten this wait, and its budget ends in `ALLOWANCE`.
      // Riding the `network` cause also made it budget-exempt in the runner,
      // which is how a persistent refusal retried for ever.
      cause: 'allowance_wait',
      untilMs: NOW + CHUNK_ALLOWANCE_PAUSE_MS,
    });
  });

  it('parks a file on IMPORT_QUOTA_EXCEEDED at media complete, and fails it on the end-of-run pass', () => {
    expect(
      classifyImportFailure(refusal('IMPORT_QUOTA_EXCEEDED'), ctx({ stage: 'media-complete' })),
    ).toEqual({
      kind: 'park-file',
    });
    expect(
      classifyImportFailure(
        refusal('IMPORT_QUOTA_EXCEEDED'),
        ctx({ stage: 'media-complete', endOfRunPass: true }),
      ),
    ).toEqual({ kind: 'item-failed', code: 'QUOTA' });
  });

  it('is terminal on a start-time IMPORT_QUOTA_EXCEEDED', () => {
    expect(
      classifyImportFailure(refusal('IMPORT_QUOTA_EXCEEDED'), ctx({ stage: 'start' })),
    ).toEqual({
      kind: 'job-terminal',
      code: 'ORBIT_FULL',
    });
  });

  it('is terminal on a refusal code this build does not know', () => {
    expect(classifyImportFailure(refusal('IMPORT_SOMETHING_NEW'), ctx())).toEqual({
      kind: 'job-terminal',
      code: 'REFUSED',
    });
  });

  it('mints a fresh id for a plain 409 on a media route, and stops elsewhere', () => {
    expect(classifyImportFailure(new ConflictError(), ctx({ stage: 'media-chunk' }))).toEqual({
      kind: 'file-fresh-id',
    });
    expect(classifyImportFailure(new ConflictError(), ctx({ stage: 'batch' }))).toEqual({
      kind: 'job-terminal',
      code: 'REFUSED',
    });
  });
});

// ---------------------------------------------------------------------------
// 401 / 403 / 404
// ---------------------------------------------------------------------------

describe('auth and not-found', () => {
  it('stops the run on a 401 — client.ts has already cleared the tokens', () => {
    expect(classifyImportFailure(new AuthError(401), ctx())).toEqual({
      kind: 'job-terminal',
      code: 'AUTH',
    });
  });

  it('stops the run on a 403 off the media routes', () => {
    for (const stage of ['start', 'batch', 'complete'] as ImportStage[]) {
      expect(classifyImportFailure(new AuthError(403), ctx({ stage }))).toEqual({
        kind: 'job-terminal',
        code: 'FORBIDDEN',
      });
    }
  });

  it('answers a media-route 403 with a fresh id, on either media stage', () => {
    // The rebind BUDGET is `importMedia`'s and is spent there (one rebind,
    // then `fresh-id-exhausted`), so this arm carries no attempt count of its
    // own: there is one owner, and the runner charges this verdict to the item.
    for (const stage of ['media-chunk', 'media-complete'] as const) {
      expect(classifyImportFailure(new AuthError(403), ctx({ stage }))).toEqual({
        kind: 'file-fresh-id',
      });
    }
  });

  it('reads a 404 as "imports are not available here"', () => {
    expect(classifyImportFailure(new NotFoundError(), ctx({ stage: 'complete' }))).toEqual({
      kind: 'job-terminal',
      code: 'IMPORTS_UNAVAILABLE',
    });
  });
});

// ---------------------------------------------------------------------------
// 413
// ---------------------------------------------------------------------------

describe('413', () => {
  const QUOTA_BODY = JSON.stringify({
    details: {
      quota: {
        storage_bytes: 1,
        max_bytes: 2,
        file_count: 1,
        max_files: 2,
        storage_percent: 50,
        files_percent: 50,
        evictable_bytes: 0,
      },
    },
  });

  it('isPayloadTooLarge is the bare-413 test, not a quota test', () => {
    expect(isPayloadTooLarge(new QuotaExceededError())).toBe(true);
    expect(isPayloadTooLarge(new QuotaExceededError(QUOTA_BODY))).toBe(false);
    expect(isPayloadTooLarge(new NetworkError())).toBe(false);
  });

  it('halves the batch on a bare 413', () => {
    expect(classifyImportFailure(new QuotaExceededError(), ctx({ stage: 'batch' }))).toEqual({
      kind: 'batch-halve',
    });
  });

  it('does not halve on a bare 413 off the batch route', () => {
    expect(classifyImportFailure(new QuotaExceededError(), ctx({ stage: 'media-chunk' }))).toEqual({
      kind: 'job-terminal',
      code: 'REFUSED',
    });
  });

  it('charges a real quota 413 to the file on a media route', () => {
    expect(
      classifyImportFailure(new QuotaExceededError(QUOTA_BODY), ctx({ stage: 'media-complete' })),
    ).toEqual({
      kind: 'item-failed',
      code: 'QUOTA',
    });
    expect(
      classifyImportFailure(new QuotaExceededError(QUOTA_BODY), ctx({ stage: 'batch' })),
    ).toEqual({
      kind: 'job-terminal',
      code: 'ORBIT_FULL',
    });
  });
});

// ---------------------------------------------------------------------------
// 400 VALIDATION_ERROR
// ---------------------------------------------------------------------------

describe('400 VALIDATION_ERROR', () => {
  it('halves on IMPORT_BATCH_TOO_LARGE', () => {
    expect(classifyImportFailure(validation('IMPORT_BATCH_TOO_LARGE'), ctx())).toEqual({
      kind: 'batch-halve',
    });
  });

  it('fails the file on IMPORT_MEDIA_TYPE_UNSUPPORTED', () => {
    expect(
      classifyImportFailure(
        validation('IMPORT_MEDIA_TYPE_UNSUPPORTED'),
        ctx({ stage: 'media-chunk' }),
      ),
    ).toEqual({
      kind: 'item-failed',
      code: 'IMPORT_MEDIA_UNSUPPORTED',
    });
  });

  it('calls IMPORT_DECLARED_INVALID our own bug', () => {
    expect(
      classifyImportFailure(validation('IMPORT_DECLARED_INVALID'), ctx({ stage: 'start' })),
    ).toEqual({
      kind: 'job-terminal',
      code: 'CLIENT_BUG',
    });
  });

  it('fails the item on an unnamed 400, and stops the run at the third one', () => {
    expect(classifyImportFailure(validation(), ctx({ clientBugCount: 0 }))).toEqual({
      kind: 'item-failed',
      code: 'IMPORT_ITEM_INVALID',
    });
    expect(
      classifyImportFailure(validation(), ctx({ clientBugCount: CLIENT_BUG_THRESHOLD - 2 })),
    ).toEqual({
      kind: 'item-failed',
      code: 'IMPORT_ITEM_INVALID',
    });
    expect(
      classifyImportFailure(validation(), ctx({ clientBugCount: CLIENT_BUG_THRESHOLD - 1 })),
    ).toEqual({
      kind: 'job-terminal',
      code: 'CLIENT_BUG',
    });
  });

  it('reads INVALID_CONTENT_CLASS (a TOP-LEVEL error, no details.code) as an unnamed 400', () => {
    const e = new ValidationError(400, JSON.stringify({ error: 'INVALID_CONTENT_CLASS' }));
    expect(e.reason).toBeUndefined();
    expect(classifyImportFailure(e, ctx({ stage: 'media-chunk' }))).toEqual({
      kind: 'item-failed',
      code: 'IMPORT_ITEM_INVALID',
    });
  });
});

// ---------------------------------------------------------------------------
// Network / 5xx
// ---------------------------------------------------------------------------

describe('network and server errors', () => {
  it.each(['start', 'batch', 'media-complete', 'complete'] as const)(
    'climbs the ladder then pauses at stage %s',
    (stage) => {
      NETWORK_STAGE_LADDER_MS.forEach((delayMs, attempt) => {
        expect(
          classifyImportFailure(new NetworkError(), ctx({ stage, stageAttempt: attempt })),
        ).toEqual({
          kind: 'retry-same-call',
          delayMs,
        });
      });
      expect(
        classifyImportFailure(
          new NetworkError(),
          ctx({ stage, stageAttempt: NETWORK_STAGE_LADDER_MS.length }),
        ),
      ).toEqual({ kind: 'pause', cause: 'network' });
    },
  );

  it('pauses a media-chunk failure immediately — uploadMedia already retried', () => {
    expect(
      classifyImportFailure(new NetworkError(), ctx({ stage: 'media-chunk', stageAttempt: 0 })),
    ).toEqual({
      kind: 'pause',
      cause: 'network',
    });
  });

  it('treats a 5xx like a network failure', () => {
    expect(
      classifyImportFailure(new ServerError(500), ctx({ stage: 'complete', stageAttempt: 1 })),
    ).toEqual({
      kind: 'retry-same-call',
      delayMs: NETWORK_STAGE_LADDER_MS[1],
    });
  });
});

// ---------------------------------------------------------------------------
// Unknown errors and silence
// ---------------------------------------------------------------------------

describe('errors with no arm', () => {
  it('charges an unknown error to the item on an item-scoped stage', () => {
    expect(
      classifyImportFailure(new TypeError('x is not a function'), ctx({ stage: 'batch' })),
    ).toEqual({
      kind: 'item-failed',
      code: 'IMPORT_ITEM_INVALID',
    });
  });

  it('stops the run on a run-scoped stage, where no item owns the failure', () => {
    for (const stage of ['start', 'complete'] as ImportStage[]) {
      expect(classifyImportFailure(new TypeError('boom'), ctx({ stage }))).toEqual({
        kind: 'job-terminal',
        code: 'CLIENT_BUG',
      });
    }
  });

  it('never throws, whatever it is handed', () => {
    for (const e of [undefined, null, 0, '', 'nope', [], {}, Symbol('s')]) {
      expect(() => classifyImportFailure(e, ctx())).not.toThrow();
    }
  });
});

describe('silence', () => {
  it('logs nothing while classifying the whole table', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});

    const cases: unknown[] = [
      new Error('Upload cancelled'),
      new ArchiveReaderError('ARCHIVE_BUSY'),
      new ArchiveReaderError('ARCHIVE_CHANGED'),
      new RateLimitError({ get: () => '3' }),
      refusal('IMPORT_CLOSED', { status: 'abandoned' }),
      refusal('IMPORT_QUOTA_EXCEEDED'),
      new AuthError(403),
      new NotFoundError(),
      new QuotaExceededError(),
      validation('IMPORT_BATCH_TOO_LARGE'),
      new NetworkError(),
      new ServerError(502),
      new TypeError('boom'),
    ];
    for (const stage of [
      'start',
      'batch',
      'media-chunk',
      'media-complete',
      'complete',
      'archive',
    ] as ImportStage[]) {
      for (const e of cases) classifyImportFailure(e, ctx({ stage }));
    }

    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();

    warn.mockRestore();
    error.mockRestore();
    log.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// The terminal registry
// ---------------------------------------------------------------------------

describe('IMPORT_TERMINAL_CODES', () => {
  it('carries OTHER_IMPORT_OPEN', () => {
    // #996: one open session per member per orbit ACROSS sources (B#352), so
    // "yours is busy with the other platform" needs a code of its own — the
    // member's next move is that import, not this one.
    expect(Object.prototype.hasOwnProperty.call(IMPORT_TERMINAL_CODES, 'OTHER_IMPORT_OPEN')).toBe(
      true,
    );
  });

  it('is never reached by the classifier, only by the runner', () => {
    // The classifier is SOURCE-BLIND by design: the server's refusal is
    // `IMPORT_IN_PROGRESS` whichever source is open, and only the runner
    // knows which source it is importing. A classifier arm that returned
    // this code would be deciding with information it does not have.
    const everyRefusal = [
      refusal('IMPORT_IN_PROGRESS', { import_id: SESSION_ID, source: 'instagram' }),
      refusal('IMPORT_IN_PROGRESS'),
      refusal('IMPORT_CLOSED', { status: 'closed' }),
      refusal('IMPORT_ALLOWANCE_EXCEEDED'),
      refusal('IMPORT_QUOTA_EXCEEDED'),
      refusal('IMPORT_NOT_OWNED'),
    ];
    const stages: ImportStage[] = [
      'start',
      'batch',
      'media-chunk',
      'media-complete',
      'complete',
      'archive',
      'crypto',
    ];
    for (const stage of stages) {
      for (const error of everyRefusal) {
        const verdict = classifyImportFailure(error, ctx({ stage }));
        if (verdict.kind === 'job-terminal') {
          expect(verdict.code).not.toBe('OTHER_IMPORT_OPEN');
        }
      }
    }
  });
});
