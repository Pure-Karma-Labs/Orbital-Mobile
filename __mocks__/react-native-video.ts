/**
 * Jest manual mock for react-native-video.
 *
 * Auto-resolved by Jest for any `import Video from 'react-native-video'`
 * (root-level __mocks__ for a node_module needs no explicit jest.mock call).
 *
 * Renders a host component named 'Video' forwarding ALL props, so tests can
 * assert on props (source.uri, paused, progressUpdateInterval,
 * allowsExternalPlayback, ...) and invoke callbacks (onLoad / onProgress /
 * onEnd / onError / onReadyForDisplay / onPlaybackStateChanged) from inside
 * act().
 *
 * NOTE: react-native-video 6.x has no Fabric component (its
 * lib/specs/VideoNativeComponent.js is `requireNativeComponent('RCTVideo')`),
 * so the real module renders through RN's legacy ViewManager interop layer,
 * where Fabric ref methods silently no-op. `seek()` is the ONE documented
 * exception: it is a JS closure over the legacy bridge NativeModule
 * `VideoManager.seekCmd` (src/Video.tsx:390-416) and works on both platforms,
 * so it IS mocked here — ActiveVideoPage's custom scrubber depends on it
 * (#662). Nothing else on the ref is exposed, deliberately.
 */

import React from 'react';

export const mockSeek = jest.fn();

const Video = React.forwardRef<
  { seek: (time: number, tolerance?: number) => void },
  Record<string, unknown>
>((props, ref) => {
  React.useImperativeHandle(ref, () => ({ seek: mockSeek }), []);
  return React.createElement('Video', props);
});

Video.displayName = 'Video';

export default Video;

export const VideoDecoderProperties = {
  getWidevineLevel: jest.fn(),
  isCodecSupported: jest.fn(),
  isHEVCSupported: jest.fn(),
};
