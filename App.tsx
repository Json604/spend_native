import "react-native-gesture-handler";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StatusBar } from "expo-status-bar";
import { SpendProvider } from "./src/features/spend/store/SpendProvider";
import AppNavigator from "./src/navigation/AppNavigator";

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: "#070709" }}>
      <StatusBar style="light" />
      <SpendProvider>
        <AppNavigator />
      </SpendProvider>
    </GestureHandlerRootView>
  );
}
