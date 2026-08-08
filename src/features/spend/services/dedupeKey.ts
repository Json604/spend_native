export function buildSpendDedupeKey(
  sender: string | null | undefined,
  amountMinor: number,
  timestampMillis: number,
): string {
  const normalizedSender = (sender ?? "").toLowerCase();
  const minuteBucket = Math.floor(timestampMillis / 60000);
  return `${normalizedSender}:${amountMinor}:${minuteBucket}`;
}
