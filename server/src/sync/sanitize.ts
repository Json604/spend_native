/** PostgreSQL JSONB cannot store U+0000, even when JSON encodes it as \u0000. */
export function stripNulCharacters<T>(value: T): T {
  if (typeof value === 'string') return value.replaceAll('\u0000', '') as T;
  if (Array.isArray(value)) return value.map(stripNulCharacters) as T;
  if (value === null || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key.replaceAll('\u0000', ''),
      stripNulCharacters(item),
    ]),
  ) as T;
}
