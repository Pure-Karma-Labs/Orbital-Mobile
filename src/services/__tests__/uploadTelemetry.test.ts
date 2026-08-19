/**
 * Tests for uploadTelemetry (#738) — the privacy boundary between a failed
 * post and Sentry.
 *
 * The load-bearing assertions here are the negative ones: no path, file name,
 * URI or thrower-attached field may reach the captured event.
 */

jest.mock('@sentry/react-native', () => ({
  captureException: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

import * as Sentry from '@sentry/react-native';
import {
  addUploadBreadcrumb,
  captureUploadFailure,
  scrubErrorMessage,
} from '../uploadTelemetry';
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
// scrubErrorMessage
// ---------------------------------------------------------------------------

describe('scrubErrorMessage', () => {
  it('strips file:// and content:// URIs', () => {
    expect(scrubErrorMessage('ENOENT: file:///var/mobile/tmp/IMG_0042.HEIC missing')).not.toMatch(
      /IMG_0042/,
    );
    expect(
      scrubErrorMessage('open failed for content://media/external/images/media/1234'),
    ).toBe('open failed for <uri>');
  });

  it('strips absolute filesystem paths', () => {
    expect(
      scrubErrorMessage('EACCES /var/mobile/Containers/Data/Application/photo.jpg'),
    ).toBe('EACCES <path>');
  });

  it('strips bare media file names', () => {
    expect(scrubErrorMessage('sanitize failed for vacation-2019.jpeg')).toBe(
      'sanitize failed for <file>',
    );
    expect(scrubErrorMessage('could not read my movie.MOV')).toBe('could not read my <file>');
  });

  it('leaves a content-free message untouched', () => {
    expect(scrubErrorMessage('Cannot upload empty file.')).toBe('Cannot upload empty file.');
    expect(scrubErrorMessage('File too large (240MB). Maximum is 50MB.')).toBe(
      'File too large (240MB). Maximum is 50MB.',
    );
  });

  it('truncates very long messages', () => {
    const scrubbed = scrubErrorMessage('x'.repeat(5000));
    expect(scrubbed.length).toBeLessThanOrEqual(201);
    expect(scrubbed.endsWith('…')).toBe(true);
  });
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

  it('preserves the error class name and the original frames', () => {
    const original = new NetworkError('raw server detail');
    captureUploadFailure(original, { stage: 'media-upload' });

    const reported = capturedError();
    expect(reported.name).toBe('NetworkError');
    expect(reported.message).toBe('Network error — please check your connection');
    expect(reported.stack).toContain('NetworkError: Network error');
    expect(reported.stack).toContain('uploadTelemetry.test');
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
