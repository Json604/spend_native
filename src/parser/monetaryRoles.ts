import {extractGrammar, type GrammarExtraction} from './grammar.ts';
import {
  compileRulePack,
  defaultRuleProvider,
  type RulePackMonetaryRole,
  type RuleProvider,
} from './rulePack.ts';

export type MonetaryRole = RulePackMonetaryRole;

export type MonetarySpan = {
  raw: string;
  amountMinor: number;
  role: MonetaryRole;
  index: number;
};

export type MonetaryExtractionOptions = {
  grammar?: GrammarExtraction;
  ruleProvider?: RuleProvider;
};

function inferPackedRole(
  message: string,
  start: number,
  end: number,
  ruleProvider: RuleProvider,
): MonetaryRole | null {
  const before = message.slice(Math.max(0, start - 80), start);
  const after = message.slice(end, Math.min(message.length, end + 80));
  const context = `${before}<AMOUNT>${after}`;
  const compiledRulePack = compileRulePack(ruleProvider.getRulePack());

  for (const role of compiledRulePack.monetaryRoleOrder) {
    const patterns = compiledRulePack.monetaryRoles.get(role) ?? [];
    if (patterns.some(pattern => pattern.test(context))) return role;
  }

  return null;
}

/** Extracts all currency-qualified monetary spans without collapsing them. */
export function extractMonetarySpans(
  message: string,
  options: MonetaryExtractionOptions = {},
): MonetarySpan[] {
  const text = message ?? '';
  const grammar = options.grammar ?? extractGrammar(text);
  const ruleProvider = options.ruleProvider ?? defaultRuleProvider;

  return grammar.amounts.map(amount => ({
    amountMinor: amount.amountMinor,
    index: amount.index,
    raw: amount.raw,
    role:
      inferPackedRole(text, amount.index, amount.end, ruleProvider) ??
      (grammar.transactionAmountIndexes.has(amount.index)
        ? 'transaction_amount'
        : 'unknown'),
  }));
}
