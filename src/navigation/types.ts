import type { NavigatorScreenParams } from '@react-navigation/native';
// Type-only, and it must stay that way: this module is imported by every
// navigator and by App.tsx, and a runtime edge to the Meta-import service
// would pull the archive reader and op-sqlite into that graph.
import type { ImportSource } from '../services/metaImport/types';

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

// `ThreadDetail` is mounted on BOTH stacks and its params must stay identical.
// One shared alias is stronger than any compile-time probe over two duplicated
// literals: divergence becomes inexpressible rather than merely detected.
export type ThreadDetailParams = {
  threadId: string;
  threadTitle?: string;
  targetReplyId?: string;
};

// Skeleton for future nested stacks inside tabs
export type ThreadsStackParamList = {
  ThreadsList: undefined;
  ThreadDetail: ThreadDetailParams;
  ComposeThread: ComposeThreadParams;
  CreateOrbit: undefined;
  JoinOrbit: { code?: string } | undefined;
  OrbitSelector: undefined;
};

export type ChatsStackParamList = {
  ChatsList: undefined;
  ChatDetail: { conversationId: string; recipientName?: string; recipientId?: string };
  ComposeChatThread: ComposeThreadParams;
  ThreadDetail: ThreadDetailParams;
  NewChat: undefined;
  SafetyNumber: { contactId: string; contactName: string };
};

/**
 * Both compose routes must keep the SAME params (#826). They share
 * `ComposeThreadParams` today; this probe is the tripwire for a future edit
 * that inlines a literal on one of them. `ComposeThreadScreen` is mounted on
 * the Chats stack through a `React.ComponentType<unknown>` cast
 * (`ChatsStackNavigator.tsx:38`), which erases every param check on the DM
 * route, so such a divergence would otherwise reach runtime unnoticed.
 *
 * What it guarantees (#894): the assignability is checked in BOTH directions,
 * so any non-identical retyping of either route fails — narrowing, widening,
 * and `never` alike. The one hole is `any`, which is assignable both ways. The
 * tuple wrappers (`[T] extends [U]`) stop a union param from distributing,
 * which would otherwise let a widened union pass one leg member-wise.
 *
 * Written as a bare `satisfies` statement rather than a typed const because
 * tsconfig sets noUnusedLocals — a const nothing reads is itself an error.
 */
type ComposeRoutesShareParams = [ChatsStackParamList['ComposeChatThread']] extends [
  ThreadsStackParamList['ComposeThread'],
]
  ? [ThreadsStackParamList['ComposeThread']] extends [ChatsStackParamList['ComposeChatThread']]
    ? true
    : never
  : never;
true satisfies ComposeRoutesShareParams;

/**
 * The Meta-import routes (#928).
 *
 * Params carry NO content: never a basename, a body or a date. `ImportStatus`
 * and `ImportUnmigrated` take none at all — both render from `importStore`,
 * which is the single source that survives a process kill, so a param would
 * only be a second copy that can disagree with it.
 *
 * `ImportHowTo` carries its orbit because the member can switch the active
 * orbit underneath it; the screen must keep importing into the orbit they
 * started from, never into `activeConversationId`.
 */
export type ImportHowToParams = { source: ImportSource; conversationId: string };

export type SettingsStackParamList = {
  SettingsMain: undefined;
  EditProfile: undefined;
  ManageOrbits: undefined;
  FileLibrary: undefined;
  BlockedUsers: undefined;
  PushNotificationSettings: undefined;
  ImportHowTo: ImportHowToParams;
  ImportStatus: undefined;
  ImportUnmigrated: undefined;
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
