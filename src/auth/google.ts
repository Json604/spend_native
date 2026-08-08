import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { ApiError } from '../errors.js';

export type GoogleIdentity = {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
};

export function googleVerifier(issuer: string, clientId: string) {
  const jwks = createRemoteJWKSet(new URL(`${issuer.replace(/\/$/, '')}/.well-known/jwks.json`));
  return async function verify(idToken: string): Promise<GoogleIdentity> {
    try {
      const { payload } = await jwtVerify(idToken, jwks, {
        issuer: [issuer, 'accounts.google.com'],
        audience: clientId
      });
      return identityFromClaims(payload);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(401, 'invalid_google_token', 'Google ID token is invalid');
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
