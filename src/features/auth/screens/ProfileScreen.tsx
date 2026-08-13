import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { StackNavigationProp } from "@react-navigation/stack";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import MaterialCommunityIcons from "react-native-vector-icons/MaterialCommunityIcons";
import { useAuth } from "../../../auth/AuthProvider";
import { syncClient, type SyncReport } from "../../../sync/syncClient";
import { syncEngine, type SyncEngineState } from "../../../sync/syncEngine";
import { getSmsPermissionState, type SmsPermissionState } from "../../spend/services/smsIngestion";
import { useSpend } from "../../spend/store/SpendProvider";
import type { StackParamList } from "../../../navigation/types";
import { checkForUpdate, currentVersion } from "../../../update/updateChecker";

type ProfileNavigation = StackNavigationProp<StackParamList, "Profile">;
type UserRecord = Record<string, unknown>;

function userValue(user: UserRecord | null, keys: string[]): string | null {
  for (const key of keys) {
    const value = user?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function formatSyncTime(value: string | undefined): string {
  if (!value) return "Not synced yet";
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function relativeTime(epochMillis: number): string {
  const seconds = Math.round((Date.now() - epochMillis) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function friendlyError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Something went wrong. Please try again.";
}

function permissionLabel(permission: SmsPermissionState): string {
  if (permission === "granted") return "Allowed";
  if (permission === "unavailable") return "Unavailable on this device";
  return "Permission needed";
}

type RowProps = {
  icon: string;
  label: string;
  value?: string;
  onPress?: () => void;
  destructive?: boolean;
  busy?: boolean;
};

function ProfileRow({ icon, label, value, onPress, destructive, busy }: RowProps) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={!onPress || busy}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed, destructive && styles.destructiveRow]}
    >
      <View style={[styles.rowIcon, destructive && styles.destructiveIcon]}>
        <MaterialCommunityIcons name={icon} size={18} color={destructive ? "#FF8E72" : "#FFD27A"} />
      </View>
      <View style={styles.rowCopy}>
        <Text style={[styles.rowLabel, destructive && styles.destructiveText]}>{label}</Text>
        {value ? <Text style={styles.rowValue}>{value}</Text> : null}
      </View>
      {busy ? (
        <ActivityIndicator size="small" color="#FFD27A" />
      ) : onPress ? (
        <MaterialCommunityIcons name="chevron-right" size={21} color="#756B5B" />
      ) : null}
    </Pressable>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionCard}>{children}</View>
    </View>
  );
}

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<ProfileNavigation>();
  const { user, signOut } = useAuth();
  const { domain, categories, actions } = useSpend();
  // Read from the installed package rather than a literal. A hardcoded string
  // is wrong the moment it ships, and it is exactly the field a user checks to
  // find out whether an update actually landed.
  const [appVersion, setAppVersion] = useState("");
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [permission, setPermission] = useState<SmsPermissionState>("denied");
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    currentVersion().then((version) => { if (!cancelled) setAppVersion(version); });
    return () => { cancelled = true; };
  }, []);
  const [deadLetterCount, setDeadLetterCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [manualLastSyncedAt, setManualLastSyncedAt] = useState<string | undefined>();

  const refreshDetails = useCallback(async () => {
    try {
      const [nextPermission, nextPending, nextDeadLetters] = await Promise.all([
        getSmsPermissionState(),
        syncClient.pendingOutboxCount(),
        syncClient.deadLetterCount(),
      ]);
      setPermission(nextPermission);
      setPendingCount(nextPending);
      setDeadLetterCount(nextDeadLetters);
    } catch (error) {
      setProfileError(friendlyError(error));
    }
  }, []);

  useEffect(() => { refreshDetails().catch(() => undefined); }, [refreshDetails]);
  useFocusEffect(useCallback(() => {
    refreshDetails().catch(() => undefined);
  }, [refreshDetails]));

  const displayName = userValue(user as UserRecord | null, ["name", "displayName", "full_name"]);
  const email = userValue(user as UserRecord | null, ["email"]);
  const identityName = displayName ?? (email ? email.split("@")[0] : "Spend offline");
  const identityLine = user ? (email ?? "Google account") : "Local data only · no account needed";
  const initials = identityName.slice(0, 1).toUpperCase();
  const providerSync = domain.state.syncStates.find((state) => state.source === "gmail");
  const lastSyncedAt = manualLastSyncedAt ?? providerSync?.lastSyncedAt;
  const categoryCount = categories.length;
  const transactionCount = domain.summary.transactionCount;


  const [engineState, setEngineState] = useState<SyncEngineState>({
    running: false, lastSyncedAt: null, lastError: null, pending: 0,
  });
  useEffect(() => syncEngine.subscribe(setEngineState), []);

  const requestPermission = async () => {
    if (permissionBusy || permission === "granted" || permission === "unavailable") return;
    setPermissionBusy(true);
    setProfileError(null);
    try {
      await actions.grantSmsAccess();
      setPermission(await getSmsPermissionState());
    } catch (error) {
      setProfileError(`SMS permission could not be updated: ${friendlyError(error)}`);
    } finally {
      setPermissionBusy(false);
    }
  };

  const confirmSignOut = () => {
    Alert.alert(
      "Sign out of Spend?",
      "Your local data stays on this device. Signing out only disconnects account sync.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Sign out", style: "destructive", onPress: () => signOut().catch((error) => setProfileError(`Sign out failed: ${friendlyError(error)}`)) },
      ],
    );
  };

  const accountAction = useMemo(() => {
    if (user) return undefined;
    return () => navigation.navigate("SignIn");
  }, [navigation, user]);

  return (
    <View style={styles.page}>
      <StatusBar barStyle="light-content" />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 14, paddingBottom: Math.max(insets.bottom + 32, 48) }]}
      >
        <View style={styles.topBar}>
          <Pressable accessibilityLabel="Go back" onPress={() => navigation.goBack()} style={styles.backButton}>
            <MaterialCommunityIcons name="arrow-left" size={21} color="#F5E6B8" />
          </Pressable>
          <Text style={styles.pageTitle}>Profile</Text>
          <View style={styles.topBarSpacer} />
        </View>

        <View style={styles.identityRow}>
          <View style={styles.avatar}><Text style={styles.avatarText}>{initials}</Text></View>
          <View style={styles.identityCopy}>
            <Text style={styles.identityName}>{identityName}</Text>
            <Text style={styles.identityLine}>{identityLine}</Text>
          </View>
        </View>

        {profileError ? <Text style={styles.notice}>{profileError}</Text> : null}

        <Section title="ACCOUNT">
          <ProfileRow
            icon={user ? "email-outline" : "cloud-upload-outline"}
            label={user ? "Signed-in email" : "Sign in to back up"}
            value={user ? (email ?? "Google account") : "Optional · your offline data stays available"}
            onPress={accountAction}
          />
        </Section>

        <Section title="SYNC">
          <ProfileRow icon="clock-outline" label="Last synced" value={user ? formatSyncTime(lastSyncedAt) : "Not signed in"} />
          {deadLetterCount > 0 ? <ProfileRow icon="alert-outline" label="Needs attention" value={`${deadLetterCount} failed change${deadLetterCount === 1 ? "" : "s"}`} /> : null}
          <ProfileRow
            icon={engineState.lastError ? "cloud-alert" : engineState.running ? "cloud-sync-outline" : "cloud-check-outline"}
            label={
              engineState.running
                ? "Backing up…"
                : engineState.lastError
                  ? "Backup paused"
                  : "Backed up"
            }
            value={
              engineState.lastError
                ? `${engineState.lastError} — will retry automatically`
                : engineState.pending > 0
                  ? `${engineState.pending} change${engineState.pending === 1 ? "" : "s"} queued`
                  : engineState.lastSyncedAt
                    ? `Last backed up ${relativeTime(engineState.lastSyncedAt)}`
                    : "Runs automatically"
            }
            busy={engineState.running}
          />
        </Section>

        <Section title="DATA">
          <ProfileRow icon="message-text-outline" label="SMS permission" value={permissionLabel(permission)} onPress={permission === "granted" || permission === "unavailable" ? undefined : requestPermission} busy={permissionBusy} />
          <ProfileRow icon="tag-multiple-outline" label="Categories" value={`${categoryCount} active categor${categoryCount === 1 ? "y" : "ies"}`} />
          <ProfileRow icon="receipt-text-outline" label="Transactions" value={`${transactionCount} this month`} />
        </Section>

        <Section title="ABOUT">
          <ProfileRow
            icon="information-outline"
            label="App version"
            value={appVersion || "…"}
            busy={checkingUpdate}
            onPress={async () => {
              setCheckingUpdate(true);
              try {
                await checkForUpdate({ silent: false });
              } finally {
                setCheckingUpdate(false);
              }
            }}
          />
          <ProfileRow
            icon="shield-lock-outline"
            label="Privacy stance"
            value="SMS is parsed on this device. Signed-in classification suggestions go through Spend and wait for your confirmation."
          />
        </Section>

        {user ? (
          <Pressable accessibilityRole="button" onPress={confirmSignOut} style={({ pressed }) => [styles.signOut, pressed && styles.rowPressed]}>
            <MaterialCommunityIcons name="logout" size={19} color="#FF8E72" />
            <Text style={styles.signOutText}>Sign out</Text>
          </Pressable>
        ) : (
          <Text style={styles.offlineFooter}>Spend works fully offline. An account is always optional.</Text>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#070709" },
  content: { paddingHorizontal: 18 },
  topBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 24 },
  backButton: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.04)", borderWidth: 1, borderColor: "rgba(245,230,184,0.12)" },
  pageTitle: { color: "#F5E6B8", fontSize: 21, fontWeight: "500", letterSpacing: -0.3 },
  topBarSpacer: { width: 40 },
  identityRow: { flexDirection: "row", alignItems: "center", padding: 17, borderRadius: 22, backgroundColor: "rgba(255,255,255,0.055)", borderWidth: 1, borderColor: "rgba(245,230,184,0.12)", marginBottom: 28 },
  avatar: { width: 58, height: 58, borderRadius: 29, backgroundColor: "#FFD27A", alignItems: "center", justifyContent: "center", marginRight: 14 },
  avatarText: { color: "#21160A", fontSize: 23, fontWeight: "700" },
  identityCopy: { flex: 1 },
  identityName: { color: "#F5E6B8", fontSize: 20, fontWeight: "600" },
  identityLine: { color: "#9C8B5C", fontSize: 12, marginTop: 5 },
  notice: { color: "#FFB09A", fontSize: 12, lineHeight: 18, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: "rgba(255,142,114,0.28)", backgroundColor: "rgba(255,142,114,0.08)", marginBottom: 16 },
  section: { marginBottom: 23 },
  sectionTitle: { color: "#9C8B5C", fontSize: 11, letterSpacing: 2.1, fontWeight: "700", marginBottom: 9, paddingLeft: 4 },
  sectionCard: { borderRadius: 19, overflow: "hidden", borderWidth: 1, borderColor: "rgba(245,230,184,0.10)", backgroundColor: "rgba(255,255,255,0.035)" },
  row: { minHeight: 67, flexDirection: "row", alignItems: "center", paddingHorizontal: 13, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "rgba(245,230,184,0.10)" },
  rowPressed: { backgroundColor: "rgba(255,210,122,0.08)" },
  rowIcon: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,210,122,0.11)", marginRight: 11 },
  rowCopy: { flex: 1, paddingRight: 10 },
  rowLabel: { color: "#D8CDB0", fontSize: 14, fontWeight: "600" },
  rowValue: { color: "#8F8F96", fontSize: 11, lineHeight: 16, marginTop: 3 },
  destructiveRow: { borderBottomWidth: 0 },
  destructiveIcon: { backgroundColor: "rgba(255,142,114,0.10)" },
  destructiveText: { color: "#FF8E72" },
  signOut: { minHeight: 55, borderRadius: 17, borderWidth: 1, borderColor: "rgba(255,142,114,0.26)", backgroundColor: "rgba(255,142,114,0.06)", flexDirection: "row", gap: 10, alignItems: "center", justifyContent: "center", marginTop: 2 },
  signOutText: { color: "#FF8E72", fontSize: 14, fontWeight: "700" },
  offlineFooter: { color: "#6F6A62", fontSize: 12, lineHeight: 18, textAlign: "center", marginTop: 4, paddingHorizontal: 20 },
});
