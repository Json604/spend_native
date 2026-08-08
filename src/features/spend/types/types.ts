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
  deltaMinor?: number;
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
  categoryLabel?: string;
  categoryParentId?: SpendCategoryId;
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

export type SpendDailyBucket = {
  date: string;
  dayLabel: string;
  weekdayLabel: string;
  fullLabel: string;
  amountMinor: number;
  transactionCount: number;
  isToday: boolean;
};

export type SpendDataRepository = {
  monthSummary: (monthKey: string) => Promise<{
    totalSpentMinor: number;
    budgetTotalMinor: number;
    daysRemaining: number;
    transactionCount: number;
    reviewCount: number;
  }>;
  categoryBreakdown: (monthKey: string) => Promise<Array<{
    categoryId: SpendCategoryId;
    label: string;
    tint: string;
    parentId?: SpendCategoryId;
    spentMinor: number;
    budgetedMinor: number;
    recurring: boolean;
  }>>;
  dailyBuckets: (monthKey: string) => Promise<SpendDailyBucket[]>;
  transactionsForDay: (dateKey: string) => Promise<SpendTransaction[]>;
  budgetsForMonth: (monthKey: string) => Promise<MonthlyBudget | null>;
  needsReview: (monthKey: string) => Promise<SpendTransaction[]>;
  transactionsForMonth: (monthKey: string) => Promise<SpendTransaction[]>;
  categories: (monthKey: string) => Promise<SpendCategoryDefinition[]>;
  getTransactionsForDay: (dateKey: string) => Promise<SpendTransaction[]>;
  createTransaction: (input: SpendSeedTransactionInput) => Promise<void>;
  assignCategory: (transactionId: string, categoryId: SpendCategoryId) => Promise<void>;
  ignoreTransaction: (transactionId: string) => Promise<void>;
  setPlanType: (transactionId: string, planType: SpendPlanType) => Promise<void>;
  setBudgetAmount: (
    monthKey: string,
    categoryId: SpendCategoryId,
    amountMinor: number,
    recurring?: boolean,
    expectedRevision?: number,
  ) => Promise<BudgetWriteResult>;
  budgetRevision: (monthKey: string) => Promise<number>;
  clearMonthBudget: (monthKey: string) => Promise<void>;
  createCategory: (label: string, opts?: { parentId?: SpendCategoryId }) => Promise<SpendCategoryDefinition>;
  renameCategory: (categoryId: SpendCategoryId, newLabel: string) => Promise<void>;
  archiveCategory: (categoryId: SpendCategoryId) => Promise<void>;
  setBudget: (monthKey: string, categoryBudgets: CategoryBudgetMap) => Promise<void>;
  ensureSystemCategories: () => Promise<void>;
};

export type SpendContextType = {
  repository: SpendDataRepository;
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
  selectedMonth: string;
  setSelectedMonth: (monthKey: string) => void;
  /** Months the user actually has data for, newest first. Never generated. */
  availableMonths: string[];
  dailyBuckets: SpendDailyBucket[];
  getTransactionsForDay: (dateKey: string) => Promise<SpendTransaction[]>;
  /**
   * Increments on every reload. Screens that fetch their own slice of data need
   * something to depend on that changes whenever anything changed — counting
   * transactions is not enough, because recategorising one changes no count and
   * the screen then shows stale rows until the app is restarted.
   */
  dataRevision: number;
  /** True while data is still arriving from the server, so screens can say so. */
  hydrating: boolean;
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
    assignCategory: (transactionId: string, categoryId: SpendCategoryId) => Promise<void>;
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
    setPlanType: (transactionId: string, planType: SpendPlanType) => Promise<void>;
    setBudgetAmount: (monthKey: string, categoryId: SpendCategoryId, amountMinor: number, recurring?: boolean, expectedRevision?: number) => Promise<BudgetWriteResult>;
    carryForwardBudget: (monthKey: string) => Promise<number>;
    createCategory: (
      label: string,
      opts?: { parentId?: SpendCategoryId },
    ) => Promise<SpendCategoryOption>;
    renameCategory: (categoryId: SpendCategoryId, newLabel: string) => Promise<void>;
    archiveCategory: (categoryId: SpendCategoryId) => Promise<void>;
    setBudget: (monthKey: string, categoryBudgets: CategoryBudgetMap) => Promise<void>;
    clearMonthBudget: (monthKey: string) => Promise<void>;
  };
};

// categoryId (or category label, for legacy uncategorized) -> minor units
export type CategoryBudgetMap = Record<string, number>;

export type MonthlyBudget = {
  monthKey: string;             // "YYYY-MM"
  amountMinor: number;          // derived total — sum of categoryBudgets
  categoryBudgets: CategoryBudgetMap;
  categoryRecurring?: Record<string, boolean>;
  setAt: string;                // ISO
};

export type MonthlyBudgetMap = Record<string, MonthlyBudget>;

export type BudgetWriteResult = {
  revision: number;
};
