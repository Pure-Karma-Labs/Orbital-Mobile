import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { SettingsStackParamList } from './types';
import { useTheme } from '../theme';
import SettingsScreen from '../screens/SettingsScreen';

const Stack = createNativeStackNavigator<SettingsStackParamList>();

export function SettingsStackNavigator(): React.JSX.Element {
  const theme = useTheme();

  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.colors.background },
        animation: 'slide_from_right',
      }}
    >
      <Stack.Screen name="SettingsMain" component={SettingsScreen} />
    </Stack.Navigator>
  );
}
