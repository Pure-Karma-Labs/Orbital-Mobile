/**
 * DeletePasswordModal — account deletion password confirmation.
 *
 * Thin wrapper around the generalized PasswordConfirmModal with delete-specific
 * copy and destructive styling. Kept as a separate import so existing consumers
 * (SettingsScreen) need only a diff in import path.
 */

import React from 'react';
import { useTheme } from '../../theme';
import { PasswordConfirmModal } from './PasswordConfirmModal';

export interface DeletePasswordModalProps {
  visible: boolean;
  onCancel: () => void;
  onSubmit: (password: string) => Promise<void>;
  /** Inline error message to display (e.g., "Incorrect password") */
  errorMessage: string | null;
}

export const DeletePasswordModal = React.memo(function DeletePasswordModal({
  visible,
  onCancel,
  onSubmit,
  errorMessage,
}: DeletePasswordModalProps): React.JSX.Element {
  const theme = useTheme();

  return (
    <PasswordConfirmModal
      visible={visible}
      onCancel={onCancel}
      onSubmit={onSubmit}
      errorMessage={errorMessage}
      title="Confirm Deletion"
      description="Enter your password to permanently delete your account."
      submitLabel="Delete"
      submitColor={theme.colors.error}
      testIDPrefix="delete-password"
    />
  );
});
