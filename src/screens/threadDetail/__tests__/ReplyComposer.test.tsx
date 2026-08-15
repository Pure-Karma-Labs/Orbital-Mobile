/**
 * Tests for ReplyComposer — media picker integration, send behavior, and props.
 */

jest.mock('../../../components/MediaThumbnailStrip', () => {
  const React = require('react');
  const { TouchableOpacity, View } = require('react-native');
  return {
    MediaThumbnailStrip: (props: { onRemove: (index: number) => void }) =>
      React.createElement(
        View,
        { testID: 'mock-media-strip' },
        React.createElement(TouchableOpacity, {
          testID: 'mock-strip-remove-0',
          onPress: () => props.onRemove(0),
        }),
      ),
  };
});

jest.mock('../../../components/Emoji', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    Emoji: (props: { unified: string; size: number }) =>
      React.createElement(View, {
        testID: `mock-emoji-${props.unified}`,
      }),
  };
});

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider } from '../../../theme';
import { ReplyComposer, type ReplyComposerProps } from '../ReplyComposer';
import type { PickedMedia } from '../../../hooks/useMediaPicker';
import type { UploadProgressState } from '../../../hooks/useMediaUploadProgress';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fakeMedia: PickedMedia[] = [
  {
    uri: 'file:///photo1.jpg',

    type: 'image/jpeg',
    fileName: 'photo1.jpg',
    fileSize: 1024,
    width: 100,
    height: 100,
  },
];

function defaultProps(overrides?: Partial<ReplyComposerProps>): ReplyComposerProps {
  return {
    replyTarget: null,
    onClearReplyTarget: jest.fn(),
    onSend: jest.fn(),
    sending: false,
    text: '',
    onChangeText: jest.fn(),
    ...overrides,
  };
}

function renderComposer(
  overrides?: Partial<ReplyComposerProps>,
): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(ReplyComposer, defaultProps(overrides)),
      ),
    );
  });
  return renderer;
}

function findByTestId(
  renderer: ReactTestRenderer,
  testID: string,
): ReturnType<ReactTestRenderer['root']['findAll']> {
  return renderer.root.findAll((node) => node.props.testID === testID);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReplyComposer — media picker button', () => {
  it('renders media picker button when onPickMedia is provided', () => {
    const renderer = renderComposer({ onPickMedia: jest.fn() });
    expect(findByTestId(renderer, 'media-picker-button').length).toBeGreaterThan(0);
  });

  it('does not render media picker button when onPickMedia is not provided', () => {
    const renderer = renderComposer();
    expect(findByTestId(renderer, 'media-picker-button').length).toBe(0);
  });

  it('media button is disabled when sending={true}', () => {
    const renderer = renderComposer({
      onPickMedia: jest.fn(),
      sending: true,
    });
    const btn = findByTestId(renderer, 'media-picker-button');
    expect(btn.length).toBeGreaterThan(0);
    expect(btn[0].props.disabled).toBe(true);
  });

  it('calls onPickMedia when media button is pressed', () => {
    const onPickMedia = jest.fn();
    const renderer = renderComposer({ onPickMedia });
    const btn = findByTestId(renderer, 'media-picker-button');
    act(() => {
      btn[0].props.onPress();
    });
    expect(onPickMedia).toHaveBeenCalledTimes(1);
  });
});

describe('ReplyComposer — MediaThumbnailStrip', () => {
  it('renders MediaThumbnailStrip when media is non-empty', () => {
    const renderer = renderComposer({ media: fakeMedia });
    expect(findByTestId(renderer, 'mock-media-strip').length).toBeGreaterThan(0);
  });

  it('does not render strip when media is empty', () => {
    const renderer = renderComposer({ media: [] });
    expect(findByTestId(renderer, 'mock-media-strip').length).toBe(0);
  });

  it('does not render strip when media is undefined', () => {
    const renderer = renderComposer();
    expect(findByTestId(renderer, 'mock-media-strip').length).toBe(0);
  });

  it('calls onRemoveMedia with correct index via strip', () => {
    const onRemoveMedia = jest.fn();
    const renderer = renderComposer({
      media: fakeMedia,
      onRemoveMedia,
    });
    const removeBtn = findByTestId(renderer, 'mock-strip-remove-0');
    act(() => {
      removeBtn[0].props.onPress();
    });
    expect(onRemoveMedia).toHaveBeenCalledWith(0);
  });
});

describe('ReplyComposer — send behavior', () => {
  it('send button is disabled when sending={true} even with text', () => {
    const renderer = renderComposer({ sending: true, text: 'hello' });
    const sendBtn = findByTestId(renderer, 'send-button');
    expect(sendBtn.length).toBeGreaterThan(0);
    expect(sendBtn[0].props.disabled).toBe(true);
  });

  it('send button is enabled when text is present and not sending', () => {
    const renderer = renderComposer({ text: 'hello', sending: false });
    const sendBtn = findByTestId(renderer, 'send-button');
    expect(sendBtn[0].props.disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Upload progress (#645)
// ---------------------------------------------------------------------------

describe('ReplyComposer — upload progress', () => {
  const fakeUploadProgress: UploadProgressState = {
    fraction: 0.25,
    phase: 'compressing',
    bytesSent: null,
    totalBytes: null,
    itemIndex: 0,
    itemCount: 1,
    cancelling: false,
  };

  it('renders the progress bar, track, and cancel button with a phase-matched label', () => {
    const renderer = renderComposer({ uploadProgress: fakeUploadProgress, onCancelUpload: jest.fn() });

    expect(findByTestId(renderer, 'upload-progress').length).toBeGreaterThan(0);
    expect(findByTestId(renderer, 'upload-progress-bar').length).toBeGreaterThan(0);
    expect(findByTestId(renderer, 'upload-cancel-button').length).toBeGreaterThan(0);

    const label = findByTestId(renderer, 'upload-progress-label');
    expect(label[0].props.children).toBe('Preparing video…');
  });

  it('renders none of the upload progress elements when uploadProgress is omitted or null', () => {
    const omitted = renderComposer();
    expect(findByTestId(omitted, 'upload-progress').length).toBe(0);
    expect(findByTestId(omitted, 'upload-cancel-button').length).toBe(0);

    const withNull = renderComposer({ uploadProgress: null });
    expect(findByTestId(withNull, 'upload-progress').length).toBe(0);
    expect(findByTestId(withNull, 'upload-cancel-button').length).toBe(0);
  });

  it('calls onCancelUpload when the cancel button is pressed', () => {
    const onCancelUpload = jest.fn();
    const renderer = renderComposer({ uploadProgress: fakeUploadProgress, onCancelUpload });

    const cancelBtn = findByTestId(renderer, 'upload-cancel-button');
    act(() => {
      cancelBtn[0].props.onPress();
    });

    expect(onCancelUpload).toHaveBeenCalledTimes(1);
  });

  it('keeps the cancel button pressable while sending={true} freezes the reply input', () => {
    const renderer = renderComposer({ uploadProgress: fakeUploadProgress, sending: true });

    const cancelBtn = findByTestId(renderer, 'upload-cancel-button');
    expect(cancelBtn[0].props.disabled).toBeFalsy();

    const input = findByTestId(renderer, 'reply-input');
    expect(input[0].props.editable).toBe(false);
  });
});
