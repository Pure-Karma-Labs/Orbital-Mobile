import type { LinkingOptions } from '@react-navigation/native';
import type { RootStackParamList } from './types';

export const linking: LinkingOptions<RootStackParamList> = {
  prefixes: ['orbital://'],
  config: {
    screens: {
      MainTabs: {
        screens: {
          Threads: {
            screens: {
              ThreadsList: 'threads',
              ThreadDetail: 'threads/:threadId',
              JoinOrbit: 'join/:code',
            },
          },
          Chats: {
            screens: {
              ChatsList: 'chats',
              ChatDetail: 'chats/:conversationId',
            },
          },
          Settings: 'settings',
        },
      },
    },
  },
};
