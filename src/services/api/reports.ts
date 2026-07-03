/**
 * Reports API service — content reporting for UGC compliance.
 */

import { request } from './client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReportContentType = 'user' | 'thread' | 'reply' | 'message' | 'media';

export type ReportReason = 'spam' | 'harassment' | 'inappropriate_content' | 'other';

export interface CreateReportBody {
  contentType: ReportContentType;
  contentId?: string;
  reportedUserId?: string;
  groupId?: string;
  reason: ReportReason;
  details?: string;
}

export interface CreateReportResponse {
  id: string;
  status: string;
}

// ---------------------------------------------------------------------------
// API call
// ---------------------------------------------------------------------------

export function createReport(body: CreateReportBody): Promise<CreateReportResponse> {
  return request<CreateReportResponse>({
    method: 'POST',
    path: '/api/reports',
    body,
  });
}
