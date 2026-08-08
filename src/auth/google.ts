import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { ApiError } from '../errors.js';

export type GoogleIdentity = {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
};

/**
 * Google does NOT serve its keys at `<issuer>/.well-known/jwks.json` — that URL
 * 404s. Its discovery document declares jwks_uri as
 * https://www.googleapis.com/oauth2/v3/certs. Deriving the key location by
 * convention instead of reading discovery meant no keys were ever fetched, so
 * every otherwise-valid ID token failed signature verification and returned 401.
 *
 * Discovery is resolved once, lazily, and cached; jose handles key rotation and
 * kid lookup from there.
 */
const DISCOVERY_PATH = '/.well-known/openid-configuration';
const GOOGLE_JWKS_FALLBACK = 'https://www.googleapis.com/oauth2/v3/certs';

async function resolveJwksUri(issuer: string): Promise<string> {
  const base = issuer.replace(/\/$/, '');
  try {
    const response = await fetch(`${base}${DISCOVERY_PATH}`);
    if (!response.ok) return GOOGLE_JWKS_FALLBACK;
    const document = (await response.json()) as { jwks_uri?: unknown };
    return typeof document.jwks_uri === 'string' ? document.jwks_uri : GOOGLE_JWKS_FALLBACK;
  } catch {
    // Never let a discovery blip become a permanent auth outage.
    return GOOGLE_JWKS_FALLBACK;
  }
}

export function googleVerifier(issuer: string, clientId: string) {
  let jwksPromise: Promise<ReturnType<typeof createRemoteJWKSet>> | null = null;

  function getJwks() {
    jwksPromise ??= resolveJwksUri(issuer).then((uri) => createRemoteJWKSet(new URL(uri)));
    return jwksPromise;
  }

  return async function verify(idToken: string): Promise<GoogleIdentity> {
    try {
      const jwks = await getJwks();
      const { payload } = await jwtVerify(idToken, jwks, {
        issuer: [issuer, 'accounts.google.com'],
        audience: clientId
      });
      return identityFromClaims(payload);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // Surface the underlying reason in logs; the client still sees a generic 401.
      const detail = error instanceof Error ? error.message : String(error);
      throw new ApiError(401, 'invalid_google_token', `Google ID token is invalid: ${detail}`);
    }
  };
}

function identityFromClaims(payload: JWTPayload): GoogleIdentity {
  if (typeof payload.sub !== 'string' || !payload.sub) {
    throw new ApiError(401, 'invalid_google_token', 'Google ID token has no subject');
  }
  return {
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    name: typeof payload.name === 'string' ? payload.name : undefined,
    picture: typeof payload.picture === 'string' ? payload.picture : undefined
  };
}

export { identityFromClaims };
