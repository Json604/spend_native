import { DarkTheme, NavigationContainer, type Theme } from "@react-navigation/native";
import { createStackNavigator, TransitionPresets } from "@react-navigation/stack";
import SpendMain from "../features/spend/screens/SpendMain";
import ManualEntrySheet from "../features/spend/screens/ManualEntrySheet";
import BudgetPlanner from "../features/spend/screens/BudgetPlanner";
import SignInScreen from "../features/auth/screens/SignInScreen";
import ProfileScreen from "../features/auth/screens/ProfileScreen";
import { useAuth } from "../auth/AuthProvider";
import type { StackParamList } from "./types";

const Stack = createStackNavigator<StackParamList>();

const GROUND = "#070709";

// NavigationContainer's default theme is LIGHT. Its background is what shows
// through underneath a screen mid-transition, which is the white flash between
// screens — cardStyle alone cannot fix it, because the flash is the container,
// not the card.
const appTheme: Theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: GROUND,
    card: GROUND,
    border: "transparent",
  },
};

export default function AppNavigator() {
  const { loading, session } = useAuth();

  // Sign-in is the landing screen for a signed-out user. It is still not a GATE:
  // "Continue without an account" goes straight to the app, and every offline
  // feature works without ever signing in. Wait for the session check first so a
  // returning user is never flashed the sign-in screen on launch.
  const initialRouteName: keyof StackParamList = session ? "SpendMain" : "SignIn";
  if (loading) return null;

  return (
    <NavigationContainer theme={appTheme}>
      <Stack.Navigator
        initialRouteName={initialRouteName}
        screenOptions={{
          headerShown: false,
          cardStyle: { backgroundColor: GROUND },
          // Keep the outgoing screen mounted so nothing is torn down to reveal
          // the ground beneath it mid-animation.
          detachPreviousScreen: false,
          cardOverlayEnabled: false,
          ...TransitionPresets.SlideFromRightIOS,
        }}
      >
        <Stack.Screen name="SpendMain" component={SpendMain} />
        <Stack.Screen
          name="SpendManualEntry"
          component={ManualEntrySheet}
          options={{ presentation: "modal" }}
        />
        <Stack.Screen
          name="SpendBudgetPlanner"
          component={BudgetPlanner}
          options={{ presentation: "modal" }}
        />
        <Stack.Screen name="SignIn" component={SignInScreen} />
        <Stack.Screen name="Profile" component={ProfileScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
