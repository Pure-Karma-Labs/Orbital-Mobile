import type { NavigatorScreenParams } from '@react-navigation/native';

export type MainTabParamList = {
  Threads: undefined;
  Chats: undefined;
  Settings: undefined;
};

// Skeleton for future nested stacks inside tabs
export type ThreadsStackParamList = {
  ThreadsList: undefined;
  ThreadDetail: { threadId: string; threadTitle?: string };
  ComposeThread: { groupId: string };
  CreateOrbit: undefined;
  JoinOrbit: undefined;
  OrbitSelector: undefined;
};

export type ChatsStackParamList = {
  ChatsList: undefined;
  ChatDetail: { conversationId: string; recipientName?: string };
  ComposeChatThread: { groupId: string };
  ThreadDetail: { threadId: string; threadTitle?: string };
  NewChat: undefined;
};

export type SettingsStackParamList = {
  SettingsMain: undefined;
  EditProfile: undefined;
};

export type RootStackParamList = {
  MainTabs: NavigatorScreenParams<MainTabParamList>;
};

// Global type augmentation for useNavigation()
declare global {
  namespace ReactNavigation {
    interface RootParamList extends RootStackParamList {}
  }
}
