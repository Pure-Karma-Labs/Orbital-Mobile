import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { SettingsStackParamList } from './types';
import { useTheme } from '../theme';
import SettingsScreen from '../screens/SettingsScreen';
import EditProfileScreen from '../screens/EditProfileScreen';
import ManageOrbitsScreen from '../screens/ManageOrbitsScreen';
import { FileLibraryScreen } from '../screens/FileLibraryScreen';
import BlockedUsersScreen from '../screens/settings/BlockedUsersScreen';
import PushNotificationSettingsScreen from '../screens/settings/PushNotificationSettingsScreen';
import ImportHowToScreen from '../screens/import/ImportHowToScreen';
import ImportStatusScreen from '../screens/import/ImportStatusScreen';
import ImportUnmigratedScreen from '../screens/import/ImportUnmigratedScreen';

const Stack = createNativeStackNavigator<SettingsStackParamList>();

export function SettingsStackNavigator(): React.JSX.Element {
  const theme = useTheme();

  return (
    <Stack.Navigator
      // Explicit, not declaration-order (#486): this literal is typed against
      // SettingsStackParamList, and TAB_INITIAL_SCREENS.Settings must agree with
      // it or the tab-reset behaviour in MainTabNavigator silently diverges.
      initialRouteName="SettingsMain"
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
      <Stack.Screen name="BlockedUsers" component={BlockedUsersScreen} />
      <Stack.Screen
        name="PushNotificationSettings"
        component={PushNotificationSettingsScreen}
      />
      {/*
        #928. Three FLAT routes, not a nested import stack: the member can
        reach the status screen from the tab-bar strip without Settings being
        focused, and a nested navigator would make that a two-step dispatch.
        `linking.ts` is untouched — none of them is deep-linkable.
      */}
      <Stack.Screen name="ImportHowTo" component={ImportHowToScreen} />
      <Stack.Screen name="ImportStatus" component={ImportStatusScreen} />
      <Stack.Screen name="ImportUnmigrated" component={ImportUnmigratedScreen} />
    </Stack.Navigator>
  );
}
