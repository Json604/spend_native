import {
  SPEND_CATEGORY_DEFINITIONS,
  SPEND_MERCHANT_RULES,
} from "../categories/categorySeeds";
import {
  LearnedCategoryRule,
  LearnedCategoryRuleInput,
  SpendCategoryDefinition,
  SpendCategoryId,
  SpendDomainState,
  SpendMerchantRule,
  SpendRepository,
  SpendSeedTransactionInput,
  SpendStorageAdapter,
  SpendSyncState,
  SpendSourceKind,
  SpendTransaction,
} from "../types/types";
import { createSpendRepositorySnapshot } from "./selectors";

function normalizeToken(value: string | undefined) {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeCounterparty(value: string | undefined) {
  return normalizeToken(value).replace(/[^a-z0-9:@._ -]/g, "");
}

function hourBucket(value: string) {
  const date = new Date(value);
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  const hour = `${date.getUTCHours()}`.padStart(2, "0");

  return `${year}-${month}-${day}-${hour}`;
}

function buildLearnedRuleId(normalizedCounterparty: string) {
  return `learned:${normalizedCounterparty}`;
}

function buildCustomCategoryId(label: string) {
  return `custom:${normalizeCounterparty(label).replace(/\s+/g, "-")}` as SpendCategoryId;
}

function cloneCategories(categories: SpendCategoryDefinition[]) {
  return categories.map((category) => ({ ...category }));
}

function cloneMerchantRules(rules: SpendMerchantRule[]) {
  return rules.map((rule) => ({
    ...rule,
    merchantTokens: rule.merchantTokens ? [...rule.merchantTokens] : undefined,
    senderTokens: rule.senderTokens ? [...rule.senderTokens] : undefined,
    upiHandleTokens: rule.upiHandleTokens ? [...rule.upiHandleTokens] : undefined,
    descriptionTokens: rule.descriptionTokens ? [...rule.descriptionTokens] : undefined,
  }));
}

function cloneLearnedRules(rules: LearnedCategoryRule[]) {
  return rules.map((rule) => ({ ...rule }));
}

function cloneSyncStates(syncStates: SpendSyncState[]) {
  return syncStates.map((syncState) => ({ ...syncState }));
}

function cloneTransactions(transactions: SpendTransaction[]) {
  return transactions.map((transaction) => ({ ...transaction }));
}

function cloneState(state: SpendDomainState): SpendDomainState {
  return {
    transactions: cloneTransactions(state.transactions),
    categories: cloneCategories(state.categories),
    merchantRules: cloneMerchantRules(state.merchantRules),
    learnedRules: cloneLearnedRules(state.learnedRules),
    syncStates: cloneSyncStates(state.syncStates),
  };
}

function mergeById<T extends { id: string }>(remoteItems: T[], localItems: T[]) {
  const merged = new Map<string, T>();

  remoteItems.forEach((item) => merged.set(item.id, { ...item }));
  localItems.forEach((item) => merged.set(item.id, { ...item }));

  return Array.from(merged.values());
}

function mergeSyncStates(
  remoteItems: SpendSyncState[],
  localItems: SpendSyncState[],
) {
  const merged = new Map<SpendSourceKind, SpendSyncState>();

  remoteItems.forEach((item) => merged.set(item.source, { ...item }));
  localItems.forEach((item) => merged.set(item.source, { ...item }));

  return Array.from(merged.values());
}

function transactionIdentityKeys(transaction: SpendTransaction) {
  return [
    transaction.id,
    transaction.externalFingerprint,
    transaction.sourceMessageId ? `${transaction.source}:${transaction.sourceMessageId}` : undefined,
  ].filter((key): key is string => Boolean(key));
}

function mergeTransactionsByIdentity(
  remoteTransactions: SpendTransaction[],
  localTransactions: SpendTransaction[],
) {
  const mergedTransactions = cloneTransactions(remoteTransactions);
  const indexByIdentity = new Map<string, number>();

  mergedTransactions.forEach((transaction, index) => {
    transactionIdentityKeys(transaction).forEach((key) => {
      indexByIdentity.set(key, index);
    });
  });

  localTransactions.forEach((localTransaction) => {
    const duplicateIndex = transactionIdentityKeys(localTransaction)
      .map((key) => indexByIdentity.get(key))
      .find((index): index is number => typeof index === "number");

    if (typeof duplicateIndex === "number") {
      mergedTransactions[duplicateIndex] = { ...localTransaction };
      transactionIdentityKeys(localTransaction).forEach((key) => {
        indexByIdentity.set(key, duplicateIndex);
      });
      return;
    }

    const nextIndex = mergedTransactions.length;
    mergedTransactions.push({ ...localTransaction });
    transactionIdentityKeys(localTransaction).forEach((key) => {
      indexByIdentity.set(key, nextIndex);
    });
  });

  return mergedTransactions.sort(
    (left, right) =>
      new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime(),
  );
}

export function mergeSpendDomainStates(
  remoteState: SpendDomainState,
  localState: SpendDomainState,
): SpendDomainState {
  return {
    transactions: mergeTransactionsByIdentity(remoteState.transactions, localState.transactions),
    categories: mergeById(remoteState.categories, localState.categories),
    merchantRules: mergeById(remoteState.merchantRules, localState.merchantRules),
    learnedRules: mergeById(remoteState.learnedRules, localState.learnedRules),
    syncStates: mergeSyncStates(remoteState.syncStates, localState.syncStates),
  };
}

function findCategoryLabel(
  categories: SpendCategoryDefinition[],
  categoryId: SpendCategoryId,
  fallbackLabel?: string,
) {
  return categories.find((category) => category.id === categoryId)?.label ?? fallbackLabel ?? "Uncategorized";
}

function findCategoryByLabel(
  categories: SpendCategoryDefinition[],
  label: string,
) {
  const normalizedLabel = normalizeToken(label);
  return categories.find(
    (category) => normalizeToken(category.label) === normalizedLabel,
  );
}

function pickCustomCategoryTint(existingCount: number) {
  const palette = [
    "rgba(121, 214, 255, 0.88)",
    "rgba(160, 255, 180, 0.88)",
    "rgba(255, 179, 102, 0.88)",
    "rgba(255, 134, 180, 0.88)",
    "rgba(196, 167, 255, 0.88)",
  ];

  return palette[existingCount % palette.length];
}

function matchRule(transaction: SpendTransaction, rule: SpendMerchantRule) {
  const haystacks = [
    transaction.normalizedMerchantName,
    normalizeToken(transaction.description),
    normalizeToken(transaction.counterpartyKey),
  ];

  const matchesTokens = (tokens?: string[]) =>
    !tokens?.length || tokens.some((token) => haystacks.some((haystack) => haystack.includes(token)));

  return (
    matchesTokens(rule.merchantTokens) &&
    matchesTokens(rule.senderTokens) &&
    matchesTokens(rule.upiHandleTokens) &&
    matchesTokens(rule.descriptionTokens)
  );
}

function categorizeTransaction(
  transaction: SpendTransaction,
  state: SpendDomainState,
): SpendTransaction {
  if (transaction.direction !== "debit") {
    return {
      ...transaction,
      categoryId: undefined,
      categoryLabel: undefined,
      categorySource: "uncategorized",
      needsReview: false,
    };
  }

  const matchedRule = [...state.merchantRules]
    .sort((left, right) => right.priority - left.priority)
    .find((rule) => matchRule(transaction, rule));

  if (matchedRule) {
    return {
      ...transaction,
      categoryId: matchedRule.categoryId,
      categoryLabel: findCategoryLabel(state.categories, matchedRule.categoryId, matchedRule.label),
      categorySource: "merchant_rule",
      needsReview: false,
    };
  }

  return {
    ...transaction,
    categoryId: "needs-review",
    categoryLabel: findCategoryLabel(state.categories, "needs-review"),
    categorySource: "uncategorized",
    needsReview: true,
  };
}

// Detect credits (money received) that were mis-classified as debits.
// Bank SMS parsers sometimes flag "Received Rs.X..." messages as debits because
// they hit transaction keywords. Authoritative fix: scan the description text.
const CREDIT_DESCRIPTION_RE =
  /\b(received|credited|refund(?:ed)?|deposit(?:ed)?|reversed|reversal|cashback|incoming)\b/i;

function inferDirection(input: SpendSeedTransactionInput) {
  if (input.direction !== "debit") return input.direction;
  if (CREDIT_DESCRIPTION_RE.test(input.description ?? "")) return "credit" as const;
  return "debit" as const;
}

function createTransaction(input: SpendSeedTransactionInput, state: SpendDomainState): SpendTransaction {
  const normalizedMerchantName = normalizeToken(input.merchantName);
  const counterpartyKey =
    input.source === "sms"
      ? input.counterpartyKey
        ? normalizeCounterparty(input.counterpartyKey)
        : undefined
      : normalizeCounterparty(
          input.counterpartyKey ?? input.merchantName ?? input.description,
        );

  return categorizeTransaction(
    {
      ...input,
      direction: inferDirection(input),
      normalizedMerchantName,
      counterpartyKey,
      categoryId: undefined,
      categoryLabel: undefined,
      categorySource: "uncategorized",
      needsReview: false,
    },
    state,
  );
}

function buildApproxFingerprint(transaction: Pick<
  SpendTransaction,
  "occurredAt" | "amountMinor" | "merchantName" | "counterpartyKey"
>) {
  return [
    hourBucket(transaction.occurredAt),
    transaction.amountMinor,
    normalizeCounterparty(transaction.counterpartyKey ?? transaction.merchantName),
  ].join(":");
}

function isDuplicateTransaction(
  left: SpendTransaction,
  right: SpendTransaction,
) {
  if (left.id === right.id) {
    return true;
  }

  if (
    left.externalFingerprint &&
    right.externalFingerprint &&
    left.externalFingerprint === right.externalFingerprint
  ) {
    return true;
  }

  return buildApproxFingerprint(left) === buildApproxFingerprint(right);
}

function mergeTransactions(
  existingTransaction: SpendTransaction,
  nextTransaction: SpendTransaction,
): SpendTransaction {
  const shouldKeepExistingCategory =
    existingTransaction.categorySource === "manual" ||
    existingTransaction.categorySource === "learned_rule";
  const shouldUpgradeCategory =
    !shouldKeepExistingCategory &&
    existingTransaction.needsReview &&
    !nextTransaction.needsReview;

  return {
    ...existingTransaction,
    source:
      existingTransaction.source === "sms" || nextTransaction.source !== "sms"
        ? existingTransaction.source
        : nextTransaction.source,
    sourceMessageId: existingTransaction.sourceMessageId ?? nextTransaction.sourceMessageId,
    externalFingerprint:
      existingTransaction.externalFingerprint ?? nextTransaction.externalFingerprint,
    merchantName:
      existingTransaction.merchantName === "Unknown payee"
        ? nextTransaction.merchantName
        : existingTransaction.merchantName,
    normalizedMerchantName:
      existingTransaction.merchantName === "Unknown payee"
        ? nextTransaction.normalizedMerchantName
        : existingTransaction.normalizedMerchantName,
    counterpartyKey: existingTransaction.counterpartyKey ?? nextTransaction.counterpartyKey,
    description:
      nextTransaction.description.length > existingTransaction.description.length
        ? nextTransaction.description
        : existingTransaction.description,
    channel:
      existingTransaction.channel === "unknown"
        ? nextTransaction.channel
        : existingTransaction.channel,
    categoryId: shouldUpgradeCategory
      ? nextTransaction.categoryId
      : existingTransaction.categoryId,
    categoryLabel: shouldUpgradeCategory
      ? nextTransaction.categoryLabel
      : existingTransaction.categoryLabel,
    categorySource: shouldUpgradeCategory
      ? nextTransaction.categorySource
      : existingTransaction.categorySource,
    needsReview: shouldUpgradeCategory ? nextTransaction.needsReview : existingTransaction.needsReview,
  };
}

export function createInMemorySpendStorageAdapter(
  initialState: SpendDomainState,
): SpendStorageAdapter {
  let currentState = cloneState(initialState);

  return {
    readState() {
      return cloneState(currentState);
    },
    writeState(state) {
      currentState = cloneState(state);
    },
  };
}

export function createSeedSpendDomainState(
  partial?: Partial<Pick<SpendDomainState, "transactions" | "learnedRules" | "syncStates">>,
): SpendDomainState {
  return {
    transactions: cloneTransactions(partial?.transactions ?? []),
    categories: cloneCategories(SPEND_CATEGORY_DEFINITIONS),
    merchantRules: cloneMerchantRules(SPEND_MERCHANT_RULES),
    learnedRules: cloneLearnedRules(partial?.learnedRules ?? []),
    syncStates: cloneSyncStates(
      partial?.syncStates ?? [
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
    ),
  };
}

export function createSpendRepository(adapter: SpendStorageAdapter): SpendRepository {
  const persist = (state: SpendDomainState) => {
    adapter.writeState(state);
    return adapter.readState();
  };

  const getState = () => adapter.readState();

  const ensureCategory = (
    label: string,
    opts?: { parentId?: SpendCategoryId },
  ) => {
    const trimmedLabel = label.trim();

    if (!trimmedLabel) {
      throw new Error("Category label is required.");
    }

    const currentState = getState();
    const existingCategory = findCategoryByLabel(currentState.categories, trimmedLabel);

    // Prevent assigning a parent that itself has a parent (only one level deep).
    let resolvedParentId: SpendCategoryId | undefined;
    if (opts?.parentId) {
      const parent = currentState.categories.find((c) => c.id === opts.parentId);
      if (parent && !parent.parentId && !parent.isReviewCategory) {
        resolvedParentId = parent.id;
      }
    }

    if (existingCategory) {
      // Update parent if newly specified and existing has none.
      if (resolvedParentId && !existingCategory.parentId) {
        const updated: SpendCategoryDefinition = {
          ...existingCategory,
          parentId: resolvedParentId,
        };
        const nextState = persist({
          ...currentState,
          categories: currentState.categories.map((c) =>
            c.id === existingCategory.id ? updated : c,
          ),
        });
        return (
          nextState.categories.find((c) => c.id === existingCategory.id) ?? updated
        );
      }
      return existingCategory;
    }

    const customCategoryCount = currentState.categories.filter(
      (category) => !category.isSystem,
    ).length;
    const nextCategory: SpendCategoryDefinition = {
      id: buildCustomCategoryId(trimmedLabel),
      label: trimmedLabel,
      tint: pickCustomCategoryTint(customCategoryCount),
      isSystem: false,
      parentId: resolvedParentId,
    };

    const nextState = persist({
      ...currentState,
      categories: [...currentState.categories, nextCategory],
    });

    return (
      nextState.categories.find((category) => category.id === nextCategory.id) ??
      nextCategory
    );
  };

  const saveLearnedCategoryRule = (input: LearnedCategoryRuleInput) => {
    const currentState = getState();
    const normalizedCounterparty = normalizeCounterparty(input.normalizedCounterparty);
    const timestamp = new Date().toISOString();
    const existingRule = currentState.learnedRules.find(
      (rule) => rule.normalizedCounterparty === normalizedCounterparty,
    );
    const nextRule: LearnedCategoryRule = {
      id: buildLearnedRuleId(normalizedCounterparty),
      categoryId: input.categoryId,
      categoryLabel: input.categoryLabel,
      normalizedCounterparty,
      createdAt: existingRule?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };

    const nextLearnedRules = [
      ...currentState.learnedRules.filter(
        (rule) => rule.normalizedCounterparty !== normalizedCounterparty,
      ),
      nextRule,
    ];

    persist({
      ...currentState,
      learnedRules: nextLearnedRules,
      transactions: currentState.transactions.map((transaction) =>
        transaction.counterpartyKey === normalizedCounterparty
          ? categorizeTransaction(transaction, {
              ...currentState,
              learnedRules: nextLearnedRules,
            })
          : transaction,
      ),
    });

    return nextRule;
  };

  return {
    getState,
    getSnapshot(referenceDate = new Date()) {
      return createSpendRepositorySnapshot(getState(), referenceDate);
    },
    upsertTransactions(inputs) {
      const currentState = getState();
      const nextTransactions = [...currentState.transactions];

      inputs.forEach((input) => {
        const nextTransaction = createTransaction(input, currentState);
        const duplicateIndex = nextTransactions.findIndex((transaction) =>
          isDuplicateTransaction(transaction, nextTransaction),
        );

        if (duplicateIndex >= 0) {
          nextTransactions[duplicateIndex] = mergeTransactions(
            nextTransactions[duplicateIndex],
            nextTransaction,
          );
          return;
        }

        nextTransactions.push(nextTransaction);
      });

      return persist({
        ...currentState,
        transactions: nextTransactions.sort(
          (left, right) =>
            new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime(),
        ),
      });
    },
    ensureCategory,
    saveLearnedCategoryRule,
    assignCategoryToTransaction(transactionId, categoryId, categoryLabel) {
      const currentState = getState();
      const existingTransaction = currentState.transactions.find(
        (transaction) => transaction.id === transactionId,
      );

      if (!existingTransaction) {
        return undefined;
      }

      const nextTransaction: SpendTransaction = {
        ...existingTransaction,
        categoryId,
        categoryLabel,
        categorySource: "manual",
        needsReview: false,
      };

      const nextState = persist({
        ...currentState,
        transactions: currentState.transactions.map((transaction) =>
          transaction.id === transactionId ? nextTransaction : transaction,
        ),
      });

      return nextState.transactions.find((transaction) => transaction.id === transactionId);
    },
    setTransactionPlanType(transactionId, planType) {
      const currentState = getState();
      const existing = currentState.transactions.find((t) => t.id === transactionId);
      if (!existing) return undefined;
      const nextState = persist({
        ...currentState,
        transactions: currentState.transactions.map((t) =>
          t.id === transactionId ? { ...t, planType } : t,
        ),
      });
      return nextState.transactions.find((t) => t.id === transactionId);
    },
    ignoreTransaction(transactionId) {
      const currentState = getState();
      const existingTransaction = currentState.transactions.find(
        (transaction) => transaction.id === transactionId,
      );

      if (!existingTransaction) {
        return undefined;
      }

      const nextState = persist({
        ...currentState,
        transactions: currentState.transactions.map((transaction) =>
          transaction.id === transactionId
            ? {
                ...transaction,
                status: "ignored",
                categoryId: undefined,
                categoryLabel: undefined,
                categorySource: "uncategorized",
                needsReview: false,
              }
            : transaction,
        ),
      });

      return nextState.transactions.find((transaction) => transaction.id === transactionId);
    },
    deleteTransaction(transactionId) {
      const currentState = getState();
      const next = currentState.transactions.filter((t) => t.id !== transactionId);
      if (next.length === currentState.transactions.length) return false;
      persist({ ...currentState, transactions: next });
      return true;
    },
    deleteCategory(categoryId) {
      const currentState = getState();
      const target = currentState.categories.find((c) => c.id === categoryId);
      if (!target || target.isSystem) return false;

      // Promote any child categories to top-level so they don't dangle.
      const nextCategories = currentState.categories
        .filter((c) => c.id !== categoryId)
        .map((c) => (c.parentId === categoryId ? { ...c, parentId: undefined } : c));

      // Untag transactions that referenced this category.
      const nextTransactions = currentState.transactions.map((t) =>
        t.categoryId === categoryId
          ? {
              ...t,
              categoryId: undefined,
              categoryLabel: undefined,
              categorySource: "uncategorized" as const,
              needsReview: t.direction === "debit" && t.status !== "ignored",
            }
          : t,
      );

      // Drop learned rules tied to it so we don't re-tag future txns.
      const nextLearnedRules = currentState.learnedRules.filter((r) => r.categoryId !== categoryId);

      persist({
        ...currentState,
        categories: nextCategories,
        transactions: nextTransactions,
        learnedRules: nextLearnedRules,
      });
      return true;
    },
    renameCategory(categoryId, newLabel) {
      const trimmed = newLabel.trim();
      if (!trimmed) return undefined;
      const currentState = getState();
      const target = currentState.categories.find((c) => c.id === categoryId);
      if (!target || target.isSystem) return undefined;

      const duplicate = currentState.categories.find(
        (c) => c.id !== categoryId && normalizeToken(c.label) === normalizeToken(trimmed),
      );
      if (duplicate) throw new Error("A category with that name already exists.");

      const nextCategories = currentState.categories.map((c) =>
        c.id === categoryId ? { ...c, label: trimmed } : c,
      );
      const nextTransactions = currentState.transactions.map((t) =>
        t.categoryId === categoryId ? { ...t, categoryLabel: trimmed } : t,
      );

      const nextState = persist({
        ...currentState,
        categories: nextCategories,
        transactions: nextTransactions,
      });
      return nextState.categories.find((c) => c.id === categoryId);
    },
    updateSyncState(source: SpendSourceKind, patch) {
      const currentState = getState();
      const nextState = persist({
        ...currentState,
        syncStates: currentState.syncStates.map((syncState) =>
          syncState.source === source ? { ...syncState, ...patch } : syncState,
        ),
      });

      return nextState.syncStates.find((syncState) => syncState.source === source);
    },
  };
}
