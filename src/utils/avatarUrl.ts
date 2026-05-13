/**
 * Avatar URL construction with path validation.
 *
 * Only allows paths matching the expected avatar path format.
 * Rejects anything that could be used for open redirect or SSRF.
 */

import { API_BASE_URL } from '../services/api/client';

const AVATAR_PATH_REGEX = /^\/avatars\/[A-Za-z0-9._-]+$/;

/**
 * Convert a server avatar path to a full HTTPS URL.
 *
 * @param path - Avatar path from the API (e.g. "/avatars/abc123.jpg")
 * @returns Full URL or null if the path is missing or invalid
 */
export function getAvatarUrl(path: string | null | undefined): string | null {
  if (!path || !AVATAR_PATH_REGEX.test(path)) return null;
  return `${API_BASE_URL}${path}`;
}
