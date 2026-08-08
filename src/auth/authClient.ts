import { GoogleSignin } from "@react-native-google-signin/google-signin";
import {
  clearSecureSession,
  readSecureSession,
  secureDeviceId,
  writeSecureSession,
  type StoredAuthSession,
} from "./secureTokenStore";

export const API_BASE_URL = "https://spend.kartikey.xyz";
export const GOOGLE_WEB_CLIENT_ID = "913171475839-tse7c700rtj48d2a4ivarkahtp9u4oj4.apps.googleusercontent.com";

export type AuthUser = Record<string, unknown> & { id: string };
export type AuthSession = StoredAuthSession & { user: AuthUser };

type GoogleAuthResponse = { access: string; refresh: string; user: AuthUser };
type RefreshResponse = { access: string; refresh: string };

GoogleSignin.configure({ webClientId: GOOGLE_WEB_CLIENT_ID });

let refreshInFlight: Promise<AuthSession | null> | null = null;
let signInInFlight: Promise<AuthSession> | null = null;

export async function restoreAuthSession(): Promise<AuthSession | null> {
  return (await readSecureSession()) as AuthSession | null;
}

export function refreshAccessToken(): Promise<AuthSession | null> {
  if (refreshInFlight) return refreshInFlight;
  const promise = (async () => {
    const current = await readSecureSession();
    if (!current?.refresh) return null;

    const response = await fetch(`${API_BASE_URL}/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh: current.refresh }),
    });
    if (!response.ok) {
      await clearSecureSession();
      return null;
    }
    const next = (await response.json()) as RefreshResponse;
    if (!next.access || !next.refresh) throw new Error("Refresh response is incomplete");

    const rotated: AuthSession = {
      access: next.access,
      refresh: next.refresh,
      user: current.user as AuthUser,
    };
    // This is deliberately one native call. No caller can publish a half-rotated
    // pair, and all concurrent refresh callers share this exact promise.
    await writeSecureSession(rotated);
    return rotated;
  })();
  refreshInFlight = promise;
  refreshInFlight.then(
    () => { if (refreshInFlight === promise) refreshInFlight = null; },
    () => { if (refreshInFlight === promise) refreshInFlight = null; },
  );
  return refreshInFlight;
}

export async function authenticatedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const current = await readSecureSession();
  if (!current) throw new Error("Not authenticated");

  const request = (access: string) => fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
      Authorization: `Bearer ${access}`,
    },
  });

  let response = await request(current.access);
  if (response.status !== 401) return response;
  const refreshed = await refreshAccessToken();
  if (!refreshed) throw new Error("Authentication expired");
  response = await request(refreshed.access);
  if (response.status === 401) {
    await clearSecureSession();
    throw new Error("Authentication expired");
  }
  return response;
}

export function signInWithGoogle(): Promise<AuthSession> {
  if (signInInFlight) return signInInFlight;
  const promise = (async () => {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    const result = await GoogleSignin.signIn();
    const data = result.data ?? result;
    const idToken = data.idToken ?? (await GoogleSignin.getTokens()).idToken;
    if (!idToken) throw new Error("Google did not return an ID token");

    const response = await fetch(`${API_BASE_URL}/v1/auth/google`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id_token: idToken }),
    });
    if (!response.ok) throw new Error(`Google sign-in failed (${response.status})`);
    const body = (await response.json()) as GoogleAuthResponse;
    if (!body.access || !body.refresh || !body.user?.id) throw new Error("Sign-in response is incomplete");
    const session: AuthSession = body;
    await writeSecureSession(session);
    return session;
  })();
  signInInFlight = promise;
  signInInFlight.then(
    () => { if (signInInFlight === promise) signInInFlight = null; },
    () => { if (signInInFlight === promise) signInInFlight = null; },
  );
  return signInInFlight;
}

export async function signOut(): Promise<void> {
  await clearSecureSession();
  try {
    await GoogleSignin.signOut();
  } catch {
    // Local sign-out is authoritative even when Google Play Services is offline.
  }
}

export { secureDeviceId };
