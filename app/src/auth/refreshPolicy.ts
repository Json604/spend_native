/** 401/403 from /v1/auth/refresh means this family is dead. Anything else is retryable. */
export function isFatalRefreshStatus(status: number): boolean {
  return status === 401 || status === 403;
}
