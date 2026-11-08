import React from 'react';
import { Alert } from 'react-native';
import { act, create } from 'react-test-renderer';

jest.mock('react-native-image-picker');

// The hook reports picker errorCodes through the approved capture path. Mocked
// so the assertion sees exactly what is handed to Sentry -- and so this suite
// does not pull telemetry.ts's ApiError / groupKeyErrors graph in.
jest.mock('../../services/telemetry', () => ({
  captureError: jest.fn(),
}));

import {
  launchLibraryOnce,
  pickerErrorCopy,
  reportPickerError,
  useMediaPicker,
  usePickerInFlight,
} from '../useMediaPicker';
import { launchImageLibrary } from 'react-native-image-picker';
import { captureError } from '../../services/telemetry';

const mockLaunchImageLibrary = launchImageLibrary as jest.Mock;
const mockCaptureError = captureError as jest.Mock;

// ---------------------------------------------------------------------------
// Test harness -- exposes hook state via a ref-like extraction
// ---------------------------------------------------------------------------

let hookResult: ReturnType<typeof useMediaPicker>;

function TestComponent() {
  hookResult = useMediaPicker();
  return null;
}

function renderHook() {
  let root: ReturnType<typeof create>;
  act(() => {
    root = create(React.createElement(TestComponent));
  });
  return root!;
}

/** A launch whose resolution the test controls -- the real multi-second load. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Reads the module-scope lock through a throwaway subscriber. */
function readInFlight(): boolean {
  let value = true;
  function Probe() {
    value = usePickerInFlight();
    return null;
  }
  act(() => {
    create(React.createElement(Probe));
  });
  return value;
}

function makeAsset(overrides: Record<string, unknown> = {}) {
  return {
    uri: 'file://photo.jpg',
    type: 'image/jpeg',
    fileName: 'photo1.jpg',
    fileSize: 1024,
    width: 800,
    height: 600,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

// The in-flight lock is MODULE scope (one native picker, one lock), so it
// outlives a test. Asserting it here rather than resetting it on purpose: a
// leak means the code under test failed to release, and the next test would
// otherwise fail for an unrelated-looking reason (launchLibraryOnce -> null).
afterEach(() => {
  expect(readInFlight()).toBe(false);
});

describe('useMediaPicker', () => {
  describe('pickMedia', () => {
    it('launches picker with mediaType mixed', async () => {
      mockLaunchImageLibrary.mockResolvedValue({
        assets: [makeAsset()],
      });
      renderHook();

      await act(async () => {
        await hookResult.pickMedia();
      });

      expect(mockLaunchImageLibrary).toHaveBeenCalledWith(
        expect.objectContaining({ mediaType: 'mixed' }),
      );
    });

    it('maps assets to PickedMedia fields including duration', async () => {
      mockLaunchImageLibrary.mockResolvedValue({
        assets: [makeAsset({ type: 'video/mp4', duration: 15.5, fileName: 'clip.mp4' })],
      });
      renderHook();

      await act(async () => {
        await hookResult.pickMedia();
      });

      expect(hookResult.selectedMedia).toHaveLength(1);
      const m = hookResult.selectedMedia[0];
      expect(m.type).toBe('video/mp4');
      expect(m.duration).toBe(15.5);
    });

    it('defaults fileName to photo.jpg for images when null', async () => {
      mockLaunchImageLibrary.mockResolvedValue({
        assets: [makeAsset({ fileName: undefined })],
      });
      renderHook();

      await act(async () => {
        await hookResult.pickMedia();
      });

      expect(hookResult.selectedMedia[0].fileName).toBe('photo.jpg');
    });

    it('defaults fileName to video.mp4 for videos when null', async () => {
      mockLaunchImageLibrary.mockResolvedValue({
        assets: [makeAsset({ type: 'video/mp4', fileName: undefined })],
      });
      renderHook();

      await act(async () => {
        await hookResult.pickMedia();
      });

      expect(hookResult.selectedMedia[0].fileName).toBe('video.mp4');
    });

    it('defaults fileSize to 0 when null', async () => {
      mockLaunchImageLibrary.mockResolvedValue({
        assets: [makeAsset({ fileSize: undefined })],
      });
      renderHook();

      await act(async () => {
        await hookResult.pickMedia();
      });

      expect(hookResult.selectedMedia[0].fileSize).toBe(0);
    });

    it('filters out assets missing required fields (uri or type)', async () => {
      mockLaunchImageLibrary.mockResolvedValue({
        assets: [
          makeAsset(),
          makeAsset({ uri: undefined }),
          makeAsset({ type: undefined }),
        ],
      });
      renderHook();

      await act(async () => {
        await hookResult.pickMedia();
      });

      expect(hookResult.selectedMedia).toHaveLength(1);
    });

    it('filters unsupported video MIME types with Alert', async () => {
      mockLaunchImageLibrary.mockResolvedValue({
        assets: [
          makeAsset({ type: 'video/webm', uri: 'file://bad.webm' }),
        ],
      });
      renderHook();

      await act(async () => {
        await hookResult.pickMedia();
      });

      expect(hookResult.selectedMedia).toHaveLength(0);
      expect(Alert.alert).toHaveBeenCalledWith(
        'Unsupported Media',
        expect.any(String),
      );
    });

    it('filters oversize files (>500MB) with Alert', async () => {
      mockLaunchImageLibrary.mockResolvedValue({
        assets: [
          makeAsset({ fileSize: 600 * 1024 * 1024 }),
        ],
      });
      renderHook();

      await act(async () => {
        await hookResult.pickMedia();
      });

      expect(hookResult.selectedMedia).toHaveLength(0);
      expect(Alert.alert).toHaveBeenCalled();
    });

    it('allows mp4, quicktime, and x-m4v video types', async () => {
      mockLaunchImageLibrary.mockResolvedValue({
        assets: [
          makeAsset({ type: 'video/mp4', uri: 'file://a.mp4' }),
          makeAsset({ type: 'video/quicktime', uri: 'file://b.mov' }),
          makeAsset({ type: 'video/x-m4v', uri: 'file://c.m4v' }),
        ],
      });
      renderHook();

      await act(async () => {
        await hookResult.pickMedia();
      });

      expect(hookResult.selectedMedia).toHaveLength(3);
    });

    it('enforces MAX_SELECTION=10 cap', async () => {
      const sevenAssets = Array.from({ length: 7 }, (_, i) =>
        makeAsset({ uri: `file://photo${i}.jpg` }),
      );
      const fiveAssets = Array.from({ length: 5 }, (_, i) =>
        makeAsset({ uri: `file://extra${i}.jpg` }),
      );

      mockLaunchImageLibrary.mockResolvedValueOnce({ assets: sevenAssets });
      renderHook();

      await act(async () => {
        await hookResult.pickMedia();
      });
      expect(hookResult.selectedMedia).toHaveLength(7);

      mockLaunchImageLibrary.mockResolvedValueOnce({ assets: fiveAssets });
      await act(async () => {
        await hookResult.pickMedia();
      });
      expect(hookResult.selectedMedia).toHaveLength(10);
    });

    it('is a no-op when didCancel is true', async () => {
      mockLaunchImageLibrary.mockResolvedValue({ didCancel: true });
      renderHook();

      await act(async () => {
        await hookResult.pickMedia();
      });

      expect(hookResult.selectedMedia).toHaveLength(0);
    });

    it('is a no-op when assets is undefined', async () => {
      mockLaunchImageLibrary.mockResolvedValue({});
      renderHook();

      await act(async () => {
        await hookResult.pickMedia();
      });

      expect(hookResult.selectedMedia).toHaveLength(0);
    });
  });

  describe('removeMedia', () => {
    it('removes item at correct index', async () => {
      const assets = [
        makeAsset({ uri: 'file://a.jpg' }),
        makeAsset({ uri: 'file://b.jpg' }),
        makeAsset({ uri: 'file://c.jpg' }),
      ];
      mockLaunchImageLibrary.mockResolvedValue({ assets });
      renderHook();

      await act(async () => {
        await hookResult.pickMedia();
      });
      expect(hookResult.selectedMedia).toHaveLength(3);

      act(() => {
        hookResult.removeMedia(1);
      });

      expect(hookResult.selectedMedia).toHaveLength(2);
      expect(hookResult.selectedMedia[0].uri).toBe('file://a.jpg');
      expect(hookResult.selectedMedia[1].uri).toBe('file://c.jpg');
    });
  });

  describe('clearMedia', () => {
    it('resets to empty array', async () => {
      mockLaunchImageLibrary.mockResolvedValue({
        assets: [makeAsset()],
      });
      renderHook();

      await act(async () => {
        await hookResult.pickMedia();
      });
      expect(hookResult.selectedMedia).toHaveLength(1);

      act(() => {
        hookResult.clearMedia();
      });

      expect(hookResult.selectedMedia).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// App-wide in-flight lock (#971)
//
// The native picker is a singleton: a second launch during the first one's
// asset load overwrites `self.callback`, and the first load's completion then
// fires the SECOND launch's callback. The second completion fires it again and
// RCTTurboModule aborts the process. The lock is the JS half of the fix.
// ---------------------------------------------------------------------------

describe('useMediaPicker -- in-flight lock (#971)', () => {
  it('two concurrent pickMedia() calls launch the picker once', async () => {
    const d = deferred<Record<string, unknown>>();
    mockLaunchImageLibrary.mockReturnValue(d.promise);
    renderHook();

    await act(async () => {
      const first = hookResult.pickMedia();
      const second = hookResult.pickMedia();
      d.resolve({ assets: [makeAsset()] });
      await Promise.all([first, second]);
    });

    expect(mockLaunchImageLibrary).toHaveBeenCalledTimes(1);
    // The one launch still lands its selection -- the lock drops the extra
    // press, not the pick.
    expect(hookResult.selectedMedia).toHaveLength(1);
  });

  it('launchLibraryOnce returns null while a pickMedia is in flight', async () => {
    const d = deferred<Record<string, unknown>>();
    mockLaunchImageLibrary.mockReturnValue(d.promise);
    renderHook();

    let fromOtherSurface: unknown = 'unset';
    await act(async () => {
      const pick = hookResult.pickMedia();
      // Another surface (the EditProfile avatar) trying to launch mid-load.
      fromOtherSurface = await launchLibraryOnce({ mediaType: 'photo' });
      d.resolve({ didCancel: true });
      await pick;
    });

    expect(fromOtherSurface).toBeNull();
    expect(mockLaunchImageLibrary).toHaveBeenCalledTimes(1);
  });

  it('releases the lock after a resolve', async () => {
    mockLaunchImageLibrary.mockResolvedValue({ assets: [makeAsset()] });
    renderHook();

    await act(async () => {
      await hookResult.pickMedia();
    });

    expect(readInFlight()).toBe(false);
    await act(async () => {
      expect(await launchLibraryOnce({ mediaType: 'photo' })).not.toBeNull();
    });
    expect(mockLaunchImageLibrary).toHaveBeenCalledTimes(2);
  });

  it('releases the lock after didCancel', async () => {
    mockLaunchImageLibrary.mockResolvedValue({ didCancel: true });
    renderHook();

    await act(async () => {
      await hookResult.pickMedia();
    });

    expect(readInFlight()).toBe(false);
    await act(async () => {
      expect(await launchLibraryOnce({ mediaType: 'photo' })).not.toBeNull();
    });
    expect(mockLaunchImageLibrary).toHaveBeenCalledTimes(2);
  });

  it('releases the lock after a rejection', async () => {
    mockLaunchImageLibrary.mockRejectedValueOnce(new Error('picker exploded'));

    await expect(launchLibraryOnce({ mediaType: 'photo' })).rejects.toThrow('picker exploded');

    expect(readInFlight()).toBe(false);
    mockLaunchImageLibrary.mockResolvedValueOnce({ didCancel: true });
    expect(await launchLibraryOnce({ mediaType: 'photo' })).not.toBeNull();
  });

  it('releases the lock after an errorCode response', async () => {
    mockLaunchImageLibrary.mockResolvedValue({ errorCode: 'others' });
    renderHook();

    await act(async () => {
      await hookResult.pickMedia();
    });

    expect(readInFlight()).toBe(false);
    expect(hookResult.selectedMedia).toHaveLength(0);
  });

  it('isPicking updates in every mounted hook instance, not just the caller', async () => {
    const d = deferred<Record<string, unknown>>();
    mockLaunchImageLibrary.mockReturnValue(d.promise);

    let hookA!: ReturnType<typeof useMediaPicker>;
    let hookB!: ReturnType<typeof useMediaPicker>;
    function InstanceA() {
      hookA = useMediaPicker();
      return null;
    }
    function InstanceB() {
      hookB = useMediaPicker();
      return null;
    }
    act(() => {
      create(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(InstanceA),
          React.createElement(InstanceB),
        ),
      );
    });

    expect(hookA.isPicking).toBe(false);
    expect(hookB.isPicking).toBe(false);

    let pick!: Promise<void>;
    act(() => {
      pick = hookA.pickMedia();
    });

    // B is a different screen's hook. It must dim its own attach button.
    expect(hookA.isPicking).toBe(true);
    expect(hookB.isPicking).toBe(true);

    await act(async () => {
      d.resolve({ didCancel: true });
      await pick;
    });

    expect(hookA.isPicking).toBe(false);
    expect(hookB.isPicking).toBe(false);
  });
});

describe('useMediaPicker -- errorCode reporting (#971)', () => {
  // Pure-function checks: reportPickerError's per-session budget is module
  // state, so these deliberately do not go through pickMedia.
  it('does not blame permissions for a load failure (errorCode others)', () => {
    expect(pickerErrorCopy('others')).toEqual({
      title: 'Could Not Add Media',
      body: 'The selected media could not be loaded. Please try again.',
    });
    expect(pickerErrorCopy('others').body).not.toContain('permission');
  });

  it('points to the Photos permission for errorCode permission', () => {
    expect(pickerErrorCopy('permission').title).toBe('Photo Library Unavailable');
    expect(pickerErrorCopy('permission').body).toContain('Photos permission');
  });

  it('alerts the user and reports ONLY the code, once per code per session', async () => {
    mockLaunchImageLibrary.mockResolvedValue({
      errorCode: 'permission',
      // Native also hands back a free-text message. It can embed a URI or a
      // file name, so it must never reach the capture.
      errorMessage: 'PHPhotoLibrary denied for file:///private/var/photo.jpg',
    });
    renderHook();

    await act(async () => {
      await hookResult.pickMedia();
    });

    expect(Alert.alert).toHaveBeenCalledTimes(1);
    expect(hookResult.selectedMedia).toHaveLength(0);

    expect(mockCaptureError).toHaveBeenCalledTimes(1);
    const [reported, ctx] = mockCaptureError.mock.calls[0];
    expect(reported).toBeInstanceOf(Error);
    expect((reported as Error).message).toBe('Image picker error: permission');
    expect(ctx).toEqual({
      level: 'warning',
      tags: { feature: 'media-picker', picker_error_code: 'permission' },
    });
    // Nothing from the response rides along: no errorMessage, no uri, no name.
    const serialized = JSON.stringify([(reported as Error).message, ctx]);
    expect(serialized).not.toContain('photo.jpg');
    expect(serialized).not.toContain('file://');
    expect(serialized).not.toContain('PHPhotoLibrary');

    // Second failure, same code: the user is told again, Sentry is not. A
    // denied-permission user can tap attach all day; that is one fact.
    await act(async () => {
      await hookResult.pickMedia();
    });
    expect(Alert.alert).toHaveBeenCalledTimes(2);
    expect(mockCaptureError).toHaveBeenCalledTimes(1);
  });

  it('reportPickerError budgets per code, so a different code still reports', () => {
    // 'permission' is spent by the test above (module-scope budget, like
    // groupKeyTelemetry's). 'camera_unavailable' is untouched.
    reportPickerError('camera_unavailable');
    reportPickerError('camera_unavailable');

    expect(mockCaptureError).toHaveBeenCalledTimes(1);
    expect(mockCaptureError.mock.calls[0][1]).toEqual({
      level: 'warning',
      tags: { feature: 'media-picker', picker_error_code: 'camera_unavailable' },
    });
  });
});
