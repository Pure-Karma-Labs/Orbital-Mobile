/**
 * Tests for telemetryScrub (#738 scrub, widened in #746) — the pure privacy
 * primitives every Sentry payload passes through.
 *
 * The load-bearing assertions here are the negative ones: no path, file name,
 * URI, email, touch label, request URL or thrower-attached field may reach the
 * event. `scrubErrorMessage` and `toReportableError` moved here from
 * uploadTelemetry.ts unchanged, and their cases moved with them.
 */

import type { Breadcrumb, ErrorEvent } from '@sentry/react-native';
import {
  filterBreadcrumb,
  scrubErrorMessage,
  scrubEvent,
  toReportableError,
} from '../telemetryScrub';

/** A minimal but type-correct error event. */
function makeEvent(partial: Partial<ErrorEvent> = {}): ErrorEvent {
  return { type: undefined, event_id: 'abc', ...partial };
}

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

  it('strips paths whose directory names contain spaces, keeping the trailing diagnostic', () => {
    expect(
      scrubErrorMessage('/storage/emulated/0/Pictures/Baby Photos/img_0042.jpg not found'),
    ).toBe('<path> not found');
    expect(scrubErrorMessage('EACCES: /storage/emulated/0/Download/Wedding Album/x.heic')).toBe(
      'EACCES: <path>',
    );
  });

  it('strips file names whose stem contains spaces', () => {
    expect(scrubErrorMessage('failed: My Vacation Video.mp4')).toBe('failed: <file>');
  });

  it('strips picker-reachable container formats beyond the common ones', () => {
    expect(scrubErrorMessage('sanitize failed for holiday.dng')).toBe(
      'sanitize failed for <file>',
    );
    expect(scrubErrorMessage('transcode failed for holiday.mkv then holiday.webm')).toBe(
      'transcode failed for <file> then <file>',
    );
  });

  it('scrubs a spaced user file name with a hex stem as a whole file, not an id (#825)', () => {
    // Regression: the <id> replace once ran before the filename patterns and
    // the inserted angle brackets stopped them matching, leaking the stem
    // (`Summer BBQ Grandma <id>.jpg`). Stem words must be capitalised for the
    // spaced pattern, same as on main.
    expect(
      scrubErrorMessage('ENOENT: Summer BBQ Grandma 3f9a1c2e4b5d6e7f8a9b0c1d2e3f4a5b.jpg not found'),
    ).toBe('ENOENT: <file> not found');
    // PATH_PATTERN stops before a space-containing final segment; the spaced
    // file name is then caught whole instead of leaking `Baby <id>.mp4`.
    expect(
      scrubErrorMessage('/storage/emulated/0/DCIM/Baby 3f9a1c2e4b5d6e7f8a9b0c1d2e3f4a5b.mp4 missing'),
    ).toBe('<path> <file> missing');
  });

  it('scrubs ids glued to a word prefix and JWT-shaped tokens (#825)', () => {
    expect(scrubErrorMessage('wrap missing for group_3f9a1c2e-4b5d-6e7f-8a9b-0c1d2e3f4a5b')).toBe(
      'wrap missing for group_<id>',
    );
    // No leading word boundary, so a prefix's trailing hex letters are absorbed
    // too (`media<hex>` -> `medi<id>`): over-eager by design, never under.
    expect(scrubErrorMessage('no row for key3f9a1c2e4b5d6e7f8a9b0c1d2e3f4a5b')).toBe(
      'no row for key<id>',
    );
    expect(scrubErrorMessage('no row for media3f9a1c2e4b5d6e7f8a9b0c1d2e3f4a5b')).toBe(
      'no row for medi<id>',
    );
    expect(
      scrubErrorMessage('401 for eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc-DEF_123 retry'),
    ).toBe('401 for <token> retry');
  });

  it('replaces UUIDs and long hex runs with <id> (#747)', () => {
    expect(
      scrubErrorMessage('wrap missing for 3f9a1c2e-4b5d-6e7f-8a9b-0c1d2e3f4a5b'),
    ).toBe('wrap missing for <id>');
    expect(
      scrubErrorMessage('digest 0123456789abcdef0123456789ABCDEF mismatch'),
    ).toBe('digest <id> mismatch');
  });

  it('replaces email addresses with <email> (#746)', () => {
    // The widened scope (auth, key recovery, invites) is where an address can
    // realistically be interpolated, and an email is directly identifying.
    expect(scrubErrorMessage('no account for grandma.smith+orbital@example.co.uk')).toBe(
      'no account for <email>',
    );
    // The address is replaced as a whole, not half-scrubbed into <id>@…
    expect(
      scrubErrorMessage('login failed: 3f9a1c2e4b5d6e7f8a9b0c1d2e3f4a5b@example.com'),
    ).toBe('login failed: <email>');
  });

  it('leaves short hex words and ordinary prose alone', () => {
    expect(scrubErrorMessage('cache miss for deadbeef')).toBe('cache miss for deadbeef');
    expect(scrubErrorMessage('transcode failed after 3 attempts')).toBe(
      'transcode failed after 3 attempts',
    );
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
// filterBreadcrumb — beforeBreadcrumb
// ---------------------------------------------------------------------------

describe('filterBreadcrumb', () => {
  it('drops http breadcrumbs from both producers', () => {
    // JS fetch/xhr crumbs from breadcrumbsIntegration...
    expect(
      filterBreadcrumb({
        type: 'http',
        category: 'xhr',
        data: { url: 'https://api.orbitl.org/v1/threads/3f9a1c2e-4b5d-6e7f-8a9b-0c1d2e3f4a5b' },
      }),
    ).toBeNull();
    expect(filterBreadcrumb({ type: 'http', category: 'fetch' })).toBeNull();
    // ...and the native shape (category 'http'), which reaches us via scrubEvent.
    expect(filterBreadcrumb({ type: 'http', category: 'http' })).toBeNull();
  });

  it('drops touch and ui.multiClick crumbs, which carry decrypted labels', () => {
    const touch: Breadcrumb = {
      category: 'touch',
      message: 'Thread: Secret title',
      data: { name: 'Pressable', label: 'Thread: Secret title' },
    };
    expect(filterBreadcrumb(touch)).toBeNull();
    expect(
      filterBreadcrumb({ category: 'ui.multiClick', message: 'Thread: Secret title' }),
    ).toBeNull();
  });

  it('drops sentry-cocoa ui.tap interaction crumbs', () => {
    expect(
      filterBreadcrumb({ category: 'ui.tap', type: 'user', data: { view: 'RCTView' } }),
    ).toBeNull();
  });

  it('drops console crumbs', () => {
    expect(
      filterBreadcrumb({ category: 'console', level: 'warning', message: '[Decrypt] secret' }),
    ).toBeNull();
  });

  it('scrubs the message and string data of a crumb it keeps', () => {
    const kept = filterBreadcrumb({
      category: 'key-recovery',
      level: 'info',
      message: 'server-probe for 3f9a1c2e-4b5d-6e7f-8a9b-0c1d2e3f4a5b',
      data: { userId: '3f9a1c2e-4b5d-6e7f-8a9b-0c1d2e3f4a5b', attempt: 2, locallyWiped: true },
    });

    expect(kept).toEqual({
      category: 'key-recovery',
      level: 'info',
      message: 'server-probe for <id>',
      data: { userId: '<id>', attempt: 2, locallyWiped: true },
    });
  });

  it('drops nested object, array and null data values rather than serializing them', () => {
    const kept = filterBreadcrumb({
      category: 'media.upload',
      message: 'encrypt',
      data: {
        mime: 'image/jpeg',
        nested: { title: 'Secret title' },
        list: ['Secret title'],
        nothing: null,
        fn: () => 'Secret title',
      },
    });

    expect(kept?.data).toEqual({ mime: 'image/jpeg' });
  });

  it('keeps the media.upload stage trail intact', () => {
    const crumb: Breadcrumb = {
      category: 'media.upload',
      level: 'info',
      message: 'chunk-upload',
      data: { mime: 'video/mp4', bytes: 1024, chunks: 3, thumbnail: false },
    };
    expect(filterBreadcrumb(crumb)).toEqual(crumb);
  });

  it('does not mutate its input', () => {
    const data = { userId: '3f9a1c2e-4b5d-6e7f-8a9b-0c1d2e3f4a5b', nested: { a: 1 } };
    const crumb: Breadcrumb = { category: 'key-recovery', message: 'step /var/tmp/x.jpg', data };

    const kept = filterBreadcrumb(crumb);

    expect(kept).not.toBe(crumb);
    expect(kept?.data).not.toBe(data);
    expect(crumb.message).toBe('step /var/tmp/x.jpg');
    expect(data.userId).toBe('3f9a1c2e-4b5d-6e7f-8a9b-0c1d2e3f4a5b');
    expect(data.nested).toEqual({ a: 1 });
  });

  it('returns null when reading the crumb throws', () => {
    // core's addBreadcrumb does not guard this hook, so a throw here would
    // propagate into whatever code was recording a crumb.
    const hostile = { category: 'key-recovery' } as Breadcrumb;
    Object.defineProperty(hostile, 'message', {
      get() {
        throw new Error('hostile getter');
      },
    });

    expect(filterBreadcrumb(hostile)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// scrubEvent — beforeSend
// ---------------------------------------------------------------------------

describe('scrubEvent', () => {
  it('scrubs every exception value, including linked cause entries', () => {
    const event = makeEvent({
      exception: {
        values: [
          { type: 'Error', value: 'failed for /var/mobile/tmp/IMG_1.jpg' },
          { type: 'AuthError', value: 'no account for a.person@example.com' },
        ],
      },
    });

    const out = scrubEvent(event);

    expect(out?.exception?.values?.[0].value).toBe('failed for <path>');
    expect(out?.exception?.values?.[1].value).toBe('no account for <email>');
    // Class names are deliberately preserved — they are what makes an event
    // actionable and they carry no user content.
    expect(out?.exception?.values?.[1].type).toBe('AuthError');
  });

  it('scrubs message and logentry', () => {
    const out = scrubEvent(
      makeEvent({
        message: 'Identity restore: a.person@example.com',
        logentry: { message: 'wrap missing for 3f9a1c2e-4b5d-6e7f-8a9b-0c1d2e3f4a5b' },
      }),
    );

    expect(out?.message).toBe('Identity restore: <email>');
    expect(out?.logentry?.message).toBe('wrap missing for <id>');
  });

  it('scrubs string tags and extra, and drops non-primitive extra values', () => {
    const out = scrubEvent(
      makeEvent({
        tags: { feature: 'key-recovery', step: 'probe 3f9a1c2e-4b5d-6e7f-8a9b-0c1d2e3f4a5b' },
        extra: {
          step: 'local-wipe /var/mobile/tmp/x.jpg',
          attempt: 3,
          fatal: true,
          nested: { title: 'Secret title' },
          list: ['Secret title'],
        },
      }),
    );

    expect(out?.tags).toEqual({ feature: 'key-recovery', step: 'probe <id>' });
    expect(out?.extra).toEqual({ step: 'local-wipe <path>', attempt: 3, fatal: true });
  });

  it('deletes extra.__serialized__', () => {
    const out = scrubEvent(
      makeEvent({ extra: { __serialized__: { body: 'Secret title' }, attempt: 1 } }),
    );

    expect(out?.extra).toEqual({ attempt: 1 });
  });

  it('re-filters breadcrumbs, dropping native-shaped http crumbs', () => {
    // Native crumbs are merged in by deviceContextIntegration AFTER
    // beforeBreadcrumb has run, so this pass is the only one that sees them.
    const out = scrubEvent(
      makeEvent({
        breadcrumbs: [
          {
            type: 'http',
            category: 'http',
            data: { url: 'https://api.orbitl.org/v1/media/3f9a1c2e-4b5d-6e7f-8a9b-0c1d2e3f4a5b' },
          },
          { category: 'touch', message: 'Thread: Secret title' },
          { category: 'media.upload', level: 'info', message: 'encrypt' },
        ],
      }),
    );

    expect(out?.breadcrumbs).toEqual([
      { category: 'media.upload', level: 'info', message: 'encrypt' },
    ]);
  });

  it('keeps the stage trail when native http crumbs dominate a full buffer', () => {
    // The eviction risk maxBreadcrumbs guards: deviceContext merges native
    // crumbs then slices to 100, so a 100-entry buffer can arrive here mostly
    // full of http. All of them must go and every stage crumb must survive.
    const stages = ['sanitize', 'encrypt', 'chunk-upload', 'local-commit', 'thread-create'];
    const breadcrumbs: Breadcrumb[] = [
      ...Array.from({ length: 95 }, (_, i) => ({
        type: 'http',
        category: 'http',
        data: { url: `https://api.orbitl.org/v1/chunks/${i}` },
      })),
      ...stages.map((stage) => ({ category: 'media.upload', level: 'info' as const, message: stage })),
    ];

    const out = scrubEvent(makeEvent({ breadcrumbs }));

    expect(out?.breadcrumbs).toHaveLength(5);
    expect(out?.breadcrumbs?.map((b) => b.message)).toEqual(stages);
  });

  it('keeps event.user.id verbatim and drops every other user field', () => {
    const userId = '8f14e45f-ceea-467a-9b8e-6a9c6f0b5f21';
    const event = makeEvent({
      user: { id: userId, email: 'mom@example.com', username: 'grandma', ip_address: '1.2.3.4' },
    });

    const out = scrubEvent(event);

    expect(out?.user).toEqual({ id: userId });
  });

  it('scrubs string logentry params and replaces non-primitive ones', () => {
    const event = makeEvent({
      logentry: {
        message: 'restore %s for %s',
        params: ['file:///var/mobile/tmp/IMG_0042.HEIC', { title: 'Secret title' }, 3],
      },
    });

    const out = scrubEvent(event);

    expect(out?.logentry?.params).toEqual(['<uri>', '<dropped>', 3]);
    expect(JSON.stringify(out)).not.toContain('Secret title');
  });

  it('returns a content-free skeleton when the scrub throws', () => {
    // Silence would hide a broken scrub; forwarding the event would be the
    // leak. The skeleton shows up as a `scrub:failed` spike instead.
    const event = makeEvent({ message: 'Secret title' });
    Object.defineProperty(event, 'exception', {
      get() {
        throw new Error('hostile getter');
      },
    });

    const out = scrubEvent(event);

    expect(out).not.toBeNull();
    expect(out?.message).toBe('telemetry-scrub-failed');
    expect(out?.tags).toEqual({ scrub: 'failed' });
    expect(out?.event_id).toBe('abc');
    expect(out?.level).toBe('error');
    expect(out?.platform).toBe('javascript');
    expect(out?.exception).toBeUndefined();
    expect(out?.breadcrumbs).toBeUndefined();
    expect(out?.extra).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('Secret title');
  });
});

// ---------------------------------------------------------------------------
// toReportableError — the frame-scrub invariants, pinned on the pure function
// (also covered end-to-end through captureUploadFailure in uploadTelemetry.test)
// ---------------------------------------------------------------------------

describe('toReportableError', () => {
  it('preserves the class name and real frame lines', () => {
    class NetworkError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'NetworkError';
      }
    }
    const reported = toReportableError(new NetworkError('offline'));

    expect(reported.name).toBe('NetworkError');
    expect(reported.stack).toContain('NetworkError: offline');
    expect(reported.stack).toMatch(/\n\s*at /);
  });

  it('does not leak lines 2..N of a multi-line message through the rebuilt stack', () => {
    const reported = toReportableError(
      new Error(
        'sanitize failed\nnative detail: /var/mobile/Containers/Data/IMG_0042.HEIC\nsource: file:///var/mobile/tmp/secret photo.jpg',
      ),
    );

    expect(reported.message).not.toContain('IMG_0042');
    expect(reported.stack).not.toContain('IMG_0042');
    expect(reported.stack).not.toContain('secret photo');
    expect(reported.stack).not.toContain('file://');
    expect(reported.stack).not.toContain('/var/mobile');
    expect(reported.stack).toMatch(/\n\s*at /);
  });

  it('never returns the original object and drops its custom fields', () => {
    const original = Object.assign(new Error('boom'), { serverMessage: 'orbit "Secret title"' });
    const reported = toReportableError(original);

    expect(reported).not.toBe(original);
    expect(reported).not.toHaveProperty('serverMessage');
  });
});
