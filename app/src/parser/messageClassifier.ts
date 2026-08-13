import {extractGrammar, type GrammarExtraction} from './grammar.ts';
import {
  compileRulePack,
  defaultRuleProvider,
  type MessageClassification,
  type RuleProvider,
} from './rulePack.ts';

export type {MessageClassification} from './rulePack.ts';

/** Classifications that may contain money but can never create a spend. */
export const NON_SPEND_CLASSIFICATIONS: readonly MessageClassification[] = [
  'posted_credit',
  'pending',
  'reversal',
  'mandate_setup',
  'payment_request',
  'balance_only',
  'marketing',
  'security',
  'unknown',
];

export const isNonSpendClassification = (
  classification: MessageClassification,
): boolean => NON_SPEND_CLASSIFICATIONS.includes(classification);

export type LearnedRuleDecision = {
  classification: MessageClassification;
};

/**
 * Reserved extension point for rules learned on-device. No learning is
 * implemented yet; callers may omit this provider until that feature exists.
 */
export type LearnedRuleProvider = {
  classify(
    message: string,
    grammar: GrammarExtraction,
  ): LearnedRuleDecision | null;
};

export type MessageClassifierOptions = {
  grammar?: GrammarExtraction;
  learnedRuleProvider?: LearnedRuleProvider;
  ruleProvider?: RuleProvider;
};

export type ClassificationDecision = {
  classification: MessageClassification;
  grammar: GrammarExtraction;
  rulePackVersion: number;
  source: 'generic_grammar' | 'learned' | 'rule_pack' | 'unknown';
};

const matchesAny = (message: string, patterns: RegExp[]): boolean =>
  patterns.some(pattern => pattern.test(message));

/**
 * Resolution priority is explicit and stable:
 * learned rules > the active rule pack > generic bank-agnostic grammar.
 */
export function classifyMessageDetailed(
  message: string,
  options: MessageClassifierOptions = {},
): ClassificationDecision {
  const text = (message ?? '').replace(/\s+/g, ' ').trim();
  const grammar = options.grammar ?? extractGrammar(text);
  const rulePack = (options.ruleProvider ?? defaultRuleProvider).getRulePack();
  const compiledRulePack = compileRulePack(rulePack);

  if (!text) {
    return {
      classification: 'unknown',
      grammar,
      rulePackVersion: compiledRulePack.version,
      source: 'unknown',
    };
  }

  const learnedDecision = options.learnedRuleProvider?.classify(text, grammar);
  if (learnedDecision) {
    return {
      classification: learnedDecision.classification,
      grammar,
      rulePackVersion: compiledRulePack.version,
      source: 'learned',
    };
  }

  for (const rule of compiledRulePack.classifierOrder) {
    const patterns = compiledRulePack.classifiers.get(rule.group) ?? [];
    if (matchesAny(text, patterns)) {
      return {
        classification: rule.classification,
        grammar,
        rulePackVersion: compiledRulePack.version,
        source: 'rule_pack',
      };
    }
  }

  if (grammar.genericClassification) {
    return {
      classification: grammar.genericClassification,
      grammar,
      rulePackVersion: compiledRulePack.version,
      source: 'generic_grammar',
    };
  }

  return {
    classification: 'unknown',
    grammar,
    rulePackVersion: compiledRulePack.version,
    source: 'unknown',
  };
}

export function classifyMessage(
  message: string,
  options: MessageClassifierOptions = {},
): MessageClassification {
  return classifyMessageDetailed(message, options).classification;
}
