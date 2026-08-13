import defaultRulePackJson from './rules/default.json' with {type: 'json'};

export const MESSAGE_CLASSIFICATIONS = [
  'posted_debit',
  'posted_credit',
  'pending',
  'reversal',
  'mandate_setup',
  'payment_request',
  'balance_only',
  'marketing',
  'security',
  'unknown',
] as const;

export type MessageClassification = (typeof MESSAGE_CLASSIFICATIONS)[number];

export const MONETARY_ROLES = [
  'transaction_amount',
  'available_balance',
  'credit_limit',
  'promised_cashback',
  'bill_amount',
  'minimum_due',
  'emi_amount',
  'unknown',
] as const;

export type RulePackMonetaryRole = (typeof MONETARY_ROLES)[number];

export type ClassifierRule = {
  classification: MessageClassification;
  group: string;
};

export type CategoryRule = {
  categoryLabel: string;
  confidence: number;
  merchantTokens?: string[];
  vpaDomains?: string[];
  channels?: string[];
};

export type CounterpartyRuleConfig = {
  aggregatorPatterns: string[];
  aggregatorDomains: string[];
  genericBankVpaDomains: string[];
  genericLocalPartPattern: string;
};

/** Serializable shape accepted from bundled JSON, a database row, or a cache. */
export type RulePack = {
  categoryRules: CategoryRule[];
  classifierOrder: ClassifierRule[];
  classifiers: Record<string, string[]>;
  counterparty: CounterpartyRuleConfig;
  monetaryRoleOrder: RulePackMonetaryRole[];
  monetaryRoles: Partial<Record<RulePackMonetaryRole, string[]>>;
  version: number;
};

/**
 * Runtime abstraction used by the parser. A future VPS endpoint can refresh a
 * database-backed provider so support for a new bank ships as data, not a new
 * sideloaded APK. Providers should return their current cached snapshot here.
 */
export interface RuleProvider {
  getRulePack(): RulePack;
}

export type CompiledRulePack = {
  classifierOrder: ClassifierRule[];
  classifiers: ReadonlyMap<string, RegExp[]>;
  monetaryRoleOrder: RulePackMonetaryRole[];
  monetaryRoles: ReadonlyMap<RulePackMonetaryRole, RegExp[]>;
  version: number;
};

export const DEFAULT_RULE_PACK = defaultRulePackJson as unknown as RulePack;

export const defaultRuleProvider: RuleProvider = {
  getRulePack: () => DEFAULT_RULE_PACK,
};

const compiledPacks = new WeakMap<RulePack, CompiledRulePack>();

function compilePatterns(patterns: string[], location: string): RegExp[] {
  return patterns.map((source, index) => {
    try {
      return new RegExp(source, 'i');
    } catch (error) {
      throw new Error(`Invalid regular expression at ${location}[${index}]`, {
        cause: error,
      });
    }
  });
}

/** Validates and compiles a serializable pack the first time it is loaded. */
export function compileRulePack(rulePack: RulePack): CompiledRulePack {
  const cached = compiledPacks.get(rulePack);
  if (cached) return cached;

  if (!Number.isSafeInteger(rulePack.version) || rulePack.version < 1) {
    throw new Error('A rule pack version must be a positive integer');
  }

  const classifiers = new Map<string, RegExp[]>();
  for (const [group, patterns] of Object.entries(rulePack.classifiers)) {
    if (!Array.isArray(patterns)) {
      throw new Error(`Classifier group ${group} must be an array`);
    }
    classifiers.set(group, compilePatterns(patterns, `classifiers.${group}`));
  }

  for (const rule of rulePack.classifierOrder) {
    if (!classifiers.has(rule.group)) {
      throw new Error(`Classifier order references missing group ${rule.group}`);
    }
    if (!MESSAGE_CLASSIFICATIONS.includes(rule.classification)) {
      throw new Error(`Unsupported classification ${rule.classification}`);
    }
  }

  const monetaryRoles = new Map<RulePackMonetaryRole, RegExp[]>();
  for (const role of rulePack.monetaryRoleOrder) {
    if (!MONETARY_ROLES.includes(role)) {
      throw new Error(`Unsupported monetary role ${role}`);
    }
    monetaryRoles.set(
      role,
      compilePatterns(rulePack.monetaryRoles[role] ?? [], `monetaryRoles.${role}`),
    );
  }

  const compiled: CompiledRulePack = {
    classifierOrder: rulePack.classifierOrder,
    classifiers,
    monetaryRoleOrder: rulePack.monetaryRoleOrder,
    monetaryRoles,
    version: rulePack.version,
  };
  compiledPacks.set(rulePack, compiled);
  return compiled;
}

export function createRuleProvider(rulePack: RulePack): RuleProvider {
  compileRulePack(rulePack);
  return {getRulePack: () => rulePack};
}

// Compile the bundled JSON eagerly so malformed shipped data fails immediately.
compileRulePack(DEFAULT_RULE_PACK);
