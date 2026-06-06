import { useCallback } from 'react';
import { Alert, Linking } from 'react-native';
import { useAppStore } from '../stores/useAppStore';

const REPORT_EMAIL = 'report@orbitl.org';

export function useAuthorActions(
  authorId: string,
  authorUsername: string,
  currentUserId: string | null,
) {
  const handleReport = useCallback(() => {
    const subject = 'Content Report — Orbital';
    const reportBody = `Reporting user: @${authorUsername}\n\nNote: Orbital uses end-to-end encryption, so we cannot view message content. Please describe the issue below.\n\n---\n`;
    const mailto = `mailto:${REPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(reportBody)}`;
    Linking.canOpenURL(mailto).then((supported) => {
      if (supported) {
        Linking.openURL(mailto);
      } else {
        Alert.alert(
          'Send Report',
          `Email ${REPORT_EMAIL} with details about this user.`,
          [{ text: 'OK' }],
        );
      }
    });
  }, [authorUsername]);

  const handleAuthorPress = useCallback(() => {
    if (authorId === currentUserId) return;

    Alert.alert(authorUsername, '', [
      {
        text: 'Block',
        style: 'destructive',
        onPress: () => {
          Alert.alert(
            `Block @${authorUsername}?`,
            'You will no longer see their posts or replies.',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Block',
                style: 'destructive',
                onPress: () => useAppStore.getState().blockUser(authorId, authorUsername),
              },
            ],
          );
        },
      },
      { text: 'Report', onPress: handleReport },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [authorId, currentUserId, authorUsername, handleReport]);

  return { handleAuthorPress, handleReport };
}
