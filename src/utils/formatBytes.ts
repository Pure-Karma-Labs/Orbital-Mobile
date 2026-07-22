/** Human-readable size for user-facing messages. "<1 MB", "24 MB", "1.2 GB". */
export function formatMB(bytes: number): string {
  const MB = 1024 * 1024;
  if (bytes >= 1024 * MB) return `${(bytes / (1024 * MB)).toFixed(1)} GB`;
  if (bytes < MB) return '<1 MB';
  return `${Math.round(bytes / MB)} MB`;
}
