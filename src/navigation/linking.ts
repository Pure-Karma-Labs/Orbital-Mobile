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
            },
          },
          Chats: 'chats',
          Settings: 'settings',
        },
      },
    },
  },
};
