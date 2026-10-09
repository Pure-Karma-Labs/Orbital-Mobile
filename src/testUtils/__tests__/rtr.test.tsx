/**
 * Guard for the host-node filter in `src/testUtils/rtr.ts`.
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

import { bannerMessage, findByTestId, findHostByTestId, hasHostTestId } from '../rtr';

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
