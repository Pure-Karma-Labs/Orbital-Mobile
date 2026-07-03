/**
 * TermsCheckbox — affirmative EULA acceptance gate for auth screens.
 *
 * Hand-rolled checkbox row with inline link Texts. Links open in the
 * external browser without toggling the checkbox state.
 */

import React from 'react';
import {
  Linking,
  Text,
  TouchableOpacity,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../theme';

export interface TermsCheckboxProps {
  checked: boolean;
  onToggle: () => void;
  /** When true, includes Privacy Policy link (used on signup). */
  includePrivacyLink?: boolean;
  testID?: string;
}

export function TermsCheckbox({
  checked,
  onToggle,
  includePrivacyLink = false,
  testID,
}: TermsCheckboxProps): React.JSX.Element {
  const theme = useTheme();

  const rowStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginVertical: theme.spacing.md,
  };

  const checkboxStyle: ViewStyle = {
    width: 22,
    height: 22,
    borderWidth: 2,
    borderColor: checked ? theme.colors.blue : theme.colors.borderStrong,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: checked ? theme.colors.blue : 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: theme.spacing.sm,
    marginTop: 1,
  };

  const checkmarkStyle: TextStyle = {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: 'bold',
    lineHeight: 18,
  };

  const labelStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textSecondary,
    flex: 1,
    lineHeight: theme.typography.fontSize.sm * theme.typography.lineHeight.relaxed,
  };

  const legalLinkStyle: TextStyle = {
    color: theme.colors.blue,
    textDecorationLine: 'underline',
  };

  // Derive link testIDs from checkbox testID
  // signup-terms-checkbox -> prefix "signup" -> signup-terms-link, signup-privacy-link
  // login-terms-checkbox  -> prefix "login"  -> login-terms-link
  const testIDPrefix = testID ? testID.replace('-terms-checkbox', '') : undefined;

  return (
    <View style={rowStyle}>
      <TouchableOpacity
        style={checkboxStyle}
        onPress={onToggle}
        accessibilityRole="checkbox"
        accessibilityState={{ checked }}
        testID={testID}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        {checked && <Text style={checkmarkStyle}>{'✓'}</Text>}
      </TouchableOpacity>
      <Text style={labelStyle}>
        {'I agree to the '}
        <Text
          style={legalLinkStyle}
          accessibilityRole="link"
          testID={testIDPrefix ? `${testIDPrefix}-terms-link` : undefined}
          onPress={() => Linking.openURL('https://orbitl.org/terms').catch(() => {})}
        >
          Terms of Use
        </Text>
        {includePrivacyLink ? (
          <>
            {' and '}
            <Text
              style={legalLinkStyle}
              accessibilityRole="link"
              testID={testIDPrefix ? `${testIDPrefix}-privacy-link` : undefined}
              onPress={() => Linking.openURL('https://orbitl.org/privacy').catch(() => {})}
            >
              Privacy Policy
            </Text>
          </>
        ) : null}
        {'. Orbital has zero tolerance for objectionable content and abusive users; offending content and accounts will be removed.'}
      </Text>
    </View>
  );
}
