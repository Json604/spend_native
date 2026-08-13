import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import LinearGradient from "react-native-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import type { StackNavigationProp } from "@react-navigation/stack";
import MaterialCommunityIcons from "react-native-vector-icons/MaterialCommunityIcons";
import { useAuth } from "../../../auth/AuthProvider";
import type { StackParamList } from "../../../navigation/types";

type SignInNavigation = StackNavigationProp<StackParamList, "SignIn">;

function friendlyAuthError(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("cancel") || message.includes("dismiss")) {
    return "Google sign-in was cancelled. You can keep using Spend offline.";
  }
  if (message.includes("play services")) {
    return "Google Play Services needs an update before you can sign in.";
  }
  return "We couldn't sign you in right now. Your local spending data is safe—please try again when you're online.";
}

export default function SignInScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<SignInNavigation>();
  const { signIn } = useAuth();
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const continueWithGoogle = async () => {
    if (busy) return;
    setBusy(true);
    setErrorMessage(null);
    try {
      await signIn();
      navigation.replace("SpendMain");
    } catch (error) {
      setErrorMessage(friendlyAuthError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.page}>
      <StatusBar barStyle="light-content" />
      <ScrollView
        showsVerticalScrollIndicator={false}
        // grow-to-fill + flex-end anchors the sheet to the BOTTOM of the screen.
        // Without this the sheet sits wherever normal flow leaves it, floating
        // mid-screen with dead space beneath.
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: "flex-end",
          paddingBottom: Math.max(insets.bottom + 22, 34),
        }}
      >
        <LinearGradient
          colors={["#342515", "#17110D", "#070709"]}
          start={{ x: 0.05, y: 0 }}
          end={{ x: 0.9, y: 1 }}
          style={[styles.hero, { paddingTop: insets.top + 18 }]}
        >
          <View style={styles.heroOrbLarge} />
          <View style={styles.heroOrbSmall} />
          <Pressable
            accessibilityLabel="Go back"
            onPress={() => navigation.reset({ index: 0, routes: [{ name: "SpendMain" }] })}
            style={styles.backButton}
          >
            <MaterialCommunityIcons name="arrow-left" size={21} color="#F5E6B8" />
          </Pressable>
          <View style={styles.heroCopy}>
            <Text style={styles.heroEyebrow}>PRIVATE BY DEFAULT</Text>
            <Text style={styles.heroTitle}>See where it goes.</Text>
            <Text style={styles.heroCaption}>A calmer view of your everyday spending.</Text>
          </View>
        </LinearGradient>

        <View style={styles.sheet}>
          <View style={styles.sheetHandle} />
          <Text style={styles.heading}>Keep your Spend in sync</Text>
          <Text style={styles.subheading}>
            Sign in to back up your spending and sync it across devices. Your offline tools keep working either way.
          </Text>

          {errorMessage ? (
            <View style={styles.errorBox}>
              <MaterialCommunityIcons name="alert-circle-outline" size={19} color="#FF8E72" />
              <Text style={styles.errorText}>{errorMessage}</Text>
            </View>
          ) : null}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Continue with Google"
            disabled={busy}
            onPress={continueWithGoogle}
            style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, busy && styles.disabled]}
          >
            {busy ? <ActivityIndicator color="#16110A" /> : <MaterialCommunityIcons name="google" size={20} color="#16110A" />}
            <Text style={styles.primaryButtonText}>{busy ? "Signing you in…" : "Continue with Google"}</Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Continue without an account"
            disabled={busy}
            onPress={() => navigation.reset({ index: 0, routes: [{ name: "SpendMain" }] })}
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
          >
            <Text style={styles.secondaryButtonText}>Continue without an account</Text>
          </Pressable>
          <Text style={styles.privacyNote}>SMS stays on this device except for redacted fields used for sync.</Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#070709" },
  // flexGrow lets the hero absorb the space above the sheet, so the sheet lands
  // on the bottom edge on any screen height instead of leaving a black gap.
  hero: { flexGrow: 1, minHeight: 370, paddingHorizontal: 22, overflow: "hidden" },
  heroOrbLarge: {
    position: "absolute", width: 290, height: 290, borderRadius: 145,
    backgroundColor: "rgba(255, 210, 122, 0.10)", right: -75, top: 45,
  },
  heroOrbSmall: {
    position: "absolute", width: 115, height: 115, borderRadius: 58,
    borderWidth: 1, borderColor: "rgba(255, 210, 122, 0.26)", right: 45, top: 112,
  },
  backButton: {
    width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.24)", borderWidth: 1, borderColor: "rgba(245,230,184,0.16)",
  },
  heroCopy: { marginTop: 106, maxWidth: 300 },
  heroEyebrow: { color: "#FFD27A", fontSize: 11, fontWeight: "700", letterSpacing: 2.2 },
  heroTitle: { color: "#F5E6B8", fontSize: 44, lineHeight: 49, fontWeight: "300", letterSpacing: -1.6, marginTop: 12 },
  heroCaption: { color: "#B5A682", fontSize: 14, lineHeight: 21, marginTop: 14 },
  sheet: {
    marginTop: -54, marginHorizontal: 10, paddingHorizontal: 18, paddingTop: 12, paddingBottom: 4,
    borderRadius: 28, borderWidth: 1, borderColor: "rgba(245,230,184,0.13)",
    backgroundColor: "#0E0C0A", shadowColor: "#000", shadowOpacity: 0.42, shadowRadius: 24,
    shadowOffset: { width: 0, height: 14 }, elevation: 12,
  },
  sheetHandle: { width: 42, height: 4, borderRadius: 2, backgroundColor: "#6D6048", alignSelf: "center", marginBottom: 26 },
  heading: { color: "#F5E6B8", fontSize: 30, lineHeight: 35, fontWeight: "500", letterSpacing: -0.8 },
  subheading: { color: "#9C8B5C", fontSize: 14, lineHeight: 21, marginTop: 10, marginBottom: 22 },
  errorBox: { flexDirection: "row", gap: 9, padding: 12, borderRadius: 13, borderWidth: 1, borderColor: "rgba(255,142,114,0.35)", backgroundColor: "rgba(255,142,114,0.08)", marginBottom: 14 },
  errorText: { flex: 1, color: "#FFB09A", fontSize: 13, lineHeight: 18 },
  primaryButton: { minHeight: 56, borderRadius: 18, backgroundColor: "#FFD27A", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, paddingHorizontal: 16 },
  primaryButtonText: { color: "#16110A", fontSize: 16, fontWeight: "700" },
  secondaryButton: { alignItems: "center", justifyContent: "center", minHeight: 48, marginTop: 8 },
  secondaryButtonText: { color: "#D8CDB0", fontSize: 14, fontWeight: "600" },
  privacyNote: { color: "#6F6A62", fontSize: 11, lineHeight: 16, textAlign: "center", marginTop: 20, marginBottom: 14 },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.65 },
});
