import "react-native-gesture-handler";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useEffect } from "react";
import { AppState, type AppStateStatus, StatusBar } from "react-native";
import { AuthProvider } from "./src/auth/AuthProvider";
import { SpendProvider } from "./src/features/spend/store/SpendProvider";
import AppNavigator from "./src/navigation/AppNavigator";
import { checkForUpdate } from "./src/update/updateChecker";

export default function App() {
  useEffect(() => {
    // Checked once per launch and again when the app returns to the foreground
    // after being away — a sideloaded app has no store to nag it, so the only
    // moment an update can reach the user is a moment they are already here.
    void checkForUpdate();
    const subscription = AppState.addEventListener("change", (state: AppStateStatus) => {
      if (state === "active") void checkForUpdate();
    });
    return () => subscription.remove();
  }, []);

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
