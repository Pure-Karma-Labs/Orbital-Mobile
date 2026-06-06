import { useMemo } from 'react';
import { useAppStore } from '../stores/useAppStore';

export function useBlockedSet(): Set<string> {
  const blockedUserIds = useAppStore((s) => s.blockedUserIds);
  return useMemo(() => new Set(blockedUserIds), [blockedUserIds]);
}
