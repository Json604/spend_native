import { NativeModules } from "react-native";

export type StoredAuthSession = {
  access: string;
  refresh: string;
  user: Record<string, unknown>;
};

type NativeSecureTokenStore = {
  getSession(): Promise<string | null>;
  setSession(access: string, refresh: string, userJson: string): Promise<void>;
  clearSession(): Promise<void>;
  getDeviceId(): Promise<string>;
  getGroqApiKey(): Promise<string | null>;
  setGroqApiKey(apiKey: string): Promise<void>;
  clearGroqApiKey(): Promise<void>;
};

const store = NativeModules.SecureTokenStore as NativeSecureTokenStore;

export async function readSecureSession(): Promise<StoredAuthSession | null> {
  const raw = await store.getSession();
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Partial<StoredAuthSession>;
  if (typeof parsed.access !== "string" || typeof parsed.refresh !== "string" || !parsed.user) {
    throw new Error("Stored authentication session is invalid");
  }
  return parsed as StoredAuthSession;
}

export function writeSecureSession(session: StoredAuthSession): Promise<void> {
  return store.setSession(session.access, session.refresh, JSON.stringify(session.user));
}

export function clearSecureSession(): Promise<void> {
  return store.clearSession();
}

export function secureDeviceId(): Promise<string> {
  return store.getDeviceId();
}

export function readGroqApiKey(): Promise<string | null> {
  return store.getGroqApiKey();
}

export function writeGroqApiKey(apiKey: string): Promise<void> {
  return store.setGroqApiKey(apiKey);
}

export function clearGroqApiKey(): Promise<void> {
  return store.clearGroqApiKey();
}
