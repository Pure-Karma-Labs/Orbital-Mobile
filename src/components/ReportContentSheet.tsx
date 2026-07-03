/**
 * ReportContentSheet — globally-mounted modal for reporting content.
 *
 * Driven by the reportSlice in useAppStore. A single instance is mounted
 * in the authenticated branch of App.tsx; any call site opens it via
 * openReportSheet(target) on the store.
 *
 * Submits to POST /api/reports. On success, shows a confirmation Alert.
 * On failure, shows an inline ErrorBanner (client already retries 429s
 * internally — no UI auto-retry).
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Modal,
  ScrollView,
  Text,
  TextInput as RNTextInput,
  TouchableOpacity,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { useAppStore } from '../stores/useAppStore';
import { createReport, type ReportReason } from '../services/api/reports';
import { ErrorBanner } from './ErrorBanner';
import { OrbitalSpinner } from './OrbitalSpinner';

// ---------------------------------------------------------------------------
// Reason options
// ---------------------------------------------------------------------------

const REASONS: { value: ReportReason; label: string }[] = [
  { value: 'spam', label: 'Spam' },
  { value: 'harassment', label: 'Harassment' },
  { value: 'inappropriate_content', label: 'Inappropriate content' },
  { value: 'other', label: 'Other' },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ReportContentSheet(): React.JSX.Element | null {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const reportTarget = useAppStore((s) => s.reportTarget);
  const closeReportSheet = useAppStore((s) => s.closeReportSheet);

  const [selectedReason, setSelectedReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form state when target changes (new report or sheet closed)
  useEffect(() => {
    if (reportTarget) {
      setSelectedReason(null);
      setDetails('');
      setError(null);
      setLoading(false);
    }
  }, [reportTarget]);

  const handleSubmit = useCallback(async () => {
    if (!selectedReason || !reportTarget) return;

    setError(null);
    setLoading(true);
    try {
      await createReport({
        contentType: reportTarget.contentType,
        contentId: reportTarget.contentId,
        reportedUserId: reportTarget.reportedUserId,
        groupId: reportTarget.groupId,
        reason: selectedReason,
        details: details.trim() || undefined,
      });
      closeReportSheet();
      Alert.alert(
        'Report received',
        'Our team reviews all reports within 24 hours and will remove offending content and eject abusive users.',
      );
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Failed to submit report';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [selectedReason, reportTarget, details, closeReportSheet]);

  const visible = reportTarget !== null;

  // Derive title
  let title = 'Report content';
  if (reportTarget?.reportedUsername) {
    title = `Report @${reportTarget.reportedUsername}`;
  } else if (reportTarget?.contentType === 'media') {
    title = 'Report photo';
  }

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------

  const overlayStyle: ViewStyle = {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  };

  const sheetStyle: ViewStyle = {
    backgroundColor: theme.colors.surfaceElevated,
    borderTopLeftRadius: theme.borderRadius.base * 4,
    borderTopRightRadius: theme.borderRadius.base * 4,
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.lg,
    paddingBottom: Math.max(insets.bottom, theme.spacing.lg),
    maxHeight: '80%',
  };

  const titleStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.header,
    fontSize: theme.typography.fontSize.xl,
    color: theme.colors.textPrimary,
    marginBottom: theme.spacing.md,
  };

  const reasonRowStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: theme.spacing.sm + 2,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderSubtle,
  };

  const radioStyle = (selected: boolean): ViewStyle => ({
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: selected ? theme.colors.blue : theme.colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: theme.spacing.sm,
  });

  const radioDotStyle: ViewStyle = {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: theme.colors.blue,
  };

  const reasonLabelStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
  };

  const detailsInputStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
    borderWidth: 1,
    borderColor: theme.colors.borderStrong,
    borderRadius: theme.borderRadius.base,
    paddingHorizontal: theme.spacing.base,
    paddingVertical: theme.spacing.sm,
    marginTop: theme.spacing.md,
    minHeight: 80,
    textAlignVertical: 'top',
  };

  const helperTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.xs,
    color: theme.colors.textTertiary,
    marginTop: theme.spacing.xs,
    lineHeight: theme.typography.fontSize.xs * theme.typography.lineHeight.relaxed,
  };

  const buttonRowStyle: ViewStyle = {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: theme.spacing.lg,
    gap: theme.spacing.base,
  };

  const cancelButtonStyle: ViewStyle = {
    paddingVertical: theme.spacing.sm + 2,
    paddingHorizontal: theme.spacing.base,
    borderRadius: theme.borderRadius.base,
    borderWidth: 1,
    borderColor: theme.colors.borderStrong,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  };

  const cancelTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
  };

  const submitButtonStyle: ViewStyle = {
    paddingVertical: theme.spacing.sm + 2,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.blue,
    opacity: !selectedReason || loading ? 0.5 : 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
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
      animationType="slide"
      onRequestClose={closeReportSheet}
      statusBarTranslucent
      testID="report-sheet"
    >
      <TouchableOpacity
        style={overlayStyle}
        activeOpacity={1}
        onPress={closeReportSheet}
      >
        <TouchableOpacity
          style={sheetStyle}
          activeOpacity={1}
          onPress={() => {}}
        >
          <ScrollView bounces={false} keyboardShouldPersistTaps="handled">
            <Text style={titleStyle}>{title}</Text>

            {REASONS.map((reason) => (
              <TouchableOpacity
                key={reason.value}
                style={reasonRowStyle}
                onPress={() => setSelectedReason(reason.value)}
                testID={`report-reason-${reason.value}`}
                accessibilityRole="radio"
                accessibilityState={{ selected: selectedReason === reason.value }}
              >
                <View style={radioStyle(selectedReason === reason.value)}>
                  {selectedReason === reason.value && <View style={radioDotStyle} />}
                </View>
                <Text style={reasonLabelStyle}>{reason.label}</Text>
              </TouchableOpacity>
            ))}

            <RNTextInput
              style={detailsInputStyle}
              placeholder="Additional details (optional)"
              placeholderTextColor={theme.colors.textTertiary}
              value={details}
              onChangeText={setDetails}
              maxLength={500}
              multiline
              testID="report-details-input"
            />
            <Text style={helperTextStyle}>
              This will be shared with the Orbital moderation team and is not end-to-end encrypted.
            </Text>

            <ErrorBanner message={error} />

            <View style={buttonRowStyle}>
              <TouchableOpacity
                style={cancelButtonStyle}
                onPress={closeReportSheet}
                testID="report-cancel-button"
                accessibilityRole="button"
                accessibilityLabel="Cancel report"
              >
                <Text style={cancelTextStyle}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={submitButtonStyle}
                onPress={handleSubmit}
                disabled={!selectedReason || loading}
                testID="report-submit-button"
                accessibilityRole="button"
                accessibilityLabel="Submit report"
                accessibilityState={{ disabled: !selectedReason || loading }}
              >
                {loading ? (
                  <OrbitalSpinner size={20} />
                ) : (
                  <Text style={submitTextStyle}>Submit</Text>
                )}
              </TouchableOpacity>
            </View>
          </ScrollView>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}
