/**
 * Tests for uploadTelemetry (#738) — the compose → upload → post stage trail.
 *
 * The load-bearing assertions here are the negative ones: no path, file name,
 * URI or thrower-attached field may reach the captured event. Since #746 the
 * scrub itself lives in telemetryScrub.ts and the capture in telemetry.ts;
 * their unit tests are `telemetryScrub.test.ts` and `telemetry.test.ts`. These
 * cases stay because they pin the property END TO END, through the real
 * captureError, rather than trusting the seam.
 */

jest.mock('@sentry/react-native', () => ({
  captureException: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

import * as Sentry from '@sentry/react-native';
import { addUploadBreadcrumb, captureUploadFailure } from '../uploadTelemetry';
import { ApiError, NetworkError, QuotaExceededError } from '../api/errors';

const mockCapture = Sentry.captureException as unknown as jest.Mock;
const mockBreadcrumb = Sentry.addBreadcrumb as unknown as jest.Mock;

/** The Error the module actually handed to Sentry. */
function capturedError(): Error {
  return mockCapture.mock.calls[0][0] as Error;
}

/** The CaptureContext (level + tags) the module attached. */
function capturedContext(): { level: string; tags: Record<string, string> } {
  return mockCapture.mock.calls[0][1] as { level: string; tags: Record<string, string> };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// captureUploadFailure
// ---------------------------------------------------------------------------

describe('captureUploadFailure', () => {
  it('tags the stage and surface', () => {
    captureUploadFailure(new Error('boom'), {
      stage: 'chunk-upload',
      surface: 'compose-thread',
    });

    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(capturedContext().tags).toMatchObject({
      feature: 'media-upload',
      stage: 'chunk-upload',
      surface: 'compose-thread',
    });
    expect(capturedContext().level).toBe('error');
  });

  it('tags dm true/false and omits the tag when the caller does not know (#745)', () => {
    captureUploadFailure(new Error('boom'), { stage: 'reply-create', dm: true });
    expect(capturedContext().tags.dm).toBe('true');

    mockCapture.mockClear();
    captureUploadFailure(new Error('boom'), { stage: 'reply-create', dm: false });
    expect(capturedContext().tags.dm).toBe('false');

    mockCapture.mockClear();
    captureUploadFailure(new Error('boom'), { stage: 'reply-create' });
    expect(capturedContext().tags).not.toHaveProperty('dm');
  });

  it('preserves the error class name and the original frames', () => {
    const original = new NetworkError('raw server detail');
    captureUploadFailure(original, { stage: 'media-upload' });

    const reported = capturedError();
    expect(reported.name).toBe('NetworkError');
    expect(reported.message).toBe('Network error — please check your connection');
    expect(reported.stack).toContain('NetworkError: Network error');
    // Frame lines survive the rebuild (scrubbed, so no machine paths).
    expect(reported.stack).toMatch(/\n\s*at /);
  });

  it('does not leak lines 2..N of a multi-line message through the rebuilt stack', () => {
    // A multi-line message spans one stack-header line per newline; only real
    // frame lines may survive into reported.stack (panel finding, PR #744).
    const original = new Error(
      'sanitize failed\nnative detail: /var/mobile/Containers/Data/IMG_0042.HEIC\nsource: file:///var/mobile/tmp/secret photo.jpg',
    );
    captureUploadFailure(original, { stage: 'sanitize' });

    const reported = capturedError();
    expect(reported.message).not.toContain('IMG_0042');
    expect(reported.stack).not.toContain('IMG_0042');
    expect(reported.stack).not.toContain('secret photo');
    expect(reported.stack).not.toContain('file://');
    expect(reported.stack).not.toContain('/var/mobile');
    expect(reported.stack).toMatch(/\n\s*at /);
  });

  it('never forwards the thrower\'s own error object or its custom fields', () => {
    const quotaBody = JSON.stringify({
      error: 'QUOTA_EXCEEDED',
      details: {
        quota: {
          storage_bytes: 1,
          max_bytes: 1,
          file_count: 1,
          max_files: 1,
          storage_percent: 100,
          files_percent: 100,
          evictable_bytes: 0,
        },
      },
    });
    const original = new QuotaExceededError(quotaBody);
    captureUploadFailure(original, { stage: 'media-upload' });

    const reported = capturedError();
    expect(reported).not.toBe(original);
    expect((reported as unknown as { quota?: unknown }).quota).toBeUndefined();
    expect((reported as unknown as { serverMessage?: unknown }).serverMessage).toBeUndefined();
  });

  it('scrubs paths out of the message it reports', () => {
    captureUploadFailure(new Error('copyFile failed: /var/mobile/tmp/IMG_1.jpg'), {
      stage: 'local-commit',
    });

    expect(capturedError().message).toBe('copyFile failed: <path>');
  });

  it('adds status and api_code tags for API errors', () => {
    captureUploadFailure(new ApiError('Server error', 500, 'SERVER_ERROR', true), {
      stage: 'chunk-upload',
    });

    expect(capturedContext().tags).toMatchObject({ status: '500', api_code: 'SERVER_ERROR' });
  });

  it('downgrades a quota rejection to warning — a full orbit is not a bug', () => {
    captureUploadFailure(new QuotaExceededError(), { stage: 'media-upload' });
    expect(capturedContext().level).toBe('warning');
  });

  it('honours an explicit warning level for degradations', () => {
    captureUploadFailure(new Error('thumbnail gone'), { stage: 'thumbnail', level: 'warning' });
    expect(capturedContext().level).toBe('warning');
  });

  it('handles a non-Error rejection', () => {
    captureUploadFailure('just a string', { stage: 'encrypt' });
    expect(capturedError().name).toBe('Error');
    expect(capturedError().message).toBe('just a string');
  });
});

// ---------------------------------------------------------------------------
// addUploadBreadcrumb
// ---------------------------------------------------------------------------

describe('addUploadBreadcrumb', () => {
  it('records the stage with non-content shape data only', () => {
    addUploadBreadcrumb('encrypt', { mime: 'image/jpeg', bytes: 1024, chunks: 1 });

    expect(mockBreadcrumb).toHaveBeenCalledWith({
      category: 'media.upload',
      level: 'info',
      message: 'encrypt',
      data: { mime: 'image/jpeg', bytes: 1024, chunks: 1 },
    });
  });
});
