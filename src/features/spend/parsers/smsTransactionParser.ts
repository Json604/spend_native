import type {SmsNativeInboxMessage} from '../services/smsNativeModule.ts';
import {buildSpendDedupeKey} from '../services/dedupeKey.ts';
import {parseMessage} from '../../../parser/parseMessage.ts';

export type SmsParserCategoryHint =
  | 'swiggy'
  | 'zomato'
  | 'zepto'
  | 'other_food_app'
  | 'unknown';

export type ParsedSmsTransactionCandidate = {
  amountMinor: number;
  amountText: string | null;
  categoryHint: SmsParserCategoryHint;
  confidence: number;
  counterpartyKey: string | null;
  currency: 'INR' | 'UNKNOWN';
  dedupeKey: string;
  direction: 'debit' | 'credit';
  merchantHint: string | null;
  rawMessageId: string | null;
  rawSender: string | null;
  rawText: string;
  timestamp: number;
};

const CATEGORY_RULES: Array<{
  categoryHint: SmsParserCategoryHint;
  confidence: number;
  merchantHint: string;
  patterns: RegExp[];
}> = [
  {
    categoryHint: 'swiggy',
    confidence: 0.98,
    merchantHint: 'Swiggy',
    patterns: [/swiggy/i],
  },
  {
    categoryHint: 'zomato',
    confidence: 0.98,
    merchantHint: 'Zomato',
    patterns: [/zomato/i, /blinkit/i],
  },
  {
    categoryHint: 'zepto',
    confidence: 0.98,
    merchantHint: 'Zepto',
    patterns: [/zepto/i],
  },
  {
    categoryHint: 'other_food_app',
    confidence: 0.8,
    merchantHint: 'Other Food App',
    patterns: [/uber\s*eats/i, /faasos/i, /eat\.?sure/i, /dominos/i, /pizza/i],
  },
];

function amountTextFromRaw(raw: string): string | null {
  return raw.match(/\d[\d,]*(?:\.\d{1,2})?/)?.[0] ?? null;
}

export const parseSmsTransactionCandidate = (
  message: SmsNativeInboxMessage,
): ParsedSmsTransactionCandidate | null => {
  const parsed = parseMessage(message.body ?? '');

  // This legacy-shaped adapter feeds spend ingestion, so only an actual debit
  // transaction from the new parser is allowed through. Posted credits remain
  // available from parseMessage for future refund linking.
  if (!parsed.transaction) return null;

  const matchedRule = CATEGORY_RULES.find(rule =>
    rule.patterns.some(pattern => pattern.test(parsed.rawText)),
  );

  return {
    amountMinor: parsed.transaction.amountMinor,
    amountText: amountTextFromRaw(parsed.transaction.amountSpan.raw),
    categoryHint: matchedRule?.categoryHint ?? 'unknown',
    confidence: matchedRule?.confidence ?? 0.2,
    counterpartyKey: parsed.counterpartyKey,
    currency: 'INR',
    dedupeKey: buildSpendDedupeKey(
      message.address,
      parsed.transaction.amountMinor,
      message.timestamp,
    ),
    direction: 'debit',
    merchantHint: matchedRule?.merchantHint ?? parsed.merchantName,
    rawMessageId: message.id,
    rawSender: message.address,
    rawText: parsed.rawText,
    timestamp: message.timestamp,
  };
};

export const parseSmsTransactionCandidates = (
  messages: SmsNativeInboxMessage[],
): ParsedSmsTransactionCandidate[] =>
  messages
    .map(parseSmsTransactionCandidate)
    .filter(
      (candidate): candidate is ParsedSmsTransactionCandidate =>
        candidate !== null,
    );
