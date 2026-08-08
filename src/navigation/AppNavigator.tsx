import { NavigationContainer } from "@react-navigation/native";
import { createStackNavigator } from "@react-navigation/stack";
import SpendMain from "../features/spend/screens/SpendMain";
import ManualEntrySheet from "../features/spend/screens/ManualEntrySheet";
import BudgetPlanner from "../features/spend/screens/BudgetPlanner";
import type { StackParamList } from "./types";

const Stack = createStackNavigator<StackParamList>();

export default function AppNavigator() {
  return (
    <NavigationContainer>
      <Stack.Navigator
        screenOptions={{ headerShown: false, cardStyle: { backgroundColor: "#070709" } }}
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
      </Stack.Navigator>
    </NavigationContainer>
  );
}
