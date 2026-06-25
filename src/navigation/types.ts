import type { NavigatorScreenParams } from '@react-navigation/native';

export type MainTabParamList = {
  Threads: NavigatorScreenParams<ThreadsStackParamList> | undefined;
  Chats: NavigatorScreenParams<ChatsStackParamList> | undefined;
  Settings: NavigatorScreenParams<SettingsStackParamList> | undefined;
};

export type ComposeThreadParams = { groupId: string; isDm?: boolean };

// Skeleton for future nested stacks inside tabs
export type ThreadsStackParamList = {
  ThreadsList: undefined;
  ThreadDetail: { threadId: string; threadTitle?: string; targetReplyId?: string };
  ComposeThread: ComposeThreadParams;
  CreateOrbit: undefined;
  JoinOrbit: { code?: string } | undefined;
  OrbitSelector: undefined;
};

export type ChatsStackParamList = {
  ChatsList: undefined;
  ChatDetail: { conversationId: string; recipientName?: string; recipientId?: string };
  ComposeChatThread: ComposeThreadParams;
  ThreadDetail: { threadId: string; threadTitle?: string; targetReplyId?: string };
  NewChat: undefined;
  SafetyNumber: { contactId: string; contactName: string };
};

export type SettingsStackParamList = {
  SettingsMain: undefined;
  EditProfile: undefined;
  ManageOrbits: undefined;
  FileLibrary: undefined;
  BlockedUsers: undefined;
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
