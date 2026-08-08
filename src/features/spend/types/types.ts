export type SpendSourceKind = "sms" | "gmail" | "manual";

export type SpendSourceLabel = "SMS" | "Gmail" | "Manual";

export type SpendSyncStatus = "idle" | "ready" | "needs_permission" | "syncing" | "error";

export type SpendTransactionChannel =
  | "upi"
  | "card"
  | "bank_transfer"
  | "autopay"
  | "wallet"
  | "unknown";

export type SpendTransactionDirection = "debit" | "credit" | "refund";

export type SpendTransactionStatus = "posted" | "pending" | "ignored";

export type SpendCategorySource = "merchant_rule" | "learned_rule" | "manual" | "uncategorized";

export type BaseSpendCategoryId =
  | "swiggy"
  | "zomato"
  | "zepto"
  | "other-food-apps"
  | "travel"
  | "self-transfer"
  | "uncategorized"
  | "needs-review";

export type SpendCategoryId = BaseSpendCategoryId | `custom:${string}`;

export type SpendSummary = {
  monthLabel: string;
  totalFormatted: string;
  subtitle: string;
  syncLabel: string;
};

export type SpendCategoryPreview = {
  id?: SpendCategoryId;
  label: string;
  amountLabel: string;
  tint: string;
  budgetAmountLabel?: string;
  spentMinor?: number;
  budgetMinor?: number;
  pct?: number;
  parentId?: SpendCategoryId;
  depth?: number; // 0 = root, 1 = child, ...
};

export type SpendSourceStatus = {
  label: string;
  status: string;
  detail: string;
  accent: string;
};

export type SpendReviewPreview = {
  transactionId?: string;
  payee: string;
  amountLabel?: string;
  hint: string;
};

export type SpendRecentPreview = {
  merchant: string;
  amountLabel: string;
  source: SpendSourceLabel;
  category: string;
};

export type SpendWidgetCategory = {
  label: string;
  amountLabel: string;
  spentMinor?: number;
  budgetMinor?: number;
};

export type SpendWidgetSnapshot = {
  monthLabel: string;
  totalFormatted: string;
  todayLabel: string;
  todayFormatted: string;
  monthTotalCaption: string;
  syncLabel: string;
  topCategories: SpendWidgetCategory[];
  monthBudgetMinor: number | null;
  monthSpentMinor: number;
  daysRemainingInMonth: number;
};

export type SpendCategoryDefinition = {
  id: SpendCategoryId;
  label: string;
  tint: string;
  isSystem: boolean;
  isReviewCategory?: boolean;
  parentId?: SpendCategoryId;
};

export type SpendMerchantRule = {
  id: string;
  label: string;
  categoryId: SpendCategoryId;
  priority: number;
  merchantTokens?: string[];
  senderTokens?: string[];
  upiHandleTokens?: string[];
  descriptionTokens?: string[];
};

export type LearnedCategoryRule = {
  id: string;
  categoryId: SpendCategoryId;
  categoryLabel: string;
  normalizedCounterparty: string;
  createdAt: string;
  updatedAt: string;
};

export type SpendSyncState = {
  source: SpendSourceKind;
  status: SpendSyncStatus;
  label: string;
  detail: string;
  accent: string;
  lastSyncedAt?: string;
};

export type SpendTransaction = {
  id: string;
  source: SpendSourceKind;
  sourceMessageId?: string;
  externalFingerprint?: string;
  occurredAt: string;
  amountMinor: number;
  currencyCode: string;
  merchantName: string;
  normalizedMerchantName: string;
  counterpartyKey?: string;
  description: string;
  channel: SpendTransactionChannel;
  direction: SpendTransactionDirection;
  status: SpendTransactionStatus;
  categoryId?: SpendCategoryId;
  categoryLabel?: string;
  categorySource: SpendCategorySource;
  needsReview: boolean;
  // "planned" = part of your monthly budget plan.
  // "unplanned" = from savings (gifts, helping someone, one-off). Doesn't count toward category budgets.
  planType?: SpendPlanType;
};

export type SpendPlanType = "planned" | "unplanned";

export type SpendDomainState = {
  transactions: SpendTransaction[];
  categories: SpendCategoryDefinition[];
  merchantRules: SpendMerchantRule[];
  learnedRules: LearnedCategoryRule[];
  syncStates: SpendSyncState[];
};

export type SpendCategoryTotal = {
  categoryId: SpendCategoryId;
  label: string;
  tint: string;
  amountMinor: number;
  transactionCount: number;
};

export type SpendCategoryOption = {
  id: SpendCategoryId;
  label: string;
  tint: string;
  isCustom: boolean;
  parentId?: SpendCategoryId;
};

export type SpendMonthSummary = {
  monthLabel: string;
  totalMinor: number;
  transactionCount: number;
  reviewCount: number;
};

export type SpendReviewItem = {
  transactionId: string;
  payee: string;
  amountLabel: string;
  occurredAtLabel: string;
  description: string;
};

export type SpendSeedTransactionInput = Omit<
  SpendTransaction,
  | "normalizedMerchantName"
  | "counterpartyKey"
  | "categoryId"
  | "categoryLabel"
  | "categorySource"
  | "needsReview"
> & {
  counterpartyKey?: string;
};

export type LearnedCategoryRuleInput = {
  normalizedCounterparty: string;
  categoryId: SpendCategoryId;
  categoryLabel: string;
};

export type SpendRepositorySnapshot = {
  state: SpendDomainState;
  summary: SpendMonthSummary;
  categoryTotals: SpendCategoryTotal[];
  needsReviewTransactions: SpendTransaction[];
  recentTransactions: SpendTransaction[];
};

export type SpendRepository = {
  getState: () => SpendDomainState;
  getSnapshot: (referenceDate?: Date) => SpendRepositorySnapshot;
  upsertTransactions: (transactions: SpendSeedTransactionInput[]) => SpendDomainState;
  ensureCategory: (
    label: string,
    opts?: { parentId?: SpendCategoryId },
  ) => SpendCategoryDefinition;
  saveLearnedCategoryRule: (input: LearnedCategoryRuleInput) => LearnedCategoryRule;
  assignCategoryToTransaction: (
    transactionId: string,
    categoryId: SpendCategoryId,
    categoryLabel: string,
  ) => SpendTransaction | undefined;
  ignoreTransaction: (transactionId: string) => SpendTransaction | undefined;
  setTransactionPlanType: (transactionId: string, planType: SpendPlanType) => SpendTransaction | undefined;
  deleteTransaction: (transactionId: string) => boolean;
  deleteCategory: (categoryId: SpendCategoryId) => boolean;
  renameCategory: (categoryId: SpendCategoryId, newLabel: string) => SpendCategoryDefinition | undefined;
  updateSyncState: (source: SpendSourceKind, patch: Partial<SpendSyncState>) => SpendSyncState | undefined;
};

export type SpendStorageAdapter = {
  readState: () => SpendDomainState;
  writeState: (state: SpendDomainState) => void;
};

export type SpendContextType = {
  repository: SpendRepository;
  domain: SpendRepositorySnapshot;
  summary: SpendSummary;
  categories: SpendCategoryPreview[];
  categoryOptions: SpendCategoryOption[];
  sourceStatuses: SpendSourceStatus[];
  reviewPreview: SpendReviewPreview;
  reviewItems: SpendReviewItem[];
  recentPreview: SpendRecentPreview[];
  widgetSnapshot: SpendWidgetSnapshot;
  currentMonthBudget: MonthlyBudget | null;
  actions: {
    grantSmsAccess: () => Promise<void>;
    refreshSmsInbox: () => Promise<void>;
    connectGmailInbox: () => Promise<void>;
    refreshGmailInbox: () => Promise<void>;
    assignReviewCategory: (
      transactionId: string,
      categoryLabel: string,
      opts?: { parentId?: SpendCategoryId },
    ) => Promise<void>;
    ignoreTransaction: (transactionId: string) => Promise<void>;
    addManualTransaction: (input: {
      amountMinor: number;
      merchantName: string;
      occurredAt: string;
      description?: string;
      categoryLabel?: string;
      categoryParentId?: SpendCategoryId;
      planType?: SpendPlanType;
    }) => Promise<void>;
    setTransactionPlanType: (transactionId: string, planType: SpendPlanType) => Promise<void>;
    deleteTransaction: (transactionId: string) => Promise<void>;
    setMonthlyBudget: (monthKey: string, categoryBudgets: CategoryBudgetMap) => Promise<void>;
    clearMonthlyBudget: (monthKey: string) => Promise<void>;
    addCategory: (
      label: string,
      opts?: { parentId?: SpendCategoryId },
    ) => Promise<SpendCategoryOption>;
    renameCategory: (categoryId: SpendCategoryId, newLabel: string) => Promise<void>;
    deleteCategory: (categoryId: SpendCategoryId) => Promise<void>;
  };
};

// categoryId (or category label, for legacy uncategorized) -> minor units
export type CategoryBudgetMap = Record<string, number>;

export type MonthlyBudget = {
  monthKey: string;             // "YYYY-MM"
  amountMinor: number;          // derived total — sum of categoryBudgets
  categoryBudgets: CategoryBudgetMap;
  setAt: string;                // ISO
};

export type MonthlyBudgetMap = Record<string, MonthlyBudget>;
