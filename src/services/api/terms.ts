/**
 * Terms of Service API service — acceptance recording.
 */

import { request } from './client';
import type { AcceptTermsResponse } from '../../types/api';

/**
 * POST /api/terms/accept — record the current user's terms acceptance.
 *
 * Server-authoritative: the backend stamps its own TERMS_VERSION, ignoring any
 * client claim. Idempotent — re-accepting upgrades the stored version.
 *
 * IMPORTANT: explicit `body: {}` is required. Omitting the body skips
 * serialization in client.ts, sending a POST with no Content-Type header.
 * Proxies and WAFs may mangle or reject such requests.
 */
export function acceptTerms(): Promise<AcceptTermsResponse> {
  return request<AcceptTermsResponse>({
    method: 'POST',
    path: '/api/terms/accept',
    body: {},
  });
}
