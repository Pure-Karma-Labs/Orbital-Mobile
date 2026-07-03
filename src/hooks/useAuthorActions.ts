import { useCallback } from 'react';
import { Alert } from 'react-native';
import { useAppStore } from '../stores/useAppStore';

export interface AuthorActionContext {
  contentType: 'thread' | 'reply' | 'message';
  contentId: string;
  groupId?: string;
}

export function useAuthorActions(
  authorId: string,
  authorUsername: string,
  currentUserId: string | null,
  context?: AuthorActionContext,
) {
  const handleReport = useCallback(() => {
    useAppStore.getState().openReportSheet({
      contentType: context?.contentType ?? 'user',
      contentId: context?.contentId,
      groupId: context?.groupId,
      reportedUserId: authorId,
      reportedUsername: authorUsername,
    });
  }, [authorId, authorUsername, context?.contentType, context?.contentId, context?.groupId]);

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
                onPress: () => {
                  useAppStore.getState().blockUser(authorId, authorUsername);
                  // Follow-up: offer to also report
                  Alert.alert(
                    `Blocked @${authorUsername}`,
                    'Also report them to Orbital?',
                    [
                      { text: 'Done', style: 'cancel' },
                      {
                        text: 'Report',
                        onPress: () => {
                          useAppStore.getState().openReportSheet({
                            contentType: context?.contentType ?? 'user',
                            contentId: context?.contentId,
                            groupId: context?.groupId,
                            reportedUserId: authorId,
                            reportedUsername: authorUsername,
                          });
                        },
                      },
                    ],
                  );
                },
              },
            ],
          );
        },
      },
      { text: 'Report', onPress: handleReport },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [authorId, currentUserId, authorUsername, handleReport, context?.contentType, context?.contentId, context?.groupId]);

  return { handleAuthorPress, handleReport };
}
