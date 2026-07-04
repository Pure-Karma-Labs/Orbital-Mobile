/**
 * Tests for the terms API service.
 */

jest.mock('../client', () => ({
  request: jest.fn(),
}));

import { request } from '../client';
import { acceptTerms } from '../terms';

const mockRequest = request as jest.MockedFunction<typeof request>;

beforeEach(() => {
  jest.clearAllMocks();
  mockRequest.mockResolvedValue({
    accepted: true,
    termsVersion: 1,
    termsAcceptedAt: '2026-07-04T00:00:00Z',
  });
});

describe('acceptTerms', () => {
  it('calls POST /api/terms/accept with explicit empty body', async () => {
    await acceptTerms();

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/terms/accept',
      body: {},
    });
  });

  it('does NOT pass skipAuth (endpoint requires authentication)', async () => {
    await acceptTerms();

    const callArg = mockRequest.mock.calls[0][0];
    expect(callArg).not.toHaveProperty('skipAuth', true);
  });

  it('returns the server response', async () => {
    const result = await acceptTerms();

    expect(result).toEqual({
      accepted: true,
      termsVersion: 1,
      termsAcceptedAt: '2026-07-04T00:00:00Z',
    });
  });
});
