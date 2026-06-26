import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../stores';

export interface ContactAvatarProps {
  userId: string | null;
  groupId: string | null;
  encryptedAvatarKey: string | null;
  avatarKeyIv: string | null;
  avatarDigest: string | null;
}

const EMPTY: ContactAvatarProps = {
  userId: null,
  groupId: null,
  encryptedAvatarKey: null,
  avatarKeyIv: null,
  avatarDigest: null,
};

export function useContactAvatar(
  authorId: string | null | undefined,
  groupId: string | null | undefined,
): ContactAvatarProps {
  return useAppStore(useShallow((s) => {
    if (!authorId) return EMPTY;
    const contact = s.contacts[authorId];
    if (!contact?.avatarDigest) return { ...EMPTY, userId: authorId, groupId: groupId ?? null };
    return {
      userId: authorId,
      groupId: groupId ?? null,
      encryptedAvatarKey: contact.avatarEncryptedKey ?? null,
      avatarKeyIv: contact.avatarKeyIv ?? null,
      avatarDigest: contact.avatarDigest,
    };
  }));
}
