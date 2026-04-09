import type { LinkingOptions } from '@react-navigation/native';
import type { RootStackParamList } from './types';

export const linking: LinkingOptions<RootStackParamList> = {
  prefixes: ['orbital://'],
  config: {
    screens: {
      MainTabs: {
        screens: {
          Threads: 'threads',
          Chats: 'chats',
          Settings: 'settings',
        },
      },
    },
  },
};
