import React from 'react';
import { act, create } from 'react-test-renderer';

jest.mock('react-native-image-picker');

import { useMediaPicker } from '../useMediaPicker';
import { launchImageLibrary, launchCamera } from 'react-native-image-picker';

const mockLaunchImageLibrary = launchImageLibrary as jest.Mock;
const mockLaunchCamera = launchCamera as jest.Mock;

// ---------------------------------------------------------------------------
// Test harness — exposes hook state via a ref-like extraction
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

function makeAsset(overrides: Record<string, unknown> = {}) {
  return {
    uri: 'file://photo.jpg',
    base64: 'abc123',
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
});

describe('useMediaPicker', () => {
  describe('pickPhotos', () => {
    it('maps assets to PickedMedia fields', async () => {
      mockLaunchImageLibrary.mockResolvedValue({
        assets: [makeAsset()],
      });
      renderHook();

      await act(async () => {
        await hookResult.pickPhotos();
      });

      expect(hookResult.selectedMedia).toHaveLength(1);
      const m = hookResult.selectedMedia[0];
      expect(m.uri).toBe('file://photo.jpg');
      expect(m.base64).toBe('abc123');
      expect(m.type).toBe('image/jpeg');
      expect(m.fileName).toBe('photo1.jpg');
      expect(m.fileSize).toBe(1024);
      expect(m.width).toBe(800);
      expect(m.height).toBe(600);
    });

    it('defaults fileName to photo.jpg when null', async () => {
      mockLaunchImageLibrary.mockResolvedValue({
        assets: [makeAsset({ fileName: undefined })],
      });
      renderHook();

      await act(async () => {
        await hookResult.pickPhotos();
      });

      expect(hookResult.selectedMedia[0].fileName).toBe('photo.jpg');
    });

    it('defaults fileSize to 0 when null', async () => {
      mockLaunchImageLibrary.mockResolvedValue({
        assets: [makeAsset({ fileSize: undefined })],
      });
      renderHook();

      await act(async () => {
        await hookResult.pickPhotos();
      });

      expect(hookResult.selectedMedia[0].fileSize).toBe(0);
    });

    it('filters out assets missing required fields', async () => {
      mockLaunchImageLibrary.mockResolvedValue({
        assets: [
          makeAsset(),
          makeAsset({ uri: undefined }),
          makeAsset({ base64: undefined }),
          makeAsset({ type: undefined }),
        ],
      });
      renderHook();

      await act(async () => {
        await hookResult.pickPhotos();
      });

      expect(hookResult.selectedMedia).toHaveLength(1);
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
        await hookResult.pickPhotos();
      });
      expect(hookResult.selectedMedia).toHaveLength(7);

      mockLaunchImageLibrary.mockResolvedValueOnce({ assets: fiveAssets });
      await act(async () => {
        await hookResult.pickPhotos();
      });
      expect(hookResult.selectedMedia).toHaveLength(10);
    });

    it('is a no-op when didCancel is true', async () => {
      mockLaunchImageLibrary.mockResolvedValue({ didCancel: true });
      renderHook();

      await act(async () => {
        await hookResult.pickPhotos();
      });

      expect(hookResult.selectedMedia).toHaveLength(0);
    });

    it('is a no-op when assets is undefined', async () => {
      mockLaunchImageLibrary.mockResolvedValue({});
      renderHook();

      await act(async () => {
        await hookResult.pickPhotos();
      });

      expect(hookResult.selectedMedia).toHaveLength(0);
    });
  });

  describe('takePhoto', () => {
    it('maps single captured asset to PickedMedia', async () => {
      mockLaunchCamera.mockResolvedValue({
        assets: [makeAsset({ uri: 'file://camera.jpg', fileName: 'cam.jpg' })],
      });
      renderHook();

      await act(async () => {
        await hookResult.takePhoto();
      });

      expect(hookResult.selectedMedia).toHaveLength(1);
      expect(hookResult.selectedMedia[0].uri).toBe('file://camera.jpg');
      expect(hookResult.selectedMedia[0].fileName).toBe('cam.jpg');
    });

    it('skips asset missing required fields', async () => {
      mockLaunchCamera.mockResolvedValue({
        assets: [makeAsset({ base64: undefined })],
      });
      renderHook();

      await act(async () => {
        await hookResult.takePhoto();
      });

      expect(hookResult.selectedMedia).toHaveLength(0);
    });

    it('is a no-op on cancel', async () => {
      mockLaunchCamera.mockResolvedValue({ didCancel: true });
      renderHook();

      await act(async () => {
        await hookResult.takePhoto();
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
        await hookResult.pickPhotos();
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
        await hookResult.pickPhotos();
      });
      expect(hookResult.selectedMedia).toHaveLength(1);

      act(() => {
        hookResult.clearMedia();
      });

      expect(hookResult.selectedMedia).toHaveLength(0);
    });
  });
});
