import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { signInWithGoogle, restoreAuthSession, signOut as signOutAuth, type AuthSession, type AuthUser } from "./authClient";
import { secureDeviceId } from "./secureTokenStore";
import { nativeSync } from "../sync/nativeSync";
import { syncEngine } from "../sync/syncEngine";

type AuthContextValue = {
  loading: boolean;
  user: AuthUser | null;
  session: AuthSession | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<AuthSession | null>(null);

  const claim = useCallback(async (next: AuthSession) => {
    try {
      await nativeSync.claimLocalData(next.user.id, await secureDeviceId());
    } catch (error) {
      await signOutAuth();
      throw new Error(
        error instanceof Error && error.message.includes("belongs to another account")
          ? "This device already has local data claimed by another account. Sign out of that account on this device before using this account."
          : error instanceof Error ? error.message : String(error),
      );
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    restoreAuthSession()
      .then(async (existing) => {
        if (!existing) return;
        try {
          await claim(existing);
          if (!cancelled) setSession(existing);
        } catch {
          // Keep the app fully usable signed out; local data remains untouched.
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [claim]);

  const signIn = useCallback(async () => {
    try {
      const next = await signInWithGoogle();
      await claim(next);
      setSession(next);
    } catch (error) {
      throw error;
    }
  }, [claim]);

  const signOut = useCallback(async () => {
    syncEngine.stop();
    await signOutAuth();
    setSession(null);
  }, []);

  // Sync starts itself the moment the device knows who it belongs to, and stops
  // on sign-out. Nothing about replication is the user's job.
  useEffect(() => {
    if (session?.user?.id) syncEngine.start(session.user.id);
    else syncEngine.stop();
  }, [session?.user?.id]);

  const value = useMemo(() => ({ loading, user: session?.user ?? null, session, signIn, signOut }), [loading, session, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within AuthProvider");
  return value;
}
