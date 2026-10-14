/**
 * Guards for `src/testUtils/rtr.ts`: the host-node filter (#872) and
 * `renderedText`'s documented reach and blind spot (#876).
 *
 * Seven screen suites now share `hasHostTestId` and `bannerMessage`, so their
 * host filter is a single point of vacuity: drop it and presence/absence
 * assertions across all seven keep passing while asserting nothing. This suite
 * pins the filter in CI rather than relying on a one-shot mutation ritual
 * during review (Mobile #872).
 *
 * `MiniBanner` reproduces the shape that makes the filter necessary: it takes
 * `testID` as a prop and returns `null` when there is no message, exactly like
 * `src/components/ErrorBanner.tsx`.
 */

import React from 'react';
import { Text, View } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import {
  bannerMessage,
  findByTestId,
  findHostByTestId,
  hasHostTestId,
  queryByText,
  renderedText,
} from '../rtr';

function MiniBanner({
  message,
  testID,
}: {
  message: string | null;
  testID: string;
}): React.JSX.Element | null {
  if (message === null) return null;
  return (
    <View testID={testID}>
      <Text>{message}</Text>
    </View>
  );
}

function render(message: string | null): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<MiniBanner message={message} testID="mini-banner" />);
  });
  return renderer;
}

describe('testUtils/rtr — host-node filter', () => {
  it('hasHostTestId is false while the component renders null, true once it renders', () => {
    expect(hasHostTestId(render(null).root, 'mini-banner')).toBe(false);
    expect(hasHostTestId(render('boom').root, 'mini-banner')).toBe(true);
  });

  it('bannerMessage is undefined while the component renders null, and the text once it renders', () => {
    expect(bannerMessage(render(null).root, 'mini-banner')).toBeUndefined();
    expect(bannerMessage(render('boom').root, 'mini-banner')).toBe('boom');
  });

  it('findHostByTestId throws while the component renders null', () => {
    expect(() => findHostByTestId(render(null).root, 'mini-banner')).toThrow(
      'No HOST element with testID "mini-banner"',
    );
    expect(() => findHostByTestId(render('boom').root, 'mini-banner')).not.toThrow();
  });

  it('the unfiltered findByTestId DOES find the null-rendering component node — why the filter exists', () => {
    const node = findByTestId(render(null).root, 'mini-banner');
    expect(typeof node.type).toBe('function');
    expect(node.props.testID).toBe('mini-banner');
  });
});

// ---------------------------------------------------------------------------
// renderedText (Mobile #876)
// ---------------------------------------------------------------------------

/** The raw server string a leak assertion is written to catch. */
const RAW = 'SECRET-server-text';

function renderTree(element: React.JSX.Element): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

describe('testUtils/rtr — renderedText', () => {
  it('catches a server string INTERPOLATED into client copy, which queryByText misses', () => {
    // The screen does not render the raw string alone, it folds it into its own
    // sentence — so the exact-match query finds nothing and an absence
    // assertion written with it would pass while the string is on screen.
    const root = renderTree(<Text>{`Couldn't save (${RAW})`}</Text>).root;

    expect(queryByText(root, RAW)).toBeUndefined();
    expect(renderedText(root)).toContain(RAW);
  });

  it('catches a string in a NESTED Text and in a multi-child array', () => {
    const nested = renderTree(
      <Text>
        Could not save <Text>{RAW}</Text>
      </Text>,
    ).root;
    expect(renderedText(nested)).toContain(RAW);

    const multiChild = renderTree(
      <Text>
        {'Could not save '}
        {RAW}
      </Text>,
    ).root;
    expect(renderedText(multiChild)).toContain(RAW);
  });

  it('does NOT find a string split across sibling Text nodes — the documented blind spot', () => {
    // `EmojiText` (src/components/EmojiText.tsx) splits its string at every
    // emoji and URL boundary into sibling <Text> nodes inside one outer
    // <Text>. No single node then holds the whole string, so `renderedText`
    // cannot see it and a `.not.toContain` passes VACUOUSLY. Reproduced here
    // rather than imported, so this pins the helper's precondition and not
    // EmojiText's current segmentation.
    const segments = ['SECRET-', 'server', '-text'];
    const root = renderTree(
      <Text>
        {segments.map((segment, index) => (
          <Text key={index}>{segment}</Text>
        ))}
      </Text>,
    ).root;

    // Every segment IS rendered...
    for (const segment of segments) {
      expect(renderedText(root)).toContain(segment);
    }
    // ...but the contiguous string is not visible to the helper. An absence
    // assertion on RAW here is exactly the false negative the JSDoc warns
    // about: use node-level assertions for text that goes through EmojiText.
    expect(segments.join('')).toBe(RAW);
    expect(renderedText(root)).not.toContain(RAW);
  });
});
