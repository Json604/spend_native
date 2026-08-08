import { SPEND_SOURCE_LABELS } from "../categories/categorySeeds";
import { daysRemainingInMonth } from "./budgetSelectors";
import {
  SpendCategoryOption,
  SpendCategoryPreview,
  SpendCategoryTotal,
  SpendContextType,
  SpendDomainState,
  SpendMonthSummary,
  SpendRecentPreview,
  SpendRepositorySnapshot,
  SpendReviewItem,
  SpendReviewPreview,
  SpendSourceKind,
  SpendSourceStatus,
  SpendSummary,
  SpendWidgetSnapshot,
} from "../types/types";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function isSameMonth(date: Date, referenceDate: Date) {
  return (
    date.getFullYear() === referenceDate.getFullYear() &&
    date.getMonth() === referenceDate.getMonth()
  );
}

function isSameDay(date: Date, referenceDate: Date) {
  return (
    date.getFullYear() === referenceDate.getFullYear() &&
    date.getMonth() === referenceDate.getMonth() &&
    date.getDate() === referenceDate.getDate()
  );
}

function asDate(value: string) {
  return new Date(value);
}

function formatMonthLabel(referenceDate: Date) {
  return `${MONTH_NAMES[referenceDate.getMonth()]} ${referenceDate.getFullYear()}`;
}

function formatCurrency(amountMinor: number) {
  const amount = amountMinor / 100;
  const wholeAmount = Number.isInteger(amount);
  return `Rs${wholeAmount ? amount.toFixed(0) : amount.toFixed(2)}`;
}

function formatDateLabel(value: string) {
  return asDate(value).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
  });
}

function formatSyncLabel(state: SpendDomainState) {
  const latestSync = state.syncStates
    .filter((item) => item.lastSyncedAt)
    .sort((left, right) => {
      const leftTime = left.lastSyncedAt ? asDate(left.lastSyncedAt).getTime() : 0;
      const rightTime = right.lastSyncedAt ? asDate(right.lastSyncedAt).getTime() : 0;
      return rightTime - leftTime;
    })[0];

  if (!latestSync?.lastSyncedAt) {
    return "Awaiting first sync";
  }

  return `Last synced ${latestSync.label}`;
}

export function selectMonthlyTransactions(
  state: SpendDomainState,
  referenceDate: Date = new Date(),
) {
  return state.transactions.filter((transaction) => {
    if (
      transaction.direction !== "debit" ||
      transaction.status === "ignored"
    ) {
      return false;
    }

    return isSameMonth(asDate(transaction.occurredAt), referenceDate);
  });
}

export function selectMonthlySummary(
  state: SpendDomainState,
  referenceDate: Date = new Date(),
): SpendMonthSummary {
  const monthlyTransactions = selectMonthlyTransactions(state, referenceDate);
  const reviewCount = monthlyTransactions.filter((transaction) => transaction.needsReview).length;
  const totalMinor = monthlyTransactions.reduce(
    (sum, transaction) => sum + transaction.amountMinor,
    0,
  );

  return {
    monthLabel: formatMonthLabel(referenceDate),
    totalMinor,
    transactionCount: monthlyTransactions.length,
    reviewCount,
  };
}

export function selectCategoryTotals(
  state: SpendDomainState,
  referenceDate: Date = new Date(),
): SpendCategoryTotal[] {
  const monthlyTransactions = selectMonthlyTransactions(state, referenceDate);

  return state.categories
    .filter((category) => !category.isReviewCategory && category.id !== "uncategorized")
    .map((category) => {
      const categoryTransactions = monthlyTransactions.filter(
        (transaction) => transaction.categoryId === category.id,
      );

      return {
        categoryId: category.id,
        label: category.label,
        tint: category.tint,
        amountMinor: categoryTransactions.reduce(
          (sum, transaction) => sum + transaction.amountMinor,
          0,
        ),
        transactionCount: categoryTransactions.length,
      };
    })
    .sort((left, right) => right.amountMinor - left.amountMinor || left.label.localeCompare(right.label));
}

export function selectTransactionsNeedingReview(
  state: SpendDomainState,
  referenceDate: Date = new Date(),
) {
  return selectMonthlyTransactions(state, referenceDate)
    .filter((transaction) => transaction.needsReview)
    .sort(
      (left, right) => asDate(right.occurredAt).getTime() - asDate(left.occurredAt).getTime(),
    );
}

export function selectRecentTransactions(
  state: SpendDomainState,
  limit = 8,
  referenceDate: Date = new Date(),
) {
  return selectMonthlyTransactions(state, referenceDate)
    .sort(
      (left, right) => asDate(right.occurredAt).getTime() - asDate(left.occurredAt).getTime(),
    )
    .slice(0, limit);
}

export type SpendDailyBucket = {
  date: string;
  dayLabel: string;
  weekdayLabel: string;
  fullLabel: string;
  amountMinor: number;
  transactionCount: number;
  isToday: boolean;
};

export function selectDailyBuckets(
  state: SpendDomainState,
  referenceDate: Date = new Date(),
): SpendDailyBucket[] {
  const buckets: SpendDailyBucket[] = [];
  const weekdayFormatter = new Intl.DateTimeFormat("en-IN", { weekday: "short" });
  const fullLabelFormatter = new Intl.DateTimeFormat("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });

  const days = referenceDate.getDate();

  for (let offset = days - 1; offset >= 0; offset--) {
    const bucketDate = new Date(referenceDate);
    bucketDate.setHours(0, 0, 0, 0);
    bucketDate.setDate(bucketDate.getDate() - offset);

    const bucketTransactions = state.transactions.filter(
      (transaction) =>
        transaction.direction === "debit" &&
        transaction.status !== "ignored" &&
        isSameDay(asDate(transaction.occurredAt), bucketDate),
    );

    const amountMinor = bucketTransactions.reduce(
      (sum, transaction) => sum + transaction.amountMinor,
      0,
    );

    buckets.push({
      date: bucketDate.toISOString(),
      dayLabel: String(bucketDate.getDate()),
      weekdayLabel: weekdayFormatter.format(bucketDate).charAt(0),
      fullLabel: fullLabelFormatter.format(bucketDate),
      amountMinor,
      transactionCount: bucketTransactions.length,
      isToday: offset === 0,
    });
  }

  return buckets;
}

export function createSpendRepositorySnapshot(
  state: SpendDomainState,
  referenceDate: Date = new Date(),
): SpendRepositorySnapshot {
  return {
    state,
    summary: selectMonthlySummary(state, referenceDate),
    categoryTotals: selectCategoryTotals(state, referenceDate),
    needsReviewTransactions: selectTransactionsNeedingReview(state, referenceDate),
    recentTransactions: selectRecentTransactions(state, 3, referenceDate),
  };
}

function buildSummary(snapshot: SpendRepositorySnapshot): SpendSummary {
  const { summary } = snapshot;
  const hasTransactions = summary.transactionCount > 0;
  const subtitle = hasTransactions
    ? summary.reviewCount > 0
      ? `Review ${summary.reviewCount} transfer${summary.reviewCount === 1 ? "" : "s"} to keep this total accurate.`
      : `${summary.transactionCount} SMS spend${summary.transactionCount === 1 ? "" : "s"} captured this month.`
    : "Refresh SMS to build your month.";

  return {
    monthLabel: summary.monthLabel,
    totalFormatted: formatCurrency(summary.totalMinor),
    subtitle,
    syncLabel: formatSyncLabel(snapshot.state),
  };
}

function buildCategoryPreview(snapshot: SpendRepositorySnapshot): SpendCategoryPreview[] {
  return snapshot.categoryTotals.slice(0, 4).map((category) => ({
    label: category.label,
    amountLabel:
      category.transactionCount > 0 ? formatCurrency(category.amountMinor) : "Ready",
    tint: category.tint,
  }));
}

function buildSourceStatuses(state: SpendDomainState): SpendSourceStatus[] {
  return state.syncStates
    .filter((syncState) => syncState.source === "sms")
    .map((syncState) => ({
      label: syncState.label,
      status:
        syncState.status === "needs_permission"
          ? "Permission needed"
          : syncState.status === "ready"
          ? "Ready"
          : syncState.status === "syncing"
            ? "Syncing"
            : syncState.status === "error"
              ? "Error"
              : "Not connected",
    detail: syncState.detail,
      accent: syncState.accent,
    }));
}

function buildCategoryOptions(state: SpendDomainState): SpendCategoryOption[] {
  return state.categories
    .filter((category) => !category.isReviewCategory && category.id !== "uncategorized")
    .map((category) => ({
      id: category.id,
      label: category.label,
      tint: category.tint,
      isCustom: !category.isSystem,
      parentId: category.parentId,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

function buildReviewItems(snapshot: SpendRepositorySnapshot): SpendReviewItem[] {
  return snapshot.needsReviewTransactions.map((transaction) => ({
    transactionId: transaction.id,
    payee: transaction.merchantName,
    amountLabel: formatCurrency(transaction.amountMinor),
    occurredAtLabel: formatDateLabel(transaction.occurredAt),
    description: transaction.description,
  }));
}

function firstReviewPreview(snapshot: SpendRepositorySnapshot): SpendReviewPreview {
  const firstReviewTransaction = buildReviewItems(snapshot)[0];

  if (!firstReviewTransaction) {
    return {
      payee: "No pending reviews",
      hint: "Unclear personal payments will appear here so you can teach Spend the right category once and reuse it later.",
    };
  }

  return {
    transactionId: firstReviewTransaction.transactionId,
    payee: firstReviewTransaction.payee,
    amountLabel: firstReviewTransaction.amountLabel,
    hint: "This transfer needs a category. Once you choose one, future payments to the same person can be auto-categorized locally.",
  };
}

function transactionSourceLabel(source: SpendSourceKind) {
  return SPEND_SOURCE_LABELS[source];
}

function buildRecentPreview(snapshot: SpendRepositorySnapshot): SpendRecentPreview[] {
  if (!snapshot.recentTransactions.length) {
    return [
      {
        merchant: "Awaiting first transaction",
        amountLabel: "Awaiting sync",
        source: "SMS",
        category: "Spend",
      },
    ];
  }

  return snapshot.recentTransactions.map((transaction) => ({
    merchant: transaction.merchantName,
    amountLabel: formatCurrency(transaction.amountMinor),
    source: transactionSourceLabel(transaction.source),
    category: transaction.categoryLabel ?? "Needs review",
  }));
}

function buildWidgetSnapshot(
  snapshot: SpendRepositorySnapshot,
  referenceDate: Date,
): SpendWidgetSnapshot {
  const todayTransactions = snapshot.state.transactions.filter(
    (transaction) =>
      transaction.direction === "debit" &&
      transaction.status !== "ignored" &&
      isSameDay(asDate(transaction.occurredAt), referenceDate),
  );
  const todayMinor = todayTransactions.reduce(
    (sum, transaction) => sum + transaction.amountMinor,
    0,
  );

  const todayCategoryTotals = new Map<string, number>();
  todayTransactions.forEach((transaction) => {
    const label = transaction.categoryLabel ?? "Needs Review";
    todayCategoryTotals.set(
      label,
      (todayCategoryTotals.get(label) ?? 0) + transaction.amountMinor,
    );
  });

  const monthFormatted = formatCurrency(snapshot.summary.totalMinor);

  return {
    monthLabel: snapshot.summary.monthLabel,
    totalFormatted: monthFormatted,
    todayLabel: "Today",
    todayFormatted: formatCurrency(todayMinor),
    monthTotalCaption: `${snapshot.summary.monthLabel} · ${monthFormatted}`,
    syncLabel: formatSyncLabel(snapshot.state),
    topCategories: Array.from(todayCategoryTotals.entries())
      .sort(([, leftAmount], [, rightAmount]) => rightAmount - leftAmount)
      .map(([label, amountMinor]) => ({
        label,
        amountLabel: formatCurrency(amountMinor),
      })),
    monthBudgetMinor: null,
    monthSpentMinor: snapshot.summary.totalMinor,
    daysRemainingInMonth: daysRemainingInMonth(referenceDate),
  };
}

export function selectSpendContextValue(
  repository: SpendContextType["repository"],
  referenceDate: Date = new Date(),
): Omit<SpendContextType, "actions"> {
  const domain = repository.getSnapshot(referenceDate);

  return {
    repository,
    domain,
    summary: buildSummary(domain),
    categories: buildCategoryPreview(domain),
    categoryOptions: buildCategoryOptions(domain.state),
    sourceStatuses: buildSourceStatuses(domain.state),
    reviewPreview: firstReviewPreview(domain),
    reviewItems: buildReviewItems(domain),
    recentPreview: buildRecentPreview(domain),
    widgetSnapshot: buildWidgetSnapshot(domain, referenceDate),
    currentMonthBudget: null,
  };
}
