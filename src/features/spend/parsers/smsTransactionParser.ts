import type {SmsNativeInboxMessage} from '../services/smsNativeModule';
import {buildSpendDedupeKey} from '../services/dedupeKey';

export type SmsParserCategoryHint =
  | 'swiggy'
  | 'zomato'
  | 'zepto'
  | 'other_food_app'
  | 'unknown';

export type ParsedSmsTransactionCandidate = {
  amountText: string | null;
  categoryHint: SmsParserCategoryHint;
  confidence: number;
  currency: 'INR' | 'UNKNOWN';
  dedupeKey: string;
  direction: 'debit' | 'credit';
  merchantHint: string | null;
  rawMessageId: string | null;
  rawSender: string | null;
  rawText: string;
  timestamp: number;
};

const AMOUNT_PATTERN =
  /(?:rs\.?|inr|mrp|₹|amt\.?|amount)\s*[:\-]?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i;
const DEBIT_PATTERNS = [
  /\bdebited\b/i,
  /\bspent\b/i,
  /\bpaid\b/i,
  /\bpurchase\b/i,
  /\bsent\b/i,
  /\btxn\b/i,
  /\bupi\b/i,
  /\bpayment\b/i,
  /\bwithdrawn\b/i,
  /\bcharged\b/i,
  /\bcard\b/i,
  /\btransaction\b/i,
  /\bdr\b/i,
  /\bdebit\b/i,
  /\bpos\b/i,
  /\bautopay\b/i,
  /\bach\b/i,
  /\bmandate\b/i,
  /\bimps\b/i,
  /\bneft\b/i,
  /\brtgs\b/i,
];
const CREDIT_PATTERNS = [
  /\bcredited\b/i,
  /\breceived\b/i,
  /\brefund(?:ed)?\b/i,
  /\bdeposit(?:ed)?\b/i,
  /\bcr\b/i,
  /\bcredit\b/i,
];
const TRANSACTION_SIGNAL_PATTERNS = [
  /\bkotak\b/i,
  /\bupi\b/i,
  /\bcard\b/i,
  /\bdebit\b/i,
  /\bcredit\b/i,
  /\btransaction\b/i,
  /\btxn\b/i,
  /\bpayment\b/i,
  /\bbank\b/i,
  /\baccount\b/i,
  /\ba\/c\b/i,
  /\bcredited\b/i,
  /\bdebited\b/i,
  /\bspent\b/i,
  /\bpaid\b/i,
  /\bwithdrawn\b/i,
  /\breceived\b/i,
  /\btransfer\b/i,
  /\bpos\b/i,
  /\bimps\b/i,
  /\bneft\b/i,
  /\brtgs\b/i,
  /\bach\b/i,
  /\bmandate\b/i,
];
const IGNORE_PATTERNS = [
  /\botp\b/i,
  /\bpromo\b/i,
  /\boffer\b/i,
  /\blogin\b/i,
  /\bpassword\b/i,
  /\bnewsletter\b/i,
  /\bwelcome\b/i,
  /\bverify\b/i,
];
const TRANSACTION_SENDER_PATTERNS = [
  /kotak/i,
  /hdfc/i,
  /icici/i,
  /sbi/i,
  /axis/i,
  /idfc/i,
  /yes/i,
  /indus/i,
  /federal/i,
  /canara/i,
  /pnb/i,
  /rbl/i,
  /bob/i,
  /boi/i,
  /union/i,
  /bank/i,
  /upi/i,
  /card/i,
  /paytm/i,
  /phonepe/i,
  /gpay/i,
  /bhim/i,
];

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

const normalizeBody = (body: string | null): string =>
  body?.replace(/\s+/g, ' ').trim() ?? '';

const parseAmountMinorForKey = (amountText: string | null): number => {
  if (!amountText) return 0;
  const parsed = Number.parseFloat(amountText.replace(/,/g, ''));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
};

export const parseSmsTransactionCandidate = (
  message: SmsNativeInboxMessage,
): ParsedSmsTransactionCandidate | null => {
  const rawText = normalizeBody(message.body);
  const sender = normalizeBody(message.address);

  if (!rawText) {
    return null;
  }

  if (IGNORE_PATTERNS.some(pattern => pattern.test(rawText))) {
    return null;
  }

  const amountMatch = rawText.match(AMOUNT_PATTERN);
  const hasDebitSignal = DEBIT_PATTERNS.some(pattern => pattern.test(rawText));
  const hasCreditSignal = CREDIT_PATTERNS.some(pattern => pattern.test(rawText));
  const hasTransactionSignal = TRANSACTION_SIGNAL_PATTERNS.some(
    pattern => pattern.test(rawText) || pattern.test(sender),
  );
  const hasTransactionSender = TRANSACTION_SENDER_PATTERNS.some(pattern => pattern.test(sender));
  const looksLikeTransactionMessage = hasTransactionSignal || hasTransactionSender;

  if (!amountMatch || !looksLikeTransactionMessage || (!hasDebitSignal && !hasCreditSignal)) {
    return null;
  }

  const matchedRule = CATEGORY_RULES.find(rule =>
    rule.patterns.some(pattern => pattern.test(rawText)),
  );

  return {
    amountText: amountMatch?.[1] ?? null,
    categoryHint: matchedRule?.categoryHint ?? 'unknown',
    confidence: matchedRule?.confidence ?? 0.2,
    currency: amountMatch ? 'INR' : 'UNKNOWN',
    dedupeKey: buildSpendDedupeKey(
      message.address,
      parseAmountMinorForKey(amountMatch?.[1] ?? null),
      message.timestamp,
    ),
    // Credit keywords win when both signals are present, because "Received Rs.X
    // from..." messages also trigger debit-leaning keywords like 'upi' / 'bank'.
    direction: hasCreditSignal ? 'credit' : 'debit',
    merchantHint: matchedRule?.merchantHint ?? message.address,
    rawMessageId: message.id,
    rawSender: message.address,
    rawText,
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
