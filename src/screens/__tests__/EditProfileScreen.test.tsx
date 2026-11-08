/**
 * Tests for EditProfileScreen — rendering, validation, and save flow.
 */

import React from 'react';
import { ActionSheetIOS } from 'react-native';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider, lightColors } from '../../theme';
import { EditProfileScreen } from '../EditProfileScreen';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// NOT mocked: src/hooks/useMediaPicker. The avatar flow goes through its real
// `launchLibraryOnce` / `usePickerInFlight`, so the lock under test (#971) is
// the real module-scope one, shared with the composer surfaces.
jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: jest.fn(),
}));

jest.mock('../../services/telemetry', () => ({
  captureError: jest.fn(),
}));

jest.mock('../../services/profileService', () => ({
  updateUserDisplayName: jest.fn(),
  updateUserAvatar: jest.fn(),
  removeUserAvatar: jest.fn(),
}));

jest.mock('../../stores', () => ({
  useAuth: jest.fn(),
}));

jest.mock('../../components/OrbitalSpinner', () => ({
  OrbitalSpinner: () => null,
}));

import { useAuth } from '../../stores';
import { updateUserDisplayName, updateUserAvatar } from '../../services/profileService';
import { launchImageLibrary } from 'react-native-image-picker';
import { launchLibraryOnce, pickerErrorCopy, usePickerInFlight } from '../../hooks/useMediaPicker';
import { captureError } from '../../services/telemetry';

const mockUseAuth = useAuth as jest.Mock;
const mockUpdateDisplayName = updateUserDisplayName as jest.Mock;
// @ts-expect-error — kept for future avatar upload tests
const _mockUpdateAvatar = updateUserAvatar as jest.Mock;
const mockLaunchImageLibrary = launchImageLibrary as jest.Mock;
const mockCaptureError = captureError as jest.Mock;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const safeAreaMetrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
};

const mockNavigation = {
  navigate: jest.fn(),
  push: jest.fn(),
  goBack: jest.fn(),
  replace: jest.fn(),
  setOptions: jest.fn(),
  addListener: jest.fn(() => jest.fn()),
  removeListener: jest.fn(),
  canGoBack: jest.fn(() => true),
  dispatch: jest.fn(),
  isFocused: jest.fn(() => true),
  reset: jest.fn(),
  popToTop: jest.fn(),
  pop: jest.fn(),
  getParent: jest.fn(),
  getState: jest.fn(() => ({ routes: [], index: 0, key: 'stack', type: 'stack' })),
  getId: jest.fn(),
  setParams: jest.fn(),
};

const mockRoute = {
  key: 'EditProfile',
  name: 'EditProfile' as const,
  params: undefined,
};

function renderScreen(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        SafeAreaProvider,
        { initialMetrics: safeAreaMetrics },
        React.createElement(
          ThemeProvider,
          { colorSchemeOverride: 'light' },
          React.createElement(EditProfileScreen, {
            navigation: mockNavigation as unknown as React.ComponentProps<typeof EditProfileScreen>['navigation'],
            route: mockRoute as unknown as React.ComponentProps<typeof EditProfileScreen>['route'],
          }),
        ),
      ),
    );
  });
  return renderer;
}

function findByTestId(root: ReactTestInstance, testID: string): ReactTestInstance {
  const found = root.findAll((node) => node.props.testID === testID);
  if (found.length === 0) throw new Error(`No element with testID "${testID}"`);
  return found[0];
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

/**
 * Press the avatar. Re-finds the node first: `handleAvatarPress` closes over
 * `pickerInFlight`, so a stale instance would carry the pre-lock closure and
 * the second press in these tests would prove nothing.
 */
function pressAvatar(renderer: ReactTestRenderer): void {
  act(() => {
    findByTestId(renderer.root, 'avatar-button').props.onPress();
  });
}

/**
 * Reads the hook's module-scope pick lock through a throwaway subscriber.
 * Mirrors the hook suite's probe, including the separate unmount `act` (one
 * combined block flushes both and the probe never renders).
 */
function readInFlight(): boolean {
  let value = true;
  function Probe() {
    value = usePickerInFlight();
    return null;
  }
  let probe!: ReactTestRenderer;
  act(() => {
    probe = create(React.createElement(Probe));
  });
  act(() => {
    probe.unmount();
  });
  return value;
}

function findTextNode(renderer: ReactTestRenderer, text: string) {
  return renderer.root
    .findAllByType('Text' as unknown as React.ComponentType)
    .find((node) => node.props.children === text);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockUseAuth.mockReturnValue({
    isAuthenticated: true,
    userId: 'user-1',
    username: 'alice',
    displayName: 'Alice',
    avatarPath: null,
    updateProfile: jest.fn(),
  });
  mockUpdateDisplayName.mockResolvedValue(undefined);
});

// The pick lock is MODULE scope and outlives a test. A leak here would make the
// next test fail for an unrelated-looking reason (launchLibraryOnce -> null, so
// no sheet, no launch), so it is asserted at the test that leaked it.
afterEach(() => {
  expect(readInFlight()).toBe(false);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EditProfileScreen — rendering', () => {
  it('renders the screen with testID', () => {
    const renderer = renderScreen();
    expect(() => findByTestId(renderer.root, 'edit-profile-screen')).not.toThrow();
  });

  it('renders the display name input pre-populated', () => {
    const renderer = renderScreen();
    const input = findByTestId(renderer.root, 'display-name-input');
    expect(input.props.value).toBe('Alice');
  });

  it('renders the username display', () => {
    const renderer = renderScreen();
    const usernameEl = findByTestId(renderer.root, 'username-display');
    expect(usernameEl.props.children).toEqual(['@', 'alice']);
  });

  it('renders the save button disabled initially (no changes)', () => {
    const renderer = renderScreen();
    const button = findByTestId(renderer.root, 'save-button');
    expect(button.props.disabled).toBe(true);
  });

  it('renders the character counter', () => {
    const renderer = renderScreen();
    const counter = findByTestId(renderer.root, 'char-counter');
    expect(counter.props.children).toEqual([5, '/', 15]);
  });
});

describe('EditProfileScreen — validation', () => {
  it('enables save when name changes to valid text', () => {
    const renderer = renderScreen();
    const input = findByTestId(renderer.root, 'display-name-input');
    act(() => {
      input.props.onChangeText('Bob');
    });
    const button = findByTestId(renderer.root, 'save-button');
    expect(button.props.disabled).toBe(false);
  });

  it('keeps save disabled when name is empty', () => {
    const renderer = renderScreen();
    const input = findByTestId(renderer.root, 'display-name-input');
    act(() => {
      input.props.onChangeText('');
    });
    const button = findByTestId(renderer.root, 'save-button');
    expect(button.props.disabled).toBe(true);
  });

  it('rejects invalid characters (special chars are not applied)', () => {
    const renderer = renderScreen();
    const input = findByTestId(renderer.root, 'display-name-input');
    act(() => {
      input.props.onChangeText('Alice!@#');
    });
    // The onChangeText handler should not update state with invalid chars
    // so value should remain 'Alice' (original)
    const inputAfter = findByTestId(renderer.root, 'display-name-input');
    expect(inputAfter.props.value).toBe('Alice');
  });
});

describe('EditProfileScreen — save flow', () => {
  it('calls updateUserDisplayName and goBack on successful save', async () => {
    const renderer = renderScreen();
    const input = findByTestId(renderer.root, 'display-name-input');

    act(() => {
      input.props.onChangeText('Bob');
    });

    const button = findByTestId(renderer.root, 'save-button');
    await act(async () => {
      button.props.onPress();
    });

    expect(mockUpdateDisplayName).toHaveBeenCalledWith('Bob');
    expect(mockNavigation.goBack).toHaveBeenCalled();
  });

  it('shows error on API failure', async () => {
    mockUpdateDisplayName.mockRejectedValue(new Error('Server error'));
    const renderer = renderScreen();
    const input = findByTestId(renderer.root, 'display-name-input');

    act(() => {
      input.props.onChangeText('Bob');
    });

    const button = findByTestId(renderer.root, 'save-button');
    await act(async () => {
      button.props.onPress();
    });

    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const errorText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === 'Server error',
    );
    expect(errorText).toBeDefined();
  });
});

describe('EditProfileScreen — avatar', () => {
  it('renders the avatar button', () => {
    const renderer = renderScreen();
    expect(() => findByTestId(renderer.root, 'avatar-button')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Avatar picker and the app-wide pick lock (#971)
//
// The avatar is the one surface that reaches the picker through an ActionSheet,
// so it has two things to prove: the lock holds across the sheet hop, and the
// sheet is not opened when its primary action would be swallowed.
// ---------------------------------------------------------------------------

describe('EditProfileScreen — avatar picker lock (#971)', () => {
  /** Auto-selects "Choose Photo" (index 0) so a press reaches the picker. */
  function spyChoosePhotoSheet(): jest.SpyInstance {
    return jest
      .spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
      .mockImplementation((_options, callback) => {
        callback(0);
      });
  }

  it('a double press launches the picker once and does not reopen the sheet', async () => {
    const sheet = spyChoosePhotoSheet();
    const d = deferred<Record<string, unknown>>();
    mockLaunchImageLibrary.mockReturnValue(d.promise);

    const renderer = renderScreen();
    pressAvatar(renderer);
    // Second tap while the first pick's assets are still loading -- the exact
    // user behaviour that overwrote the native callback and aborted.
    pressAvatar(renderer);

    expect(mockLaunchImageLibrary).toHaveBeenCalledTimes(1);
    expect(sheet).toHaveBeenCalledTimes(1);

    await act(async () => {
      d.resolve({ didCancel: true });
      await d.promise;
    });

    // Lock released: the sheet opens again for the next press.
    pressAvatar(renderer);
    expect(sheet).toHaveBeenCalledTimes(2);
    expect(mockLaunchImageLibrary).toHaveBeenCalledTimes(2);
  });

  it('does not open the ActionSheet while another surface holds the lock', async () => {
    const sheet = spyChoosePhotoSheet();
    const d = deferred<Record<string, unknown>>();
    mockLaunchImageLibrary.mockReturnValue(d.promise);

    // A composer screen's pick, in flight before this screen renders.
    const fromComposer = launchLibraryOnce({ mediaType: 'mixed' });

    const renderer = renderScreen();
    pressAvatar(renderer);

    expect(sheet).not.toHaveBeenCalled();
    expect(mockLaunchImageLibrary).toHaveBeenCalledTimes(1);

    await act(async () => {
      d.resolve({ didCancel: true });
      await fromComposer;
    });

    pressAvatar(renderer);
    expect(sheet).toHaveBeenCalledTimes(1);
  });

  it('shows an error after a rejection and the next press launches again', async () => {
    const sheet = spyChoosePhotoSheet();
    mockLaunchImageLibrary.mockRejectedValueOnce(new Error('picker exploded'));

    const renderer = renderScreen();
    await act(async () => {
      findByTestId(renderer.root, 'avatar-button').props.onPress();
    });

    expect(findTextNode(renderer, 'Failed to open photo library')).toBeDefined();

    // The `finally` released the lock even though the promise rejected.
    mockLaunchImageLibrary.mockResolvedValueOnce({ didCancel: true });
    await act(async () => {
      findByTestId(renderer.root, 'avatar-button').props.onPress();
    });

    expect(sheet).toHaveBeenCalledTimes(2);
    expect(mockLaunchImageLibrary).toHaveBeenCalledTimes(2);
  });

  it('surfaces an errorCode as an error banner and one scrubbed report', async () => {
    spyChoosePhotoSheet();
    mockLaunchImageLibrary.mockResolvedValueOnce({
      errorCode: 'permission',
      errorMessage: 'denied for file:///private/var/avatar.jpg',
    });

    const renderer = renderScreen();
    await act(async () => {
      findByTestId(renderer.root, 'avatar-button').props.onPress();
    });

    expect(findTextNode(renderer, pickerErrorCopy('permission').body)).toBeDefined();
    expect(mockCaptureError).toHaveBeenCalledTimes(1);
    const [reported, ctx] = mockCaptureError.mock.calls[0];
    expect((reported as Error).message).toBe('Image picker error: permission');
    expect(ctx).toEqual({
      level: 'warning',
      tags: { feature: 'media-picker', picker_error_code: 'permission' },
    });
    const serialized = JSON.stringify([(reported as Error).message, ctx]);
    expect(serialized).not.toContain('avatar.jpg');
    expect(serialized).not.toContain('file://');
  });

  it('disables and dims both avatar touchables while a pick is in flight', async () => {
    const d = deferred<Record<string, unknown>>();
    mockLaunchImageLibrary.mockReturnValue(d.promise);

    // A composer screen's pick, in flight before this screen renders.
    const fromComposer = launchLibraryOnce({ mediaType: 'mixed' });
    const renderer = renderScreen();

    const avatar = findByTestId(renderer.root, 'avatar-button');
    const label = findByTestId(renderer.root, 'change-photo-button');
    expect(avatar.props.disabled).toBe(true);
    expect(avatar.props.style).toEqual(expect.objectContaining({ opacity: 0.5 }));
    expect(label.props.disabled).toBe(true);
    // The label itself is what dims -- textTertiary, the composer's idiom.
    const labelText = label.findByType('Text' as unknown as React.ComponentType);
    expect(labelText.props.style.color).toBe(lightColors.textTertiary);

    await act(async () => {
      d.resolve({ didCancel: true });
      await fromComposer;
    });

    const avatarAfter = findByTestId(renderer.root, 'avatar-button');
    expect(avatarAfter.props.disabled).toBe(false);
    expect(avatarAfter.props.style).toEqual(expect.objectContaining({ opacity: 1 }));
  });

  it('leaves both avatar touchables live when no pick is in flight', () => {
    const renderer = renderScreen();

    const avatar = findByTestId(renderer.root, 'avatar-button');
    const label = findByTestId(renderer.root, 'change-photo-button');
    expect(avatar.props.disabled).toBe(false);
    expect(avatar.props.style).toEqual(expect.objectContaining({ opacity: 1 }));
    expect(label.props.disabled).toBe(false);
    const labelText = label.findByType('Text' as unknown as React.ComponentType);
    expect(labelText.props.style.color).toBe(lightColors.blue);
  });
});
