/**
 * Tests for `abortable` (#878).
 *
 * The property that matters: a JOINER stops waiting while the shared download
 * CONTINUES. `downloadAndDecryptMedia` de-duplicates concurrent callers, so a
 * second caller's own signal is never wired into the transfer — aborting the
 * export must therefore abandon the wait without touching the download that
 * another page may still be showing a spinner for.
 */

import { ExportAbortError, abortable, isExportAbortError } from '../abortable';

describe('abortable', () => {
  it('is the identity function with no signal', () => {
    const source = Promise.resolve('x');
    expect(abortable(source)).toBe(source);
  });

  it('resolves with the source value when nothing aborts', async () => {
    const controller = new AbortController();
    await expect(abortable(Promise.resolve('path'), controller.signal)).resolves.toBe(
      'path',
    );
  });

  it("rejects with the source's own error when the source fails", async () => {
    const controller = new AbortController();
    const boom = new Error('transport died');
    await expect(abortable(Promise.reject(boom), controller.signal)).rejects.toBe(boom);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let sourceSettled = false;
    const source = new Promise<string>((resolve) => {
      setTimeout(() => {
        sourceSettled = true;
        resolve('late');
      }, 0);
    });

    await expect(abortable(source, controller.signal)).rejects.toBeInstanceOf(
      ExportAbortError,
    );
    expect(sourceSettled).toBe(false);
  });

  // -------------------------------------------------------------------------
  // The reason this module exists
  // -------------------------------------------------------------------------

  it('lets the joiner stop waiting while the shared download continues', async () => {
    const controller = new AbortController();

    let resolveShared!: (value: string) => void;
    const shared = new Promise<string>((resolve) => {
      resolveShared = resolve;
    });
    /** Flipped only by the shared promise settling — our stand-in download. */
    let sharedSettledWith: string | null = null;
    shared.then((v) => {
      sharedSettledWith = v;
    });

    const joined = abortable(shared, controller.signal);

    controller.abort();

    await expect(joined).rejects.toBeInstanceOf(ExportAbortError);
    // The abort did NOT settle the shared promise: the download is still going.
    expect(sharedSettledWith).toBeNull();

    // And it still completes normally — the owner of the download, which may
    // be a lightbox page mid-spinner, sees it finish.
    resolveShared('/media/abc.jpg');
    await expect(shared).resolves.toBe('/media/abc.jpg');
    expect(sharedSettledWith).toBe('/media/abc.jpg');
  });

  it('absorbs a later rejection of an abandoned source (no unhandled rejection)', async () => {
    const controller = new AbortController();
    let rejectShared!: (e: unknown) => void;
    const shared = new Promise<string>((_resolve, reject) => {
      rejectShared = reject;
    });

    const joined = abortable(shared, controller.signal);
    controller.abort();
    await expect(joined).rejects.toBeInstanceOf(ExportAbortError);

    rejectShared(new Error('download aborted by its owner'));
    // If the rejection were unhandled, Node would warn and (under --ci) the
    // run would be noisy; awaiting a tick is enough for it to surface.
    await expect(shared).rejects.toThrow('download aborted by its owner');
  });

  it('ignores an abort that arrives after the source resolved', async () => {
    const controller = new AbortController();
    const joined = abortable(Promise.resolve('done'), controller.signal);
    await expect(joined).resolves.toBe('done');
    // No throw, no second settle.
    controller.abort();
    await expect(joined).resolves.toBe('done');
  });

  it('reports a transport abort as the TRANSPORT error, not ExportAbortError', async () => {
    // There is deliberately no retry-once rule: the shared download aborting
    // because its OWNER walked away is a `failed`, which the user can retry.
    const controller = new AbortController();
    const transportAbort = new Error('Download aborted');
    await expect(
      abortable(Promise.reject(transportAbort), controller.signal),
    ).rejects.toBe(transportAbort);
    expect(isExportAbortError(transportAbort)).toBe(false);
  });

  it('works with a signal that only supports onabort', async () => {
    // Belt and braces for a hand-rolled double or a leaner polyfill.
    const listeners: Array<() => void> = [];
    const fakeSignal = {
      aborted: false,
      onabort: null as unknown,
      addEventListener: undefined,
      removeEventListener: undefined,
    } as unknown as AbortSignal;

    const joined = abortable(
      new Promise<string>(() => {
        /* never settles */
      }),
      fakeSignal,
    );

    // `abortable` installed itself on onabort.
    expect(typeof fakeSignal.onabort).toBe('function');
    listeners.push(() => (fakeSignal.onabort as () => void)());
    listeners[0]();

    await expect(joined).rejects.toBeInstanceOf(ExportAbortError);
  });
});

describe('isExportAbortError', () => {
  it('recognises its own class and nothing else', () => {
    expect(isExportAbortError(new ExportAbortError())).toBe(true);
    expect(isExportAbortError(new Error('export aborted'))).toBe(false);
    expect(isExportAbortError(null)).toBe(false);
    expect(isExportAbortError('ExportAbortError')).toBe(false);
  });

  it('carries a name but no identifying detail', () => {
    const e = new ExportAbortError();
    expect(e.name).toBe('ExportAbortError');
    expect(e.message).toBe('export aborted');
  });
});
