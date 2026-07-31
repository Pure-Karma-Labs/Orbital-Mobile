/**
 * Transport tests for downloadMediaToFile — the RNFS streaming download (#578).
 *
 * These cover the settlement contract, not just the happy path: the vendored
 * fork's iOS Downloader.mm has a path where NO callback fires and the native
 * promise never settles, so every rejection must come from a JS-owned arm of
 * the race.
 */

jest.mock('@dr.pogodin/react-native-fs');

const mockClearTokens = jest.fn().mockResolvedValue(undefined);
const mockGetAccessToken = jest.fn().mockResolvedValue('test-token');

jest.mock('../tokenManager', () => ({
  tokenManager: {
    getAccessToken: (...args: unknown[]) => mockGetAccessToken(...args),
    clearTokens: (...args: unknown[]) => mockClearTokens(...args),
    setTokens: jest.fn().mockResolvedValue(undefined),
    isConfigured: jest.fn().mockReturnValue(false),
    configure: jest.fn(),
  },
}));

import {
  downloadFile,
  stopDownload,
  unlink,
} from '@dr.pogodin/react-native-fs';

import {
  downloadMediaToFile,
  ciphertextByteCeiling,
  mediaDownloadBackstopMs,
  MEDIA_DOWNLOAD_STALL_TIMEOUT_MS,
} from '../media';
import { AuthError, NetworkError, NotFoundError } from '../errors';
import { MAX_CIPHERTEXT_BYTES } from '../../media/mediaLimits';

// ---------------------------------------------------------------------------
// Harness — one controllable "attempt" per downloadFile() call
// ---------------------------------------------------------------------------

interface DownloadOptions {
  fromUrl: string;
  toFile: string;
  headers?: Record<string, string>;
  cacheable?: boolean;
  background?: boolean;
  readTimeout?: number;
  progressInterval?: number;
  resumable?: unknown;
  begin?: (res: { jobId: number; statusCode: number; contentLength: number; headers: Record<string, string> }) => void;
  progress?: (res: { jobId: number; contentLength: number; bytesWritten: number }) => void;
}

interface Attempt {
  jobId: number;
  options: DownloadOptions;
  settle: (result: { statusCode: number; bytesWritten: number; body?: string }) => void;
  fail: (err: Error) => void;
}

let attempts: Attempt[];

function installDownloadHarness(opts: { neverSettles?: boolean } = {}): void {
  attempts = [];
  let nextJobId = 100;
  (downloadFile as jest.Mock).mockImplementation((options: DownloadOptions) => {
    const jobId = nextJobId++;
    let settle!: Attempt['settle'];
    let fail!: Attempt['fail'];
    const promise = new Promise<{ jobId: number; statusCode: number; bytesWritten: number; body?: string }>(
      (resolve, reject) => {
        if (opts.neverSettles) return;
        settle = (r) => resolve({ jobId, ...r });
        fail = reject;
      },
    );
    attempts.push({ jobId, options, settle, fail });
    return { jobId, promise };
  });
}

/**
 * Let the transport reach the point where downloadFile() has been called.
 *
 * Polls on real timers because the 429 path waits out a real backoff before
 * starting the next attempt.
 */
async function nextAttempt(index: number): Promise<Attempt> {
  // Microtask drain first — this is the only mode that works under fake timers.
  for (let i = 0; i < 200 && attempts.length <= index; i++) {
    await Promise.resolve();
  }
  // Real-timer polling for the 429 path, which waits out an actual backoff.
  const deadline = Date.now() + 10_000;
  while (attempts.length <= index) {
    if (Date.now() > deadline) {
      throw new Error(`attempt ${index} was never started`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  return attempts[index];
}

/**
 * Assert a NetworkError whose CAUSE matches `pattern`.
 *
 * Every transport failure surfaces as a NetworkError with a fixed, safe
 * user-facing message; the specific cause lives in `serverMessage` (__DEV__
 * only), which is exactly the disclosure boundary we want.
 */
async function expectNetworkFailure(
  promise: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(NetworkError);
  await promise.catch((err: NetworkError) => {
    expect(err.serverMessage).toMatch(pattern);
  });
}

const MEDIA_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const STAGING = `/tmp/test-cache/${MEDIA_ID}-dl-cipher.bin`;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAccessToken.mockResolvedValue('test-token');
  (unlink as jest.Mock).mockResolvedValue(undefined);
  installDownloadHarness();
});

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

describe('downloadMediaToFile — request shape', () => {
  it('sends the bearer token and the transfer options the plan mandates', async () => {
    const promise = downloadMediaToFile({ mediaId: MEDIA_ID, toFile: STAGING });
    const attempt = await nextAttempt(0);
    attempt.settle({ statusCode: 200, bytesWritten: 4096 });

    await expect(promise).resolves.toEqual({ bytesWritten: 4096 });

    const { options } = attempt;
    expect(options.fromUrl).toContain(`/api/media/${MEDIA_ID}/download`);
    expect(options.toFile).toBe(STAGING);
    expect(options.headers?.Authorization).toBe('Bearer test-token');
    // Android transparently gunzips; a transform would look like an HMAC failure.
    expect(options.headers?.['Accept-Encoding']).toBe('identity');
    // No ciphertext copies in NSURLCache outside the reapers' reach.
    expect(options.cacheable).toBe(false);
    expect(options.background).toBe(false);
    // Stall timeout is the primary guard (iOS's only one).
    expect(options.readTimeout).toBe(MEDIA_DOWNLOAD_STALL_TIMEOUT_MS);
  });

  // The `resumable` option puts iOS on the cancelByProducingResumeData path,
  // which is exactly the no-callback case the settlement contract exists for.
  it('never passes the forbidden `resumable` option', async () => {
    const promise = downloadMediaToFile({ mediaId: MEDIA_ID, toFile: STAGING });
    const attempt = await nextAttempt(0);
    attempt.settle({ statusCode: 200, bytesWritten: 10 });
    await promise;

    expect(attempt.options.resumable).toBeUndefined();
    expect('resumable' in attempt.options).toBe(false);
  });

  it('throws AuthError without starting a download when there is no token', async () => {
    mockGetAccessToken.mockResolvedValue(null);

    await expect(
      downloadMediaToFile({ mediaId: MEDIA_ID, toFile: STAGING }),
    ).rejects.toBeInstanceOf(AuthError);

    expect(downloadFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Destination hygiene
// ---------------------------------------------------------------------------

describe('downloadMediaToFile — destination hygiene', () => {
  it('unlinks the destination before EVERY attempt, not just the first', async () => {
    const promise = downloadMediaToFile({ mediaId: MEDIA_ID, toFile: STAGING });

    const first = await nextAttempt(0);
    expect(unlink).toHaveBeenCalledWith(STAGING);
    const unlinksBeforeRetry = (unlink as jest.Mock).mock.calls.length;

    first.settle({ statusCode: 429, bytesWritten: 12 });

    const second = await nextAttempt(1);
    // A stale non-2xx artifact must not survive into the retry.
    expect((unlink as jest.Mock).mock.calls.length).toBeGreaterThan(unlinksBeforeRetry);

    second.settle({ statusCode: 200, bytesWritten: 4096 });
    await expect(promise).resolves.toEqual({ bytesWritten: 4096 });
  }, 15_000);

  it('clears the destination when the request fails', async () => {
    const promise = downloadMediaToFile({ mediaId: MEDIA_ID, toFile: STAGING });
    const attempt = await nextAttempt(0);
    attempt.settle({ statusCode: 404, bytesWritten: 0, body: '{"error":"MEDIA_EVICTED"}' });

    await expect(promise).rejects.toBeInstanceOf(NotFoundError);
    expect(unlink).toHaveBeenCalledWith(STAGING);
  });

  it('rejects a 200 that wrote nothing', async () => {
    const promise = downloadMediaToFile({ mediaId: MEDIA_ID, toFile: STAGING });
    const attempt = await nextAttempt(0);
    attempt.settle({ statusCode: 200, bytesWritten: 0 });

    await expect(promise).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// Error mapping + 401 handling
// ---------------------------------------------------------------------------

describe('downloadMediaToFile — error mapping', () => {
  it('maps a non-200 status through the shared mapper, forwarding the body', async () => {
    const promise = downloadMediaToFile({ mediaId: MEDIA_ID, toFile: STAGING });
    const attempt = await nextAttempt(0);
    attempt.settle({ statusCode: 404, bytesWritten: 0, body: 'gone' });

    await expect(promise).rejects.toBeInstanceOf(NotFoundError);
  });

  it('clears tokens on 401 via the shared handler and throws AuthError', async () => {
    const promise = downloadMediaToFile({ mediaId: MEDIA_ID, toFile: STAGING });
    const attempt = await nextAttempt(0);
    attempt.settle({ statusCode: 401, bytesWritten: 0 });

    await expect(promise).rejects.toBeInstanceOf(AuthError);
    expect(mockClearTokens).toHaveBeenCalledTimes(1);
  });

  it('does NOT clear tokens on 403', async () => {
    const promise = downloadMediaToFile({ mediaId: MEDIA_ID, toFile: STAGING });
    const attempt = await nextAttempt(0);
    attempt.settle({ statusCode: 403, bytesWritten: 0 });

    await expect(promise).rejects.toBeInstanceOf(AuthError);
    expect(mockClearTokens).not.toHaveBeenCalled();
  });

  it('maps a native rejection to NetworkError', async () => {
    const promise = downloadMediaToFile({ mediaId: MEDIA_ID, toFile: STAGING });
    const attempt = await nextAttempt(0);
    attempt.fail(new Error('socket closed'));

    await expect(promise).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// Byte ceiling (#661)
// ---------------------------------------------------------------------------

describe('downloadMediaToFile — byte ceiling', () => {
  it('allows for wire-format overhead so an at-cap file is not rejected', () => {
    // A 50MB plaintext encrypts to MORE than 50MB, and the uploader's own row
    // records the plaintext length — clamping at the upload cap would reject it.
    expect(ciphertextByteCeiling(50 * 1024 * 1024)).toBe(MAX_CIPHERTEXT_BYTES);
    expect(ciphertextByteCeiling(1000)).toBe(1064);
    expect(ciphertextByteCeiling(null)).toBe(MAX_CIPHERTEXT_BYTES);
    expect(ciphertextByteCeiling(0)).toBe(MAX_CIPHERTEXT_BYTES);
  });

  it('stops the job when the advertised contentLength exceeds the ceiling', async () => {
    const promise = downloadMediaToFile({
      mediaId: MEDIA_ID,
      toFile: STAGING,
      expectedBytes: 1000,
    });
    const attempt = await nextAttempt(0);

    attempt.options.begin?.({
      jobId: attempt.jobId,
      statusCode: 200,
      contentLength: 10_000,
      headers: {},
    });

    await expectNetworkFailure(promise, /maximum allowed size/);
    expect(stopDownload).toHaveBeenCalledWith(attempt.jobId);
  });

  it('stops the job when bytesWritten runs past the ceiling mid-transfer', async () => {
    const promise = downloadMediaToFile({
      mediaId: MEDIA_ID,
      toFile: STAGING,
      expectedBytes: 1000,
    });
    const attempt = await nextAttempt(0);

    attempt.options.progress?.({ jobId: attempt.jobId, contentLength: 1064, bytesWritten: 500 });
    expect(stopDownload).not.toHaveBeenCalled();
    attempt.options.progress?.({ jobId: attempt.jobId, contentLength: 1064, bytesWritten: 99_999 });

    await expectNetworkFailure(promise, /maximum allowed size/);
    expect(stopDownload).toHaveBeenCalledWith(attempt.jobId);
  });

  it('forwards transport progress to onProgress', async () => {
    const onProgress = jest.fn();
    const promise = downloadMediaToFile({
      mediaId: MEDIA_ID,
      toFile: STAGING,
      expectedBytes: 4096,
      onProgress,
    });
    const attempt = await nextAttempt(0);
    attempt.options.progress?.({ jobId: attempt.jobId, contentLength: 4096, bytesWritten: 1024 });
    attempt.settle({ statusCode: 200, bytesWritten: 4096 });
    await promise;

    expect(onProgress).toHaveBeenCalledWith(1024, 4096);
  });
});

// ---------------------------------------------------------------------------
// Settlement contract — the JS arms own rejection
// ---------------------------------------------------------------------------

describe('downloadMediaToFile — settlement contract', () => {
  it('rejects via the deadline arm when the native promise NEVER settles', async () => {
    jest.useFakeTimers();
    try {
      installDownloadHarness({ neverSettles: true });

      const promise = downloadMediaToFile({ mediaId: MEDIA_ID, toFile: STAGING });
      const rejection = expectNetworkFailure(promise, /maximum transfer time/);

      await nextAttempt(0);
      await jest.advanceTimersByTimeAsync(mediaDownloadBackstopMs(null) + 1000);
      // Flush the bounded native-settle grace in the cleanup path — cleanup
      // must complete even though the native promise never settles.
      await jest.advanceTimersByTimeAsync(1000);

      await rejection;
      // Best-effort side effect only — cleanup must not depend on it.
      expect(stopDownload).toHaveBeenCalledWith(attempts[0].jobId);
      expect(unlink).toHaveBeenCalledWith(STAGING);
    } finally {
      jest.useRealTimers();
    }
  });

  it('uses a generous absolute backstop, never a throughput-derived deadline', () => {
    // mediaTransferTimeoutMs caps at 10 minutes; the backstop floor is 30.
    expect(mediaDownloadBackstopMs(null)).toBe(30 * 60_000);
    expect(mediaDownloadBackstopMs(200 * 1024 * 1024)).toBe(30 * 60_000);
  });

  it('rejects via the abort arm and stops the active job', async () => {
    const controller = new AbortController();
    const promise = downloadMediaToFile({
      mediaId: MEDIA_ID,
      toFile: STAGING,
      signal: controller.signal,
    });
    const attempt = await nextAttempt(0);

    controller.abort();

    await expectNetworkFailure(promise, /aborted/i);
    expect(stopDownload).toHaveBeenCalledWith(attempt.jobId);
  });

  it('removes its abort listener once the attempt settles', async () => {
    const controller = new AbortController();
    const removeSpy = jest.spyOn(controller.signal, 'removeEventListener');

    const promise = downloadMediaToFile({
      mediaId: MEDIA_ID,
      toFile: STAGING,
      signal: controller.signal,
    });
    const attempt = await nextAttempt(0);
    attempt.settle({ statusCode: 200, bytesWritten: 128 });
    await promise;

    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expectNetworkFailure(
      downloadMediaToFile({
        mediaId: MEDIA_ID,
        toFile: STAGING,
        signal: controller.signal,
      }),
      /aborted/i,
    );

    expect(downloadFile).not.toHaveBeenCalled();
  });

  // The jobId is re-minted per attempt: one listener + one timer must read the
  // CURRENT job, or an abort during retry 2 would stop the already-dead job 1.
  it('429 then abort during attempt 2 stops the second job, not the first', async () => {
    const controller = new AbortController();
    const promise = downloadMediaToFile({
      mediaId: MEDIA_ID,
      toFile: STAGING,
      signal: controller.signal,
    });

    const first = await nextAttempt(0);
    first.settle({ statusCode: 429, bytesWritten: 0 });

    const second = await nextAttempt(1);
    expect(second.jobId).not.toBe(first.jobId);

    controller.abort();

    await expectNetworkFailure(promise, /aborted/i);
    expect(stopDownload).toHaveBeenCalledWith(second.jobId);
    expect(stopDownload).not.toHaveBeenCalledWith(first.jobId);
    // No staging artifact survives the aborted retry.
    expect(unlink).toHaveBeenCalledWith(STAGING);
  }, 15_000);

  it('aborts out of the 429 backoff without starting another attempt', async () => {
    const controller = new AbortController();
    const promise = downloadMediaToFile({
      mediaId: MEDIA_ID,
      toFile: STAGING,
      signal: controller.signal,
    });

    const first = await nextAttempt(0);
    first.settle({ statusCode: 429, bytesWritten: 0 });
    // Abort while the backoff timer is armed.
    await Promise.resolve();
    controller.abort();

    await expectNetworkFailure(promise, /aborted/i);
    expect(downloadFile).toHaveBeenCalledTimes(1);
  }, 15_000);
});
