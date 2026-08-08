import { supabase, currentUserId } from "./supabaseClient";
import { SPEND_CATEGORY_DEFINITIONS, SPEND_MERCHANT_RULES } from "../features/spend/categories/categorySeeds";
import type {
  CategoryBudgetMap,
  LearnedCategoryRule,
  MonthlyBudget,
  MonthlyBudgetMap,
  SpendCategoryDefinition,
  SpendDomainState,
  SpendMerchantRule,
  SpendSyncState,
  SpendTransaction,
} from "../features/spend/types/types";

// RLS ensures each user only sees their own rows. Writes still include user_id
// so Supabase can satisfy primary keys and policy checks.

type SupabaseErrorLike = { code?: string; message?: string; details?: string };

type TransactionRow = {
  id: string;
  source: SpendTransaction["source"];
  source_message_id: string | null;
  external_fingerprint: string | null;
  occurred_at: string;
  amount_minor: number;
  currency_code: string;
  merchant_name: string;
  normalized_merchant_name: string;
  counterparty_key: string | null;
  description: string;
  channel: SpendTransaction["channel"];
  direction: SpendTransaction["direction"];
  status: SpendTransaction["status"];
  category_id: SpendTransaction["categoryId"] | null;
  category_label: string | null;
  category_source: SpendTransaction["categorySource"];
  needs_review: boolean;
  plan_type: SpendTransaction["planType"] | null;
};

type CategoryRow = {
  id: SpendCategoryDefinition["id"];
  label: string;
  tint: string;
  is_system: boolean;
  is_review_category: boolean;
  parent_id: SpendCategoryDefinition["parentId"] | null;
};

type MerchantRuleRow = {
  id: string;
  label: string;
  category_id: SpendMerchantRule["categoryId"];
  priority: number;
  merchant_tokens: string[] | null;
  sender_tokens: string[] | null;
  upi_handle_tokens: string[] | null;
  description_tokens: string[] | null;
};

type LearnedRuleRow = {
  id: string;
  category_id: LearnedCategoryRule["categoryId"];
  category_label: string;
  normalized_counterparty: string;
  created_at: string;
  updated_at: string;
};

type SyncStateRow = {
  source: SpendSyncState["source"];
  status: SpendSyncState["status"];
  label: string;
  detail: string;
  accent: string;
  last_synced_at: string | null;
};

type MonthlyBudgetRow = {
  month_key: string;
  amount_minor: number;
  set_at: string;
};

type MonthlyCategoryBudgetRow = {
  month_key: string;
  category_id: string;
  amount_minor: number;
};

function isMissingNormalizedSchema(error: unknown) {
  const err = error as SupabaseErrorLike | null;
  const message = `${err?.message ?? ""} ${err?.details ?? ""}`.toLowerCase();

  return (
    err?.code === "42P01" ||
    err?.code === "PGRST205" ||
    message.includes("could not find the table") ||
    message.includes("schema cache") ||
    message.includes("relation") && message.includes("does not exist")
  );
}

function baseSpendState(): SpendDomainState {
  return {
    transactions: [],
    categories: SPEND_CATEGORY_DEFINITIONS.map((category) => ({ ...category })),
    merchantRules: SPEND_MERCHANT_RULES.map((rule) => ({ ...rule })),
    learnedRules: [],
    syncStates: [
      {
        source: "sms",
        status: "needs_permission",
        label: "SMS inbox",
        detail: "Android-only. Best for bank, card, and UPI debit alerts.",
        accent: "rgba(255, 215, 0, 0.85)",
      },
      {
        source: "gmail",
        status: "idle",
        label: "Gmail",
        detail: "Connect Gmail to read transaction emails and dedupe overlaps.",
        accent: "rgba(255, 255, 255, 0.85)",
      },
    ],
  };
}

function mergeById<T extends { id: string }>(baseItems: T[], storedItems: T[]) {
  const byId = new Map<string, T>();
  baseItems.forEach((item) => byId.set(item.id, item));
  storedItems.forEach((item) => byId.set(item.id, item));
  return Array.from(byId.values());
}

function mergeSyncStates(baseItems: SpendSyncState[], storedItems: SpendSyncState[]) {
  const bySource = new Map<SpendSyncState["source"], SpendSyncState>();
  baseItems.forEach((item) => bySource.set(item.source, item));
  storedItems.forEach((item) => bySource.set(item.source, item));
  return Array.from(bySource.values());
}

function transactionFromRow(row: TransactionRow): SpendTransaction {
  return {
    id: row.id,
    source: row.source,
    sourceMessageId: row.source_message_id ?? undefined,
    externalFingerprint: row.external_fingerprint ?? undefined,
    occurredAt: row.occurred_at,
    amountMinor: row.amount_minor,
    currencyCode: row.currency_code,
    merchantName: row.merchant_name,
    normalizedMerchantName: row.normalized_merchant_name,
    counterpartyKey: row.counterparty_key ?? undefined,
    description: row.description,
    channel: row.channel,
    direction: row.direction,
    status: row.status,
    categoryId: row.category_id ?? undefined,
    categoryLabel: row.category_label ?? undefined,
    categorySource: row.category_source,
    needsReview: row.needs_review,
    planType: row.plan_type ?? undefined,
  };
}

function categoryFromRow(row: CategoryRow): SpendCategoryDefinition {
  return {
    id: row.id,
    label: row.label,
    tint: row.tint,
    isSystem: row.is_system,
    isReviewCategory: row.is_review_category || undefined,
    parentId: row.parent_id ?? undefined,
  };
}

function merchantRuleFromRow(row: MerchantRuleRow): SpendMerchantRule {
  return {
    id: row.id,
    label: row.label,
    categoryId: row.category_id,
    priority: row.priority,
    merchantTokens: row.merchant_tokens ?? undefined,
    senderTokens: row.sender_tokens ?? undefined,
    upiHandleTokens: row.upi_handle_tokens ?? undefined,
    descriptionTokens: row.description_tokens ?? undefined,
  };
}

function learnedRuleFromRow(row: LearnedRuleRow): LearnedCategoryRule {
  return {
    id: row.id,
    categoryId: row.category_id,
    categoryLabel: row.category_label,
    normalizedCounterparty: row.normalized_counterparty,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function syncStateFromRow(row: SyncStateRow): SpendSyncState {
  return {
    source: row.source,
    status: row.status,
    label: row.label,
    detail: row.detail,
    accent: row.accent,
    lastSyncedAt: row.last_synced_at ?? undefined,
  };
}

function transactionToRow(userId: string, transaction: SpendTransaction) {
  return {
    user_id: userId,
    id: transaction.id,
    source: transaction.source,
    source_message_id: transaction.sourceMessageId ?? null,
    external_fingerprint: transaction.externalFingerprint ?? null,
    occurred_at: transaction.occurredAt,
    amount_minor: transaction.amountMinor,
    currency_code: transaction.currencyCode,
    merchant_name: transaction.merchantName,
    normalized_merchant_name: transaction.normalizedMerchantName,
    counterparty_key: transaction.counterpartyKey ?? null,
    description: transaction.description,
    channel: transaction.channel,
    direction: transaction.direction,
    status: transaction.status,
    category_id: transaction.categoryId ?? null,
    category_label: transaction.categoryLabel ?? null,
    category_source: transaction.categorySource,
    needs_review: transaction.needsReview,
    plan_type: transaction.planType ?? null,
    updated_at: new Date().toISOString(),
  };
}

function categoryToRow(userId: string, category: SpendCategoryDefinition) {
  return {
    user_id: userId,
    id: category.id,
    label: category.label,
    tint: category.tint,
    is_system: category.isSystem,
    is_review_category: category.isReviewCategory ?? false,
    parent_id: category.parentId ?? null,
    updated_at: new Date().toISOString(),
  };
}

function merchantRuleToRow(userId: string, rule: SpendMerchantRule) {
  return {
    user_id: userId,
    id: rule.id,
    label: rule.label,
    category_id: rule.categoryId,
    priority: rule.priority,
    merchant_tokens: rule.merchantTokens ?? null,
    sender_tokens: rule.senderTokens ?? null,
    upi_handle_tokens: rule.upiHandleTokens ?? null,
    description_tokens: rule.descriptionTokens ?? null,
    updated_at: new Date().toISOString(),
  };
}

function learnedRuleToRow(userId: string, rule: LearnedCategoryRule) {
  return {
    user_id: userId,
    id: rule.id,
    category_id: rule.categoryId,
    category_label: rule.categoryLabel,
    normalized_counterparty: rule.normalizedCounterparty,
    created_at: rule.createdAt,
    updated_at: rule.updatedAt,
  };
}

function syncStateToRow(userId: string, syncState: SpendSyncState) {
  return {
    user_id: userId,
    source: syncState.source,
    status: syncState.status,
    label: syncState.label,
    detail: syncState.detail,
    accent: syncState.accent,
    last_synced_at: syncState.lastSyncedAt ?? null,
    updated_at: new Date().toISOString(),
  };
}

async function fetchLegacyState(): Promise<SpendDomainState | null> {
  const { data, error } = await supabase
    .from("spend_state")
    .select("state")
    .maybeSingle();
  if (error && isMissingNormalizedSchema(error)) return null;
  if (error) throw error;
  return (data?.state as SpendDomainState | undefined) ?? null;
}

async function saveLegacyState(state: SpendDomainState): Promise<void> {
  const userId = await currentUserId();
  if (!userId) throw new Error("Not authenticated — cannot save state");
  const { error } = await supabase
    .from("spend_state")
    .upsert(
      { user_id: userId, state, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
  if (error) throw error;
}

async function fetchNormalizedState(): Promise<SpendDomainState | null> {
  const [
    transactionsResult,
    categoriesResult,
    merchantRulesResult,
    learnedRulesResult,
    syncStatesResult,
  ] = await Promise.all([
    supabase.from("spend_transactions").select("*").order("occurred_at", { ascending: false }),
    supabase.from("spend_categories").select("*").order("label", { ascending: true }),
    supabase.from("spend_merchant_rules").select("*").order("priority", { ascending: false }),
    supabase.from("spend_learned_category_rules").select("*").order("updated_at", { ascending: false }),
    supabase.from("spend_sync_states").select("*"),
  ]);

  const firstError =
    transactionsResult.error ??
    categoriesResult.error ??
    merchantRulesResult.error ??
    learnedRulesResult.error ??
    syncStatesResult.error;

  if (firstError) throw firstError;

  const transactions = (transactionsResult.data ?? []) as TransactionRow[];
  const categories = (categoriesResult.data ?? []) as CategoryRow[];
  const merchantRules = (merchantRulesResult.data ?? []) as MerchantRuleRow[];
  const learnedRules = (learnedRulesResult.data ?? []) as LearnedRuleRow[];
  const syncStates = (syncStatesResult.data ?? []) as SyncStateRow[];
  const hasStoredRows =
    transactions.length > 0 ||
    categories.length > 0 ||
    merchantRules.length > 0 ||
    learnedRules.length > 0 ||
    syncStates.length > 0;

  if (!hasStoredRows) return null;

  const base = baseSpendState();

  return {
    transactions: transactions.map(transactionFromRow),
    categories: mergeById(base.categories, categories.map(categoryFromRow)),
    merchantRules: mergeById(base.merchantRules, merchantRules.map(merchantRuleFromRow)),
    learnedRules: learnedRules.map(learnedRuleFromRow),
    syncStates: mergeSyncStates(base.syncStates, syncStates.map(syncStateFromRow)),
  };
}

async function replaceNormalizedState(state: SpendDomainState): Promise<void> {
  const userId = await currentUserId();
  if (!userId) throw new Error("Not authenticated — cannot save state");

  const deleteResults = await Promise.all([
    supabase.from("spend_learned_category_rules").delete().eq("user_id", userId),
    supabase.from("spend_merchant_rules").delete().eq("user_id", userId),
    supabase.from("spend_categories").delete().eq("user_id", userId),
    supabase.from("spend_sync_states").delete().eq("user_id", userId),
    supabase.from("spend_transactions").delete().eq("user_id", userId),
  ]);
  const deleteError = deleteResults.find((result) => result.error)?.error;
  if (deleteError) throw deleteError;

  const insertResults = await Promise.all([
    state.transactions.length
      ? supabase.from("spend_transactions").insert(state.transactions.map((item) => transactionToRow(userId, item)))
      : Promise.resolve({ error: null }),
    state.categories.length
      ? supabase.from("spend_categories").insert(state.categories.map((item) => categoryToRow(userId, item)))
      : Promise.resolve({ error: null }),
    state.merchantRules.length
      ? supabase.from("spend_merchant_rules").insert(state.merchantRules.map((item) => merchantRuleToRow(userId, item)))
      : Promise.resolve({ error: null }),
    state.learnedRules.length
      ? supabase.from("spend_learned_category_rules").insert(state.learnedRules.map((item) => learnedRuleToRow(userId, item)))
      : Promise.resolve({ error: null }),
    state.syncStates.length
      ? supabase.from("spend_sync_states").insert(state.syncStates.map((item) => syncStateToRow(userId, item)))
      : Promise.resolve({ error: null }),
  ]);
  const insertError = insertResults.find((result) => result.error)?.error;
  if (insertError) throw insertError;
}

async function migrateLegacyStateIfNeeded(): Promise<SpendDomainState | null> {
  const legacyState = await fetchLegacyState();
  if (!legacyState) return null;

  replaceNormalizedState(legacyState).catch((error) => {
    if (!isMissingNormalizedSchema(error)) {
      console.warn("legacy state migration failed", error);
    }
  });

  return legacyState;
}

export async function fetchState(): Promise<SpendDomainState | null> {
  try {
    const normalizedState = await fetchNormalizedState();
    return normalizedState ?? await migrateLegacyStateIfNeeded();
  } catch (error) {
    if (isMissingNormalizedSchema(error)) {
      return fetchLegacyState();
    }
    throw error;
  }
}

export async function saveState(state: SpendDomainState): Promise<void> {
  let saved = false;
  let firstError: unknown;

  try {
    await replaceNormalizedState(state);
    saved = true;
  } catch (error) {
    if (!isMissingNormalizedSchema(error)) firstError = error;
  }

  try {
    await saveLegacyState(state);
    saved = true;
  } catch (error) {
    if (!isMissingNormalizedSchema(error)) {
      firstError ??= error;
      if (saved) console.warn("legacy state backup failed", error);
    }
  }

  if (!saved) throw firstError ?? new Error("No spend storage tables are available");
}

async function fetchLegacyBudgets(): Promise<MonthlyBudgetMap> {
  const { data, error } = await supabase
    .from("spend_budgets")
    .select("budgets")
    .maybeSingle();
  if (error && isMissingNormalizedSchema(error)) return {};
  if (error) throw error;
  return (data?.budgets as MonthlyBudgetMap | undefined) ?? {};
}

async function saveLegacyBudgets(budgets: MonthlyBudgetMap): Promise<void> {
  const userId = await currentUserId();
  if (!userId) throw new Error("Not authenticated — cannot save budgets");
  const { error } = await supabase
    .from("spend_budgets")
    .upsert(
      { user_id: userId, budgets, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
  if (error) throw error;
}

async function fetchNormalizedBudgets(): Promise<MonthlyBudgetMap | null> {
  const [budgetsResult, categoryBudgetsResult] = await Promise.all([
    supabase.from("spend_monthly_budgets").select("*").order("month_key", { ascending: false }),
    supabase.from("spend_monthly_category_budgets").select("*"),
  ]);

  const firstError = budgetsResult.error ?? categoryBudgetsResult.error;
  if (firstError) throw firstError;

  const budgets = (budgetsResult.data ?? []) as MonthlyBudgetRow[];
  const categoryBudgets = (categoryBudgetsResult.data ?? []) as MonthlyCategoryBudgetRow[];
  if (budgets.length === 0 && categoryBudgets.length === 0) return null;

  const categoryBudgetsByMonth = new Map<string, CategoryBudgetMap>();
  categoryBudgets.forEach((row) => {
    const monthBudget = categoryBudgetsByMonth.get(row.month_key) ?? {};
    monthBudget[row.category_id] = row.amount_minor;
    categoryBudgetsByMonth.set(row.month_key, monthBudget);
  });

  return budgets.reduce<MonthlyBudgetMap>((map, row) => {
    const categoryBudgetMap = categoryBudgetsByMonth.get(row.month_key) ?? {};
    const categoryTotalMinor = Object.values(categoryBudgetMap).reduce(
      (sum, amount) => sum + amount,
      0,
    );
    map[row.month_key] = {
      monthKey: row.month_key,
      // The parent total is the integrity check for missing/partial child rows.
      // Fall back to the child sum only for malformed legacy parent rows.
      amountMinor: row.amount_minor || categoryTotalMinor,
      categoryBudgets: categoryBudgetMap,
      setAt: row.set_at,
    };
    return map;
  }, {});
}

async function replaceNormalizedBudgets(budgets: MonthlyBudgetMap): Promise<void> {
  const userId = await currentUserId();
  if (!userId) throw new Error("Not authenticated — cannot save budgets");

  const monthRows = Object.values(budgets).map((budget) => ({
    user_id: userId,
    month_key: budget.monthKey,
    amount_minor: budget.amountMinor,
    set_at: budget.setAt,
    updated_at: new Date().toISOString(),
  }));
  const categoryRows = Object.values(budgets).flatMap((budget) =>
    Object.entries(budget.categoryBudgets).map(([categoryId, amountMinor]) => ({
      user_id: userId,
      month_key: budget.monthKey,
      category_id: categoryId,
      amount_minor: amountMinor,
      updated_at: new Date().toISOString(),
    })),
  );

  // Upsert before cleanup so a failed request cannot erase existing budgets.
  if (monthRows.length) {
    const { error } = await supabase
      .from("spend_monthly_budgets")
      .upsert(monthRows, { onConflict: "user_id,month_key" });
    if (error) throw error;
  }

  if (categoryRows.length) {
    const { error } = await supabase
      .from("spend_monthly_category_budgets")
      .upsert(categoryRows, { onConflict: "user_id,month_key,category_id" });
    if (error) throw error;
  }

  const [storedMonthsResult, storedCategoriesResult] = await Promise.all([
    supabase.from("spend_monthly_budgets").select("month_key"),
    supabase.from("spend_monthly_category_budgets").select("month_key,category_id"),
  ]);
  const readError = storedMonthsResult.error ?? storedCategoriesResult.error;
  if (readError) throw readError;

  const desiredMonths = new Set(Object.keys(budgets));
  const desiredCategories = new Set(
    categoryRows.map((row) => `${row.month_key}:${row.category_id}`),
  );
  const staleCategories = (storedCategoriesResult.data ?? []).filter(
    (row) => !desiredCategories.has(`${row.month_key}:${row.category_id}`),
  );
  const staleMonths = (storedMonthsResult.data ?? []).filter(
    (row) => !desiredMonths.has(row.month_key),
  );

  const cleanupResults = await Promise.all([
    ...staleCategories.map((row) =>
      supabase
        .from("spend_monthly_category_budgets")
        .delete()
        .eq("user_id", userId)
        .eq("month_key", row.month_key)
        .eq("category_id", row.category_id),
    ),
    ...staleMonths.map((row) =>
      supabase
        .from("spend_monthly_budgets")
        .delete()
        .eq("user_id", userId)
        .eq("month_key", row.month_key),
    ),
  ]);
  const cleanupError = cleanupResults.find((result) => result.error)?.error;
  if (cleanupError) throw cleanupError;
}

export async function fetchBudgets(): Promise<MonthlyBudgetMap> {
  try {
    const normalizedBudgets = await fetchNormalizedBudgets();
    return normalizedBudgets ?? {};
  } catch (error) {
    if (isMissingNormalizedSchema(error)) {
      return fetchLegacyBudgets();
    }
    throw error;
  }
}

export async function saveBudgets(budgets: MonthlyBudgetMap): Promise<void> {
  try {
    await replaceNormalizedBudgets(budgets);
  } catch (error) {
    if (isMissingNormalizedSchema(error)) {
      await saveLegacyBudgets(budgets);
      return;
    }
    throw error;
  }

  saveLegacyBudgets(budgets).catch((error) => {
    console.warn("legacy budget backup failed", error);
  });
}
