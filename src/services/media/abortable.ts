/**
 * `abortable` — stop WAITING on a promise without cancelling it.
 *
 * ## Why this exists
 *
 * `downloadAndDecryptMedia(id, signal)` de-duplicates concurrent callers
 * through an in-flight map (`mediaDownloadService.ts`): the FIRST caller's
 * signal is the one wired into the transfer, and every later caller is handed
 * that same promise. A joiner's own `AbortSignal` is therefore ignored — its
 * `abort()` does nothing, and it waits for a download it cannot stop.
 *
 * Export needs the opposite shape. When the user closes the lightbox, logs out
 * or cancels a bulk run, the EXPORT must stop immediately, but the download it
 * joined may be feeding a visible page and must keep going. So this wrapper
 * races our signal against the shared promise and rejects with a distinct
 * sentinel, leaving the shared download completely untouched.
 *
 * ## Deliberately NOT here: a retry-once rule
 *
 * The mirror case — the shared download aborts because its OWNER walked away,
 * while we are still joined — surfaces here as that download's own abort
 * rejection, not as `ExportAbortError`. The export reports `failed` and the
 * user can tap Save again (which will start a fresh download, since the
 * in-flight entry is gone by then). An automatic retry was considered and
 * rejected: it hides a real failure behind a second silent attempt, and the
 * abort we are reacting to may be a wipe.
 */

/**
 * Rejection raised when OUR signal fires. Distinct from a transport abort so
 * the caller can tell "the user cancelled the save" from "the download died".
 */
export class ExportAbortError extends Error {
  constructor() {
    super('export aborted');
    this.name = 'ExportAbortError';
    // Required for `instanceof` to survive the TS->ES5 class downlevel.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isExportAbortError(e: unknown): e is ExportAbortError {
  return e instanceof ExportAbortError;
}

/**
 * Subscribe to a signal's abort, returning an unsubscribe function.
 *
 * React Native's `AbortController` polyfill exposes `addEventListener`, but
 * the `onabort` property form is the only member guaranteed by every
 * implementation this code could meet (including a hand-rolled test double),
 * so fall back to it rather than silently never aborting.
 */
function onAbortOnce(signal: AbortSignal, handler: () => void): () => void {
  if (typeof signal.addEventListener === 'function') {
    signal.addEventListener('abort', handler, { once: true });
    return () => {
      if (typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', handler);
      }
    };
  }
  const previous = signal.onabort;
  signal.onabort = function onabort(
    this: AbortSignal,
    ...args: Parameters<NonNullable<AbortSignal['onabort']>>
  ) {
    if (typeof previous === 'function') previous.apply(this, args);
    handler();
  };
  return () => {
    signal.onabort = previous;
  };
}

/**
 * Resolve/reject with `source`, but reject with `ExportAbortError` the moment
 * `signal` aborts. `source` is never cancelled, and its eventual rejection is
 * always handled so it cannot surface as an unhandled rejection.
 *
 * With no signal this is the identity function — nothing is wrapped, so a
 * caller that does not need cancellation pays nothing.
 */
export function abortable<T>(
  source: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return source;

  if (signal.aborted) {
    // Nobody will ever read `source`, so its rejection must be absorbed here.
    source.catch(() => {});
    return Promise.reject(new ExportAbortError());
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const unsubscribe = onAbortOnce(signal, () => {
      if (settled) return;
      settled = true;
      // The shared download keeps running — we just stop waiting for it.
      source.catch(() => {});
      reject(new ExportAbortError());
    });

    source.then(
      (value) => {
        unsubscribe();
        if (settled) return;
        settled = true;
        resolve(value);
      },
      (error: unknown) => {
        unsubscribe();
        if (settled) return;
        settled = true;
        reject(error);
      },
    );
  });
}
