import { Alert, NativeModules } from "react-native";
import { API_BASE_URL } from "../auth/authClient";

/**
 * Checks for a newer build and offers to install it.
 *
 * Deliberately unauthenticated: a user whose session has expired — or whose
 * token refresh is broken by the very bug the update fixes — still has to be
 * able to update. The manifest and APK are public; integrity comes from TLS
 * plus the SHA-256 the native side verifies before installing, not from
 * knowing the URL.
 */

const MANIFEST_URL = `${API_BASE_URL}/downloads/latest.json`;

type UpdateManifest = {
  versionCode: number;
  versionName: string;
  url: string;
  sha256: string;
  notes?: string;
  mandatory?: boolean;
};

type NativeUpdate = {
  getVersion(): Promise<{ versionCode: number; versionName: string }>;
  downloadAndInstall(url: string, sha256: string): Promise<boolean>;
};

const nativeUpdate = NativeModules.SpendUpdate as NativeUpdate | undefined;

let checkedThisSession = false;

function isManifest(value: unknown): value is UpdateManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Record<string, unknown>;
  return (
    typeof manifest.versionCode === "number" &&
    typeof manifest.versionName === "string" &&
    typeof manifest.url === "string" &&
    typeof manifest.sha256 === "string" &&
    /^[0-9a-f]{64}$/i.test(manifest.sha256)
  );
}

export async function checkForUpdate(options?: { silent?: boolean }): Promise<void> {
  const silent = options?.silent ?? true;
  if (!nativeUpdate) return;
  if (silent && checkedThisSession) return;
  checkedThisSession = true;

  let manifest: UpdateManifest;
  let current: { versionCode: number; versionName: string };
  try {
    const [response, version] = await Promise.all([
      fetch(MANIFEST_URL, { headers: { "cache-control": "no-cache" } }),
      nativeUpdate.getVersion(),
    ]);
    if (!response.ok) throw new Error(`Update check failed (${response.status})`);
    const body: unknown = await response.json();
    if (!isManifest(body)) throw new Error("Update manifest is malformed");
    manifest = body;
    current = version;
  } catch (error) {
    // A failed update check is never worth interrupting the user over; the app
    // works regardless. Surface it only when they asked explicitly.
    if (!silent) {
      Alert.alert("Couldn't check for updates", error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (manifest.versionCode <= current.versionCode) {
    if (!silent) Alert.alert("You're up to date", `Version ${current.versionName} is the latest.`);
    return;
  }

  const install = () => {
    nativeUpdate.downloadAndInstall(manifest.url, manifest.sha256).catch((error: unknown) => {
      Alert.alert("Update failed", error instanceof Error ? error.message : String(error));
    });
  };

  Alert.alert(
    `Update to ${manifest.versionName}`,
    manifest.notes?.trim()
      ? manifest.notes
      : `You're on ${current.versionName}. Downloading takes a few seconds; Android will ask you to confirm the install.`,
    manifest.mandatory
      ? [{ text: "Update", onPress: install }]
      : [
          { text: "Later", style: "cancel" },
          { text: "Update", onPress: install },
        ],
    { cancelable: !manifest.mandatory },
  );
}

/** Lets the profile screen show what the user is running. */
export async function currentVersion(): Promise<string> {
  if (!nativeUpdate) return "";
  try {
    const { versionName } = await nativeUpdate.getVersion();
    return versionName;
  } catch {
    return "";
  }
}
