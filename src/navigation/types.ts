import type { NavigatorScreenParams } from '@react-navigation/native';

export type MainTabParamList = {
  Threads: NavigatorScreenParams<ThreadsStackParamList> | undefined;
  Chats: NavigatorScreenParams<ChatsStackParamList> | undefined;
  Settings: NavigatorScreenParams<SettingsStackParamList> | undefined;
};

// `isDm` is REQUIRED (#745/#826) so the composer's `dm: 'false'` telemetry tag
// can only ever mean "a known orbit". Never relax it back to optional: an
// undefined `dm` must stay undefined (the tag is omitted), never be coerced to
// false.
export type ComposeThreadParams = { groupId: string; isDm: boolean };

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

/**
 * Both compose routes must keep the SAME params (#826). `ComposeThreadScreen`
 * is mounted on the Chats stack through a `React.ComponentType<unknown>` cast
 * (`ChatsStackNavigator.tsx:38`), which erases every param check on the DM
 * route — so if `ComposeChatThread` drifted, nothing else would notice. A drift
 * makes this alias `never` and the assertion below a compile error.
 *
 * Written as a bare `satisfies` statement rather than a typed const because
 * tsconfig sets noUnusedLocals — a const nothing reads is itself an error.
 */
type ComposeRoutesShareParams =
  ChatsStackParamList['ComposeChatThread'] extends ThreadsStackParamList['ComposeThread']
    ? true
    : never;
true satisfies ComposeRoutesShareParams;

export type SettingsStackParamList = {
  SettingsMain: undefined;
  EditProfile: undefined;
  ManageOrbits: undefined;
  FileLibrary: undefined;
  BlockedUsers: undefined;
  PushNotificationSettings: undefined;
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
