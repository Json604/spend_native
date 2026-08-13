declare module "@react-native-google-signin/google-signin" {
  export const GoogleSignin: {
    configure(options: { webClientId: string }): void;
    hasPlayServices(options?: { showPlayServicesUpdateDialog?: boolean }): Promise<boolean>;
    signIn(): Promise<{
      data?: { idToken?: string | null; user?: Record<string, unknown> } | null;
      idToken?: string | null;
      user?: Record<string, unknown>;
    }>;
    getTokens(): Promise<{ idToken?: string | null; accessToken?: string | null }>;
    signOut(): Promise<void>;
  };
}
