import React from 'react';
import { Alert } from 'react-native';
import { act, create } from 'react-test-renderer';

jest.mock('react-native-image-picker');

import { useMediaPicker } from '../useMediaPicker';
import { launchImageLibrary } from 'react-native-image-picker';

const mockLaunchImageLibrary = launchImageLibrary as jest.Mock;

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
