/**
 * DeletePasswordModal — collects the user's password for account deletion confirmation.
 *
 * Displays a modal with a secure text input, inline error text (e.g., "Incorrect password"
 * on 403), and loading/disabled state during the API call.
 */

import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../../theme';

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

  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    if (!password.trim() || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(password);
      // Clear password from component state after submission completes
      // (regardless of outcome — prevents sensitive data lingering in memory)
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  }, [password, submitting, onSubmit]);

  const handleCancel = useCallback(() => {
    setPassword('');
    onCancel();
  }, [onCancel]);

  const overlayStyle: ViewStyle = {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing.lg,
  };

  const containerStyle: ViewStyle = {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.borderRadius.base,
    padding: theme.spacing.lg,
    width: '100%',
    maxWidth: 340,
  };

  const titleStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.header,
    fontSize: theme.typography.fontSize.lg,
    color: theme.colors.textPrimary,
    marginBottom: theme.spacing.sm,
  };

  const descriptionStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textSecondary,
    marginBottom: theme.spacing.md,
  };

  const inputStyle: TextStyle = {
    borderWidth: 1,
    borderColor: errorMessage ? theme.colors.error : theme.colors.borderSubtle,
    borderRadius: theme.borderRadius.base,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
    marginBottom: theme.spacing.sm,
  };

  const errorStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.error,
    marginBottom: theme.spacing.md,
    minHeight: 18,
  };

  const buttonRowStyle: ViewStyle = {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  };

  const cancelButtonStyle: ViewStyle = {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    marginRight: theme.spacing.md,
  };

  const cancelTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textSecondary,
  };

  const deleteButtonStyle: ViewStyle = {
    backgroundColor: theme.colors.error,
    borderRadius: theme.borderRadius.base,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    opacity: !password.trim() || submitting ? 0.5 : 1,
  };

  const deleteTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.base,
    color: '#FFFFFF',
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleCancel}
      testID="delete-password-modal"
    >
      <View style={overlayStyle}>
        <View style={containerStyle}>
          <Text style={titleStyle}>Confirm Deletion</Text>
          <Text style={descriptionStyle}>
            Enter your password to permanently delete your account.
          </Text>
          <TextInput
            style={inputStyle}
            value={password}
            onChangeText={setPassword}
            placeholder="Password"
            placeholderTextColor={theme.colors.textTertiary}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            editable={!submitting}
            testID="delete-password-input"
          />
          <Text style={errorStyle} testID="delete-password-error">
            {errorMessage ?? ''}
          </Text>
          <View style={buttonRowStyle}>
            <TouchableOpacity
              onPress={handleCancel}
              style={cancelButtonStyle}
              disabled={submitting}
              testID="delete-password-cancel"
            >
              <Text style={cancelTextStyle}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleSubmit}
              disabled={!password.trim() || submitting}
              style={deleteButtonStyle}
              testID="delete-password-submit"
            >
              {submitting ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Text style={deleteTextStyle}>Delete</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
});
