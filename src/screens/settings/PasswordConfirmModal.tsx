/**
 * PasswordConfirmModal — reusable password confirmation dialog.
 *
 * Generalized from DeletePasswordModal. Displays a modal with a secure text
 * input, inline error text (e.g., "Incorrect password" on 403), and
 * loading/disabled state during the async onSubmit callback.
 *
 * Consumers: account deletion (DeletePasswordModal wrapper), key recovery
 * (KeyConflictScreen). Stays in screens/settings until a third consumer.
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

export interface PasswordConfirmModalProps {
  visible: boolean;
  onCancel: () => void;
  onSubmit: (password: string) => Promise<void>;
  /** Inline error message to display (e.g., "Incorrect password") */
  errorMessage: string | null;
  /** Modal title. Default: "Confirm Password" */
  title?: string;
  /** Description text below the title. */
  description?: string;
  /** Submit button label. Default: "Confirm" */
  submitLabel?: string;
  /** Submit button color. Default: theme primary blue. Pass theme.colors.error for destructive. */
  submitColor?: string;
  /** testID prefix for child elements. Default: "password-confirm" */
  testIDPrefix?: string;
}

export const PasswordConfirmModal = React.memo(function PasswordConfirmModal({
  visible,
  onCancel,
  onSubmit,
  errorMessage,
  title = 'Confirm Password',
  description = 'Enter your password to continue.',
  submitLabel = 'Confirm',
  submitColor,
  testIDPrefix = 'password-confirm',
}: PasswordConfirmModalProps): React.JSX.Element {
  const theme = useTheme();
  const resolvedColor = submitColor ?? theme.colors.blue;

  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    if (!password.trim() || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(password);
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

  const submitButtonStyle: ViewStyle = {
    backgroundColor: resolvedColor,
    borderRadius: theme.borderRadius.base,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    opacity: !password.trim() || submitting ? 0.5 : 1,
  };

  const submitTextStyle: TextStyle = {
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
      testID={`${testIDPrefix}-modal`}
    >
      <View style={overlayStyle}>
        <View style={containerStyle}>
          <Text style={titleStyle}>{title}</Text>
          <Text style={descriptionStyle}>{description}</Text>
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
            testID={`${testIDPrefix}-input`}
          />
          <Text style={errorStyle} testID={`${testIDPrefix}-error`}>
            {errorMessage ?? ''}
          </Text>
          <View style={buttonRowStyle}>
            <TouchableOpacity
              onPress={handleCancel}
              style={cancelButtonStyle}
              disabled={submitting}
              testID={`${testIDPrefix}-cancel`}
            >
              <Text style={cancelTextStyle}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleSubmit}
              disabled={!password.trim() || submitting}
              style={submitButtonStyle}
              testID={`${testIDPrefix}-submit`}
            >
              {submitting ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Text style={submitTextStyle}>{submitLabel}</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
});
