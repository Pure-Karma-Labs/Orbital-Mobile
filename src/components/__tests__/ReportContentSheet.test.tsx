/**
 * Tests for ReportContentSheet — submit gating, payload shape, cancel.
 */

import React from 'react';
import { Alert } from 'react-native';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { ReportContentSheet } from '../ReportContentSheet';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, right: 0, bottom: 34, left: 0 }),
}));

jest.mock('../../services/api/reports', () => ({
  createReport: jest.fn(),
}));

// Mock the store module — avoids MMKV native module dependency
let mockReportTarget: unknown = null;
const mockCloseReportSheet = jest.fn(() => { mockReportTarget = null; });

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) => {
    const state: Record<string, unknown> = {
      reportTarget: mockReportTarget,
      closeReportSheet: mockCloseReportSheet,
    };
    return selector(state);
  },
}));

import { createReport } from '../../services/api/reports';
const mockCreateReport = createReport as jest.Mock;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openSheet(target = {
  contentType: 'thread' as const,
  contentId: 'thread-1',
  reportedUserId: 'user-bad',
  reportedUsername: 'badactor',
  groupId: 'group-1',
}) {
  mockReportTarget = target;
}

function renderSheet(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(ReportContentSheet),
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

function findAllByTestId(root: ReactTestInstance, testID: string): ReactTestInstance[] {
  return root.findAll((node) => node.props.testID === testID);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockReportTarget = null;
});

describe('ReportContentSheet — visibility', () => {
  it('modal is not visible when reportTarget is null', () => {
    const renderer = renderSheet();
    const modal = findByTestId(renderer.root, 'report-sheet');
    expect(modal.props.visible).toBe(false);
  });

  it('modal is visible when reportTarget is set', () => {
    openSheet();
    const renderer = renderSheet();
    const modal = findByTestId(renderer.root, 'report-sheet');
    expect(modal.props.visible).toBe(true);
  });
});

describe('ReportContentSheet — submit gating', () => {
  it('submit button is disabled when no reason is selected', () => {
    openSheet();
    const renderer = renderSheet();
    const submitBtn = findByTestId(renderer.root, 'report-submit-button');
    expect(submitBtn.props.disabled).toBe(true);
  });

  it('submit button is enabled after selecting a reason', () => {
    openSheet();
    const renderer = renderSheet();

    act(() => {
      findByTestId(renderer.root, 'report-reason-spam').props.onPress();
    });

    const submitBtn = findByTestId(renderer.root, 'report-submit-button');
    expect(submitBtn.props.disabled).toBeFalsy();
  });
});

describe('ReportContentSheet — submission', () => {
  it('calls createReport with correct payload on submit', async () => {
    mockCreateReport.mockResolvedValue({ id: 'r-1', status: 'pending' });
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    openSheet();
    const renderer = renderSheet();

    act(() => {
      findByTestId(renderer.root, 'report-reason-harassment').props.onPress();
    });

    await act(async () => {
      findByTestId(renderer.root, 'report-submit-button').props.onPress();
    });

    expect(mockCreateReport).toHaveBeenCalledWith({
      contentType: 'thread',
      contentId: 'thread-1',
      reportedUserId: 'user-bad',
      groupId: 'group-1',
      reason: 'harassment',
      details: undefined,
    });

    (Alert.alert as jest.Mock).mockRestore();
  });

  it('shows success alert after successful submission', async () => {
    mockCreateReport.mockResolvedValue({ id: 'r-1', status: 'pending' });
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    openSheet();
    const renderer = renderSheet();

    act(() => {
      findByTestId(renderer.root, 'report-reason-spam').props.onPress();
    });

    await act(async () => {
      findByTestId(renderer.root, 'report-submit-button').props.onPress();
    });

    expect(Alert.alert).toHaveBeenCalledWith(
      'Report received',
      'Our team reviews all reports within 24 hours and will remove offending content and eject abusive users.',
    );

    (Alert.alert as jest.Mock).mockRestore();
  });

  it('includes details when provided', async () => {
    mockCreateReport.mockResolvedValue({ id: 'r-1', status: 'pending' });
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    openSheet();
    const renderer = renderSheet();

    act(() => {
      findByTestId(renderer.root, 'report-reason-other').props.onPress();
      findByTestId(renderer.root, 'report-details-input').props.onChangeText('This user is abusive');
    });

    await act(async () => {
      findByTestId(renderer.root, 'report-submit-button').props.onPress();
    });

    expect(mockCreateReport).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'other',
        details: 'This user is abusive',
      }),
    );

    (Alert.alert as jest.Mock).mockRestore();
  });

  it('shows error banner on submission failure', async () => {
    mockCreateReport.mockRejectedValue(new Error('Network timeout'));

    openSheet();
    const renderer = renderSheet();

    act(() => {
      findByTestId(renderer.root, 'report-reason-spam').props.onPress();
    });

    await act(async () => {
      findByTestId(renderer.root, 'report-submit-button').props.onPress();
    });

    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const errorText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.includes('Network timeout'),
    );
    expect(errorText).toBeDefined();
  });
});

describe('ReportContentSheet — cancel', () => {
  it('calls closeReportSheet when cancel is pressed', () => {
    openSheet();
    const renderer = renderSheet();

    act(() => {
      findByTestId(renderer.root, 'report-cancel-button').props.onPress();
    });

    expect(mockCloseReportSheet).toHaveBeenCalled();
  });
});

describe('ReportContentSheet — reason radio buttons', () => {
  it('renders all 4 reason options', () => {
    openSheet();
    const renderer = renderSheet();

    expect(findAllByTestId(renderer.root, 'report-reason-spam').length).toBeGreaterThanOrEqual(1);
    expect(findAllByTestId(renderer.root, 'report-reason-harassment').length).toBeGreaterThanOrEqual(1);
    expect(findAllByTestId(renderer.root, 'report-reason-inappropriate_content').length).toBeGreaterThanOrEqual(1);
    expect(findAllByTestId(renderer.root, 'report-reason-other').length).toBeGreaterThanOrEqual(1);
  });
});

describe('ReportContentSheet — details input', () => {
  it('renders details input with maxLength 500', () => {
    openSheet();
    const renderer = renderSheet();
    const input = findByTestId(renderer.root, 'report-details-input');
    expect(input.props.maxLength).toBe(500);
  });

  it('renders the E2EE disclosure helper text', () => {
    openSheet();
    const renderer = renderSheet();
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const helper = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.includes('not end-to-end encrypted'),
    );
    expect(helper).toBeDefined();
  });
});
