export type TransactionDirection = 'credit' | 'debit';

export type StructuralAmount = {
  amountMinor: number;
  end: number;
  index: number;
  raw: string;
};

export type StructuralVerb = {
  direction: TransactionDirection;
  index: number;
  raw: string;
};

export type StructuralAccount = {
  index: number;
  kind: 'account' | 'card';
  last4: string;
  raw: string;
};

export type StructuralCounterparty = {
  index: number;
  kind: 'named' | 'vpa';
  raw: string;
  value: string;
};

export type StructuralReference = {
  index: number;
  label: string;
  raw: string;
  value: string;
};

export type GrammarExtraction = {
  accounts: StructuralAccount[];
  amounts: StructuralAmount[];
  counterparty: StructuralCounterparty | null;
  genericClassification: 'posted_credit' | 'posted_debit' | null;
  references: StructuralReference[];
  transactionAmountIndexes: ReadonlySet<number>;
  verbs: StructuralVerb[];
};

const CURRENCY_SOURCE =
  '(?:₹|(?:rs|inr|mrp|amt|amount)\.?)\\s*[:\\-]?\\s*' +
  '(\\d+(?:,\\d+)*(?:\\.\\d{1,2})?)(?:\\s*(lakh|lac|crore|k))?';

const CURRENCY_PATTERN = new RegExp(CURRENCY_SOURCE, 'gi');
const CURRENCY_WITHOUT_CAPTURES =
  '(?:₹|(?:rs|inr|mrp|amt|amount)\.?)\\s*[:\\-]?\\s*' +
  '\\d+(?:,\\d+)*(?:\\.\\d{1,2})?(?:\\s*(?:lakh|lac|crore|k))?';

const DATE_BOUNDARY =
  '(?:\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}|\\d{1,2}-[A-Za-z]{3}-\\d{2,4})';

const VPA_PATTERN =
  /(?<![a-z0-9._-])([a-z0-9][a-z0-9._-]{1,}@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)/gi;

const VERB_PATTERN =
  /\b(debited|credited|sent|paid|withdrawn|spent|transferred|received|refunded)\b/gi;

const NAMED_COUNTERPARTY_PATTERNS = [
  new RegExp(
    `\\bto\\s+(.+?)(?=\\s+on\\s+${DATE_BOUNDARY}|\\s+(?:is|was)\\s+successful\\b|\\s+(?:upi\\s+ref|txn\\s+id|rrn|ref\\s+no)\\b|\\s*\\.\\s*(?:thru|via)\\b|[.!]|$)`,
    'i',
  ),
  new RegExp(
    `\\bat\\s+(.+?)(?=\\s+on\\s+${DATE_BOUNDARY}|\\s+(?:upi\\s+ref|txn\\s+id|rrn|ref\\s+no)\\b|[.!]|$)`,
    'i',
  ),
  /\bfrom\s+(.+?)\s+in your\b/i,
  /\bfrom\s+beneficiary\s+(.+?)(?:\.\s*UTR|\s+UTR|$)/i,
  /\btransfer\s+from\s+(.+?)(?:\s+Ref(?:erence)?\b|\s+UTR\b|$)/i,
];

const REFERENCE_PATTERN =
  /\b(UPI\s+Ref(?:\s+No\.?)?|Txn\s+ID|Transaction\s+ID|RRN|Ref(?:erence)?\s+No\.?)\s*[:.-]?\s*([A-Z0-9-]{6,})\b/gi;

function toAmountMinor(numberText: string, magnitude?: string): number | null {
  const numericValue = Number.parseFloat(numberText.replace(/,/g, ''));
  if (!Number.isFinite(numericValue)) return null;

  const multiplier =
    magnitude?.toLowerCase() === 'crore'
      ? 10_000_000
      : magnitude && /^(?:lakh|lac)$/i.test(magnitude)
        ? 100_000
        : magnitude?.toLowerCase() === 'k'
          ? 1_000
          : 1;
  const amountMinor = Math.round(numericValue * multiplier * 100);

  return Number.isSafeInteger(amountMinor) ? amountMinor : null;
}

function extractAmounts(message: string): StructuralAmount[] {
  const amounts: StructuralAmount[] = [];

  for (const match of message.matchAll(CURRENCY_PATTERN)) {
    const index = match.index;
    const raw = match[0];
    const amountMinor = toAmountMinor(match[1], match[2]);
    if (typeof index !== 'number' || amountMinor === null) continue;

    amounts.push({amountMinor, end: index + raw.length, index, raw});
  }

  return amounts;
}

function directionForVerb(rawVerb: string, message: string, index: number): TransactionDirection {
  if (/^(?:credited|received|refunded)$/i.test(rawVerb)) return 'credit';
  if (!/^transferred$/i.test(rawVerb)) return 'debit';

  const suffix = message.slice(index + rawVerb.length, index + rawVerb.length + 24);
  return /^\s+from\b/i.test(suffix) ? 'credit' : 'debit';
}

function extractVerbs(message: string): StructuralVerb[] {
  const verbs: StructuralVerb[] = [];

  for (const match of message.matchAll(VERB_PATTERN)) {
    if (typeof match.index !== 'number') continue;
    verbs.push({
      direction: directionForVerb(match[1], message, match.index),
      index: match.index,
      raw: match[1],
    });
  }

  for (const match of message.matchAll(/\bdebit\s+of\b/gi)) {
    if (typeof match.index === 'number') {
      verbs.push({direction: 'debit', index: match.index, raw: match[0]});
    }
  }

  for (const match of message.matchAll(/\bpayment\s+of\b/gi)) {
    if (typeof match.index === 'number') {
      verbs.push({direction: 'debit', index: match.index, raw: match[0]});
    }
  }

  return verbs.sort((left, right) => left.index - right.index);
}

function extractAccounts(message: string): StructuralAccount[] {
  const accounts: StructuralAccount[] = [];
  const explicitPattern =
    /\b(a\/?c|ac|account|card)\b(?:\s+(?:ending|ending\s+in|no\.?|number))?\s*(?:x{1,12}|\*{1,12})\s*(\d{4})\b/gi;

  for (const match of message.matchAll(explicitPattern)) {
    if (typeof match.index !== 'number') continue;
    accounts.push({
      index: match.index,
      kind: /^card$/i.test(match[1]) ? 'card' : 'account',
      last4: match[2],
      raw: match[0],
    });
  }

  for (const match of message.matchAll(/(?<![a-z0-9])(?:x{2,12}|\*{2,12})(\d{4})\b/gi)) {
    if (typeof match.index !== 'number') continue;
    if (accounts.some(account => match.index! >= account.index && match.index! < account.index + account.raw.length)) {
      continue;
    }
    accounts.push({
      index: match.index,
      kind: /\bcard\b/i.test(message.slice(Math.max(0, match.index - 24), match.index + match[0].length + 24))
        ? 'card'
        : 'account',
      last4: match[1],
      raw: match[0],
    });
  }

  return accounts.sort((left, right) => left.index - right.index);
}

function extractCounterparty(message: string): StructuralCounterparty | null {
  const vpaMatch = Array.from(message.matchAll(VPA_PATTERN))[0];
  if (vpaMatch?.[1] && typeof vpaMatch.index === 'number') {
    return {
      index: vpaMatch.index,
      kind: 'vpa',
      raw: vpaMatch[0],
      value: vpaMatch[1],
    };
  }

  for (const pattern of NAMED_COUNTERPARTY_PATTERNS) {
    const match = pattern.exec(message);
    if (!match?.[1] || typeof match.index !== 'number') continue;
    const relativeIndex = match[0].indexOf(match[1]);
    return {
      index: match.index + Math.max(relativeIndex, 0),
      kind: 'named',
      raw: match[1],
      value: match[1],
    };
  }

  return null;
}

function extractReferences(message: string): StructuralReference[] {
  const references: StructuralReference[] = [];

  for (const match of message.matchAll(REFERENCE_PATTERN)) {
    if (typeof match.index !== 'number') continue;
    references.push({
      index: match.index,
      label: match[1],
      raw: match[0],
      value: match[2],
    });
  }

  return references;
}

function findTransactionAmountIndexes(
  message: string,
  amounts: StructuralAmount[],
): ReadonlySet<number> {
  const indexes = new Set<number>();
  const beforePattern =
    /\b(?:debited(?:\s+by)?|debit\s+of|sent|spent|paid|payment\s+of|withdrawn|charged|received|credited\s+by|refund\s+of|refunded|transferred|recharge\s+of|transaction\s+for)\s*$/i;
  const afterPattern =
    /^\s*(?:was\s+|is\s+|has\s+been\s+)?(?:debited|spent|paid|withdrawn|charged|credited|received|refunded|transferred)\b/i;

  for (const amount of amounts) {
    const before = message.slice(Math.max(0, amount.index - 80), amount.index);
    const after = message.slice(amount.end, Math.min(message.length, amount.end + 80));
    if (beforePattern.test(before) || afterPattern.test(after)) indexes.add(amount.index);
  }

  return indexes;
}

function inferGenericClassification(
  message: string,
  verbs: StructuralVerb[],
  transactionAmountIndexes: ReadonlySet<number>,
): 'posted_credit' | 'posted_debit' | null {
  if (transactionAmountIndexes.size === 0) return null;

  const successfulMovementPattern = new RegExp(
    `\\b(?:payment|transaction)\\s+(?:of|for)\\s+${CURRENCY_WITHOUT_CAPTURES}[\\s\\S]{0,160}\\b(?:is|was|has\\s+been)?\\s*(?:successful|processed\\s+successfully)\\b`,
    'i',
  );
  if (successfulMovementPattern.test(message)) return 'posted_debit';

  const linkedVerb = verbs.find(verb =>
    Array.from(transactionAmountIndexes).some(amountIndex =>
      Math.abs(amountIndex - verb.index) <= 100,
    ),
  );
  return linkedVerb?.direction === 'credit'
    ? 'posted_credit'
    : linkedVerb?.direction === 'debit'
      ? 'posted_debit'
      : null;
}

/**
 * Extracts the bank-independent structure shared by Indian transaction SMS.
 * This module intentionally contains no institution or merchant identities.
 */
export function extractGrammar(message: string): GrammarExtraction {
  const text = message ?? '';
  const amounts = extractAmounts(text);
  const verbs = extractVerbs(text);
  const transactionAmountIndexes = findTransactionAmountIndexes(text, amounts);

  return {
    accounts: extractAccounts(text),
    amounts,
    counterparty: extractCounterparty(text),
    genericClassification: inferGenericClassification(
      text,
      verbs,
      transactionAmountIndexes,
    ),
    references: extractReferences(text),
    transactionAmountIndexes,
    verbs,
  };
}
