import "react-native-gesture-handler";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useEffect, useState } from "react";
import { ActivityIndicator, AppState, type AppStateStatus, Modal, StatusBar, StyleSheet, Text, View } from "react-native";
import { AuthProvider } from "./src/auth/AuthProvider";
import { SpendProvider } from "./src/features/spend/store/SpendProvider";
import AppNavigator from "./src/navigation/AppNavigator";
import { checkForUpdate, subscribeToUpdateProgress, type UpdateProgress } from "./src/update/updateChecker";

export default function App() {
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress>({status: "idle"});

  useEffect(() => subscribeToUpdateProgress(setUpdateProgress), []);

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
      <Modal
        animationType="fade"
        statusBarTranslucent
        transparent
        visible={updateProgress.status === "downloading"}
      >
        <View style={styles.updateBackdrop}>
          <View style={styles.updateCard}>
            <ActivityIndicator color="#FFD27A" size="large" />
            <Text style={styles.updateTitle}>Preparing update</Text>
            <Text style={styles.updateMessage}>
              {updateProgress.status === "downloading"
                ? `Downloading and verifying version ${updateProgress.versionName}…`
                : "Downloading and verifying…"}
            </Text>
            <Text style={styles.updateHint}>Android&apos;s installer will open automatically.</Text>
          </View>
        </View>
      </Modal>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  updateBackdrop: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 28,
    backgroundColor: "rgba(0,0,0,0.72)",
  },
  updateCard: {
    width: "100%",
    maxWidth: 340,
    alignItems: "center",
    borderRadius: 22,
    paddingHorizontal: 24,
    paddingVertical: 28,
    backgroundColor: "#12100D",
    borderWidth: 1,
    borderColor: "rgba(255,210,122,0.20)",
  },
  updateTitle: {
    color: "#F5E6B8",
    fontSize: 19,
    fontWeight: "600",
    marginTop: 16,
  },
  updateMessage: {
    color: "#D8CDB0",
    fontSize: 13,
    lineHeight: 19,
    marginTop: 8,
    textAlign: "center",
  },
  updateHint: {
    color: "#8F8F96",
    fontSize: 11,
    marginTop: 8,
    textAlign: "center",
  },
});
