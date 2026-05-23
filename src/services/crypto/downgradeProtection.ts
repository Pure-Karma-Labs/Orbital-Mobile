// Downgrade protection: tracks which groups have received an ECIES-wrapped key.
// Once a group is ECIES-locked, raw-format keys are rejected for that group.
// Uses the `items` table with key prefix "ecies_locked:" for persistence.

import { setItem, getAllItems } from '../../database/repositories/itemRepository';

const ECIES_LOCK_PREFIX = 'ecies_locked:';

const lockedGroups = new Set<string>();

export function markEciesLocked(groupId: string): void {
  if (lockedGroups.has(groupId)) return;
  lockedGroups.add(groupId);
  try {
    setItem(`${ECIES_LOCK_PREFIX}${groupId}`, '1');
  } catch {
    // DB may not be initialized — in-memory state is still set
  }
}

export function isEciesLocked(groupId: string): boolean {
  return lockedGroups.has(groupId);
}

export function loadEciesLockState(): void {
  try {
    const items = getAllItems();
    for (const item of items) {
      if (item.id.startsWith(ECIES_LOCK_PREFIX)) {
        lockedGroups.add(item.id.slice(ECIES_LOCK_PREFIX.length));
      }
    }
  } catch {
    // DB may not be initialized yet
  }
}

export function clearEciesLockState(): void {
  lockedGroups.clear();
}
