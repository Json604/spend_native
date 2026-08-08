import {extractGrammar} from './grammar.ts';

function normalizeMerchantName(value: string): string | null {
  const normalized = value
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s:;,.\-]+|[\s:;,.\-]+$/g, '')
    .replace(/[^a-z0-9&.'\/-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized || null;
}

export function extractVpa(message: string): string | null {
  const counterparty = extractGrammar(message ?? '').counterparty;
  return counterparty?.kind === 'vpa'
    ? counterparty.value.toLowerCase()
    : null;
}

export function extractMerchantName(message: string): string | null {
  const text = (message ?? '').replace(/\s+/g, ' ').trim();
  const counterparty = extractGrammar(text).counterparty;
  return counterparty?.kind === 'named'
    ? normalizeMerchantName(counterparty.value)
    : null;
}

function extractCardSuffix(message: string): string | null {
  return (
    extractGrammar(message ?? '').accounts.find(account => account.kind === 'card')
      ?.last4 ?? null
  );
}

/**
 * Builds a namespaced counterparty key. Sender IDs are deliberately not an
 * input and therefore can never become a fallback key.
 */
export function buildCounterpartyKey(
  message: string,
  extractedMerchantName?: string | null,
): string | null {
  const vpa = extractVpa(message);
  if (vpa) return `vpa:${vpa}`;

  const merchant = normalizeMerchantName(
    extractedMerchantName ?? extractMerchantName(message) ?? '',
  );
  if (merchant) return `merchant:${merchant}`;

  const last4 = extractCardSuffix(message);
  return last4 ? `card:${last4}` : null;
}

const AGGREGATOR_PATTERN =
  /paytm|razorpay|payu|billdesk|ccavenue|phonepe|gpay|cashfree|easebuzz|amazonpay|amazonupi|swiggyupi|payzomato/i;
const AGGREGATOR_DOMAINS = new Set([
  'ptaxis',
  'pthdfc',
  'ptsbi',
  'ptybl',
  'ptyes',
]);
const GENERIC_BANK_VPA_DOMAINS = new Set([
  'okaxis',
  'okhdfcbank',
  'oksbi',
  'okicici',
]);
const GENERIC_LOCAL_PART_PATTERN =
  /^(?:pay|payment|payments|merchant|collect|request|upi|qr|scanandpay)$/i;

/** Returns true when a key is displayable but unsafe for category learning. */
export function isLowSpecificityKey(key: string | null | undefined): boolean {
  if (!key?.toLowerCase().startsWith('vpa:')) return false;

  const handle = key.slice(4).toLowerCase();
  const separator = handle.lastIndexOf('@');
  if (separator <= 0) return true;

  const localPart = handle.slice(0, separator);
  const domain = handle.slice(separator + 1);

  if (
    AGGREGATOR_PATTERN.test(localPart) ||
    AGGREGATOR_PATTERN.test(domain) ||
    AGGREGATOR_DOMAINS.has(domain)
  ) {
    return true;
  }

  return (
    GENERIC_BANK_VPA_DOMAINS.has(domain) &&
    GENERIC_LOCAL_PART_PATTERN.test(localPart)
  );
}
