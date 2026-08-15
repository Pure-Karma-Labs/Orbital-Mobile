const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Human-readable size for user-facing messages. "<1 MB", "24 MB", "1.2 GB". */
export function formatMB(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes < MB) return '<1 MB';
  return `${Math.round(bytes / MB)} MB`;
}

/**
 * Progress readout for a transfer: "14 MB / 32 MB", "0.3 GB / 1.4 GB".
 *
 * Unlike formatMB applied twice, ONE unit is picked from the total and used for
 * both sides, so the pair can never render "<1 MB / 32 MB" or mix MB with GB —
 * both of which make a progress readout unreadable. `sent` is floored at 0;
 * non-finite inputs render as 0.
 */
export function formatMBPair(sentBytes: number, totalBytes: number): string {
  const total = Number.isFinite(totalBytes) ? Math.max(0, totalBytes) : 0;
  const sent = Number.isFinite(sentBytes) ? Math.max(0, sentBytes) : 0;
  if (total >= GB) {
    return `${(sent / GB).toFixed(1)} GB / ${(total / GB).toFixed(1)} GB`;
  }
  return `${Math.round(sent / MB)} MB / ${Math.round(total / MB)} MB`;
}
