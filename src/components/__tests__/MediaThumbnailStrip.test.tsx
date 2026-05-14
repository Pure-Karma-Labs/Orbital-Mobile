import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { MediaThumbnailStrip, type MediaThumbnailStripProps } from '../MediaThumbnailStrip';
import type { PickedMedia } from '../../hooks/useMediaPicker';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMedia(index: number): PickedMedia {
  return {
    uri: `file://photo${index}.jpg`,
    base64: `base64data${index}`,
    type: 'image/jpeg',
    fileName: `photo${index}.jpg`,
    fileSize: 1024 * (index + 1),
    width: 800,
    height: 600,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderStrip(
  props: Partial<MediaThumbnailStripProps> & { media?: PickedMedia[] } = {},
): ReactTestRenderer {
  const defaults: MediaThumbnailStripProps = {
    media: [],
    onRemove: jest.fn(),
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(MediaThumbnailStrip, { ...defaults, ...props }),
      ),
    );
  });
  return renderer;
}

function isHost(node: ReactTestInstance): boolean {
  return typeof node.type === 'string';
}

function findByTestId(root: ReactTestInstance, testID: string): ReactTestInstance {
  const found = root.findAll((node) => isHost(node) && node.props.testID === testID);
  if (found.length === 0) throw new Error(`No element with testID "${testID}"`);
  return found[0];
}

function findAllByTestId(root: ReactTestInstance, testID: string): ReactTestInstance[] {
  return root.findAll((node) => isHost(node) && node.props.testID === testID);
}

function findByAccessibilityLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  const found = root.findAll((node) => isHost(node) && node.props.accessibilityLabel === label);
  if (found.length === 0) throw new Error(`No element with accessibilityLabel "${label}"`);
  return found[0];
}

function findComponentByTestId(root: ReactTestInstance, testID: string): ReactTestInstance {
  const found = root.findAll((node) => node.props.testID === testID);
  if (found.length === 0) throw new Error(`No component with testID "${testID}"`);
  return found[0];
}

function findTextWithContent(root: ReactTestInstance, text: string): ReactTestInstance | undefined {
  return root.findAll(
    (node) =>
      isHost(node) &&
      node.children.map(String).join('').includes(text),
  )[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MediaThumbnailStrip', () => {
  it('returns null when media is empty', () => {
    const renderer = renderStrip({ media: [] });
    expect(renderer.toJSON()).toBeNull();
  });

  it('renders correct number of thumbnails', () => {
    const media = [makeMedia(0), makeMedia(1), makeMedia(2)];
    const renderer = renderStrip({ media });

    findByTestId(renderer.root, 'media-thumbnail-strip');
    expect(findAllByTestId(renderer.root, 'remove-media-0')).toHaveLength(1);
    expect(findAllByTestId(renderer.root, 'remove-media-1')).toHaveLength(1);
    expect(findAllByTestId(renderer.root, 'remove-media-2')).toHaveLength(1);
  });

  it('each thumbnail image has correct accessibilityLabel', () => {
    const media = [makeMedia(0), makeMedia(1)];
    const renderer = renderStrip({ media });

    expect(findByAccessibilityLabel(renderer.root, 'Selected media 1')).toBeDefined();
    expect(findByAccessibilityLabel(renderer.root, 'Selected media 2')).toBeDefined();
  });

  it('onRemove fires with correct index', () => {
    const onRemove = jest.fn();
    const media = [makeMedia(0), makeMedia(1)];
    const renderer = renderStrip({ media, onRemove });

    const removeBtn = findComponentByTestId(renderer.root, 'remove-media-1');
    act(() => {
      removeBtn.props.onPress();
    });

    expect(onRemove).toHaveBeenCalledWith(1);
  });

  it('shows progress overlay when uploadProgress < 1', () => {
    const media = [makeMedia(0)];
    const renderer = renderStrip({
      media,
      uploadProgress: { 0: 0.5 },
    });

    expect(findTextWithContent(renderer.root, '50%')).toBeDefined();
    expect(findAllByTestId(renderer.root, 'remove-media-0')).toHaveLength(0);
  });

  it('hides progress overlay when uploadProgress >= 1', () => {
    const media = [makeMedia(0)];
    const renderer = renderStrip({
      media,
      uploadProgress: { 0: 1 },
    });

    expect(findTextWithContent(renderer.root, '100%')).toBeUndefined();
    expect(findAllByTestId(renderer.root, 'remove-media-0')).toHaveLength(1);
  });

  it('hides remove button during upload', () => {
    const media = [makeMedia(0), makeMedia(1)];
    const renderer = renderStrip({
      media,
      uploadProgress: { 0: 0.3 },
    });

    expect(findAllByTestId(renderer.root, 'remove-media-0')).toHaveLength(0);
    expect(findAllByTestId(renderer.root, 'remove-media-1')).toHaveLength(1);
  });

  it('shows remove button when no upload in progress', () => {
    const media = [makeMedia(0)];
    const renderer = renderStrip({ media });

    const removeBtn = findByTestId(renderer.root, 'remove-media-0');
    expect(removeBtn.props.accessibilityRole).toBe('button');
    expect(removeBtn.props.accessibilityLabel).toBe('Remove media 1');
  });
});
