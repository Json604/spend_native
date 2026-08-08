import "react-native-gesture-handler";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StatusBar } from "react-native";
import { AuthProvider } from "./src/auth/AuthProvider";
import { SpendProvider } from "./src/features/spend/store/SpendProvider";
import AppNavigator from "./src/navigation/AppNavigator";

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: "#070709" }}>
      <StatusBar barStyle="light-content" />
      <AuthProvider>
        <SpendProvider>
          <AppNavigator />
        </SpendProvider>
      </AuthProvider>
    </GestureHandlerRootView>
  );
}
