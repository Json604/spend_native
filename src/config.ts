import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export type Config = {
  nodeEnv: string;
  host: string;
  port: number;
  databaseUrl: string;
  googleClientId: string;
  googleIssuer: string;
  accessTokenSecret: string;
  accessTokenTtl: string;
  refreshTokenTtlDays: number;
  maxPushOps: number;
  maxPullOps: number;
};

export function loadConfig(): Config {
  const secret = required('ACCESS_TOKEN_SECRET');
  if (secret.length < 32) throw new Error('ACCESS_TOKEN_SECRET must be at least 32 characters');
  return {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    host: process.env.HOST ?? '127.0.0.1',
    port: Number(process.env.PORT ?? 8080),
    databaseUrl: required('DATABASE_URL'),
    googleClientId: required('GOOGLE_CLIENT_ID'),
    googleIssuer: process.env.GOOGLE_ISSUER ?? 'https://accounts.google.com',
    accessTokenSecret: secret,
    accessTokenTtl: process.env.ACCESS_TOKEN_TTL ?? '15m',
    refreshTokenTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 90),
    maxPushOps: Number(process.env.MAX_PUSH_OPS ?? 500),
    maxPullOps: Number(process.env.MAX_PULL_OPS ?? 1000)
  };
}
