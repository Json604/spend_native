import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../config";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

/**
 * Idempotent + de-duplicated. First call: signs in anonymously and persists.
 * Concurrent callers share the same in-flight promise so we never double-fire
 * the sign-in network call.
 *
 * NOTE: The session lives in AsyncStorage. Uninstalling the app loses access
 * to this user's data — they get a new anonymous user.
 */
let inFlightAuth: Promise<string> | null = null;

export function ensureAnonymousAuth(): Promise<string> {
  if (inFlightAuth) return inFlightAuth;

  inFlightAuth = (async () => {
    const { data: existing } = await supabase.auth.getSession();
    if (existing.session?.user) return existing.session.user.id;

    const { data, error } = await supabase.auth.signInAnonymously();
    if (error || !data.session) {
      // Reset so the next caller can retry (e.g. after user enables anon auth)
      inFlightAuth = null;
      throw new Error(
        `Anonymous sign-in failed: ${error?.message ?? "no session returned"}. ` +
          `Enable "Anonymous Sign-ins" in Supabase → Authentication → Providers.`,
      );
    }
    return data.session.user.id;
  })();

  return inFlightAuth;
}

/**
 * Returns the current user_id, or kicks off (and waits for) anonymous sign-in
 * if no session exists yet. This is what callers should use before writes —
 * it resolves the race where a save fires before initial auth completes.
 */
export async function currentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  if (data.session?.user) return data.session.user.id;
  try {
    return await ensureAnonymousAuth();
  } catch {
    return null;
  }
}
