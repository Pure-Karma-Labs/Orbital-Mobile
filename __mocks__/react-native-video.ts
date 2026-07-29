/**
 * Jest manual mock for react-native-video.
 *
 * Auto-resolved by Jest for any `import Video from 'react-native-video'`
 * (root-level __mocks__ for a node_module needs no explicit jest.mock call).
 *
 * Renders a host component named 'Video' forwarding ALL props, so tests can
 * assert on props (source.uri, controls, paused, allowsExternalPlayback, ...)
 * and invoke callbacks (onLoad / onError / onEnd / onReadyForDisplay /
 * onPlaybackStateChanged) from inside act().
 *
 * NOTE: react-native-video 6.x has no Fabric component (its
 * lib/specs/VideoNativeComponent.js is `requireNativeComponent('RCTVideo')`),
 * so the real module renders through RN's legacy ViewManager interop layer.
 * The imperative ref API is deliberately NOT mocked — it must never be used
 * (it silently no-ops through interop).
 */

import React from 'react';

const Video = (props: Record<string, unknown>): React.JSX.Element =>
  React.createElement('Video', props);

export default Video;

export const VideoDecoderProperties = {
  getWidevineLevel: jest.fn(),
  isCodecSupported: jest.fn(),
  isHEVCSupported: jest.fn(),
};
