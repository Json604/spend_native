import {
  classifyMessageDetailed,
  type LearnedRuleProvider,
  type MessageClassification,
} from './messageClassifier.ts';
import {
  extractMonetarySpans,
  type MonetarySpan,
} from './monetaryRoles.ts';
import {
  buildCounterpartyKey,
  extractMerchantName,
} from './counterpartyKey.ts';
import {extractGrammar} from './grammar.ts';
import {
  createRuleProvider,
  defaultRuleProvider,
  type RuleProvider,
} from './rulePack.ts';

export type ParsedMessageReason =
  | 'transaction_created'
  | 'credit_requires_linking'
  | 'missing_transaction_amount'
  | 'non_transaction_classification'
  | 'unknown_classification';

export type ParsedMoneyMovement = {
  amountMinor: number;
  amountSpan: MonetarySpan;
  counterpartyKey: string | null;
  currency: 'INR';
  direction: 'debit' | 'credit';
  merchantName: string | null;
};

export type ParsedMessageResult = {
  classification: MessageClassification;
  counterpartyKey: string | null;
  createsTransaction: boolean;
  credit: ParsedMoneyMovement | null;
  isCredit: boolean;
  merchantName: string | null;
  monetarySpans: MonetarySpan[];
  rawText: string;
  reason: ParsedMessageReason;
  rulePackVersion: number;
  transaction: ParsedMoneyMovement | null;
};

export type ParseMessageOptions = {
  learnedRuleProvider?: LearnedRuleProvider;
  ruleProvider?: RuleProvider;
};

/**
 * Parses one SMS without creating generic income records. Posted credits retain
 * their amount/counterparty as linkable metadata, but transaction remains null.
 */
export function parseMessage(
  message: string,
  options: ParseMessageOptions = {},
): ParsedMessageResult {
  const rawText = (message ?? '').replace(/\s+/g, ' ').trim();
  const activeRulePack = (options.ruleProvider ?? defaultRuleProvider).getRulePack();
  const ruleProvider = createRuleProvider(activeRulePack);
  const grammar = extractGrammar(rawText);

  // Classification must happen before amount extraction. Promotions containing
  // transactional words must be rejected based on intent, not amount position.
  const decision = classifyMessageDetailed(rawText, {
    grammar,
    learnedRuleProvider: options.learnedRuleProvider,
    ruleProvider,
  });
  const classification = decision.classification;
  let monetarySpans = extractMonetarySpans(rawText, {grammar, ruleProvider});
  const merchantName = extractMerchantName(rawText);
  const counterpartyKey = buildCounterpartyKey(rawText, merchantName);
  let amountSpan =
    monetarySpans.find(span => span.role === 'transaction_amount') ?? null;

  // Once a high-confidence classifier identifies a posted movement, one lone
  // unassigned amount is safe to promote. Protected balance/limit/bill roles
  // are never eligible for this fallback.
  const isPosted =
    classification === 'posted_debit' || classification === 'posted_credit';
  if (!amountSpan && isPosted) {
    const unknownSpans = monetarySpans.filter(span => span.role === 'unknown');
    if (unknownSpans.length === 1) {
      const promoted = {...unknownSpans[0], role: 'transaction_amount' as const};
      monetarySpans = monetarySpans.map(span =>
        span === unknownSpans[0] ? promoted : span,
      );
      amountSpan = promoted;
    }
  }

  const base = {
    classification,
    counterpartyKey,
    merchantName,
    monetarySpans,
    rawText,
    rulePackVersion: decision.rulePackVersion,
  };

  if (classification === 'posted_debit' && amountSpan) {
    return {
      ...base,
      createsTransaction: true,
      credit: null,
      isCredit: false,
      reason: 'transaction_created',
      transaction: {
        amountMinor: amountSpan.amountMinor,
        amountSpan,
        counterpartyKey,
        currency: 'INR',
        direction: 'debit',
        merchantName,
      },
    };
  }

  if (classification === 'posted_credit' && amountSpan) {
    return {
      ...base,
      createsTransaction: false,
      credit: {
        amountMinor: amountSpan.amountMinor,
        amountSpan,
        counterpartyKey,
        currency: 'INR',
        direction: 'credit',
        merchantName,
      },
      isCredit: true,
      reason: 'credit_requires_linking',
      transaction: null,
    };
  }

  return {
    ...base,
    createsTransaction: false,
    credit: null,
    isCredit: classification === 'posted_credit',
    reason:
      classification === 'unknown'
        ? 'unknown_classification'
        : isPosted
          ? 'missing_transaction_amount'
          : 'non_transaction_classification',
    transaction: null,
  };
}
