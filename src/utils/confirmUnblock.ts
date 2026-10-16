/**
 * The one unblock confirmation (#908).
 *
 * Moved out of `settings/BlockedUsersScreen` unchanged so the Blocked Users
 * list and the in-DM blocked notice ask the same question with the same words.
 */

import { Alert } from 'react-native';
import { unblockUserAndRefresh } from '../services/blockedContentRefresh';

/**
 * Ask before unblocking, then unblock.
 *
 * @param userId - The blocked user's id.
 * @param label  - Already handle-composed by the caller (`@name` only when
 *   resolved — see `blockedUserLabel`). Never compose an `@` here.
 */
export function confirmUnblock(userId: string, label: string): void {
  Alert.alert(`Unblock ${label}?`, 'You will see their posts and replies again.', [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Unblock',
      // #897: unblocking changes the server's per-viewer answer for every
      // list, so the lists are re-pulled once the DELETE settles.
      onPress: () => void unblockUserAndRefresh(userId),
    },
  ]);
}
