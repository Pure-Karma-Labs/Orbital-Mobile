import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { SettingsStackParamList } from './types';
import { useTheme } from '../theme';
import SettingsScreen from '../screens/SettingsScreen';
import EditProfileScreen from '../screens/EditProfileScreen';
import ManageOrbitsScreen from '../screens/ManageOrbitsScreen';
import { FileLibraryScreen } from '../screens/FileLibraryScreen';

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
      <Stack.Screen name="EditProfile" component={EditProfileScreen} />
      <Stack.Screen name="ManageOrbits" component={ManageOrbitsScreen} />
      <Stack.Screen name="FileLibrary" component={FileLibraryScreen} />
    </Stack.Navigator>
  );
}
