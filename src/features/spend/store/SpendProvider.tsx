import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ActivityIndicator, Alert, AppState, type AppStateStatus, DeviceEventEmitter, View } from "react-native";
import type {
  CategoryBudgetMap,
  SpendCategoryId,
  SpendCategoryOption,
  SpendCategoryPreview,
  SpendContextType,
  SpendDomainState,
  SpendPlanType,
  SpendRepositorySnapshot,
  SpendSourceKind,
  SpendSyncState,
  SpendTransaction,
} from "../types/types";
import {
  accountingMonthKey,
  currentAccountingDateKey,
  previousAccountingMonthKey,
  spendCurrency,
  spendMonthLabel,
  sqliteRepository,
  type SqliteSpendRepository,
} from "./sqliteRepository";
import { pushWidgetSnapshot } from "../services/widgetBridge";
import {
  convertSmsCandidatesToTransactions,
  getSmsPermissionState,
  loadSmsIngestionSnapshot,
  requestSmsReadPermission,
  startOfTodayMillis,
} from "../services/smsIngestion";
import { consumePendingSmsRefreshFlag } from "../services/smsNativeModule";
import { useAuth } from "../../../auth/AuthProvider";
import { syncClient } from "../../../sync/syncClient";
import { syncEngine } from "../../../sync/syncEngine";

const SpendContext = createContext<SpendContextType | undefined>(undefined);

const initialSyncStates: SpendSyncState[] = [
  {
    source: "sms",
    status: "idle",
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
];

type LoadedSpendData = {
  /** Which month this snapshot describes, so a stale one can be recognised. */
  monthKey: string;
  state: SpendDomainState;
  domain: SpendRepositorySnapshot;
  summary: SpendContextType["summary"];
  categories: SpendCategoryPreview[];
  categoryOptions: SpendCategoryOption[];
  reviewItems: SpendContextType["reviewItems"];
  reviewPreview: SpendContextType["reviewPreview"];
  widgetSnapshot: SpendContextType["widgetSnapshot"];
  currentMonthBudget: SpendContextType["currentMonthBudget"];
  dailyBuckets: SpendContextType["dailyBuckets"];
};

function buildLoadedData(
  monthKey: string,
  syncStates: SpendSyncState[],
  transactions: SpendTransaction[],
  categories: Awaited<ReturnType<SqliteSpendRepository["categories"]>>,
  breakdown: Awaited<ReturnType<SqliteSpendRepository["categoryBreakdown"]>>,
  previousBreakdown: Awaited<ReturnType<SqliteSpendRepository["categoryBreakdown"]>>,
  summaryRow: Awaited<ReturnType<SqliteSpendRepository["monthSummary"]>>,
  reviewTransactions: SpendTransaction[],
  budget: SpendContextType["currentMonthBudget"],
  dailyBuckets: SpendContextType["dailyBuckets"],
): LoadedSpendData {
  const previousSpent = new Map(previousBreakdown.map((row) => [row.categoryId, row.spentMinor]));
  const summaryBase = {
    monthLabel: spendMonthLabel(monthKey),
    totalMinor: summaryRow.totalSpentMinor,
    transactionCount: summaryRow.transactionCount,
    reviewCount: summaryRow.reviewCount,
  };
  const domain: SpendRepositorySnapshot = {
    state: { transactions, categories, merchantRules: [], learnedRules: [], syncStates },
    summary: summaryBase,
    categoryTotals: breakdown
      .filter((row) => row.categoryId !== "uncategorized" && row.categoryId !== "needs-review")
      .map((row) => ({
        categoryId: row.categoryId,
        label: row.label,
        tint: row.tint,
        amountMinor: row.spentMinor,
        transactionCount: 0,
      })),
    needsReviewTransactions: reviewTransactions,
    recentTransactions: transactions.filter((transaction) => transaction.status !== "ignored").slice(0, 3),
  };
  const categoryOptions = categories
    .filter((category) => !category.isReviewCategory && category.id !== "uncategorized")
    .map((category) => ({
      id: category.id,
      label: category.label,
      tint: category.tint,
      isCustom: !category.isSystem,
      parentId: category.parentId,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
  const categoriesPreview = breakdown
    .filter((row) => row.categoryId !== "uncategorized" && row.categoryId !== "needs-review")
    .map((row) => ({
      id: row.categoryId,
      label: row.label,
      tint: row.tint,
      amountLabel: row.spentMinor > 0 ? spendCurrency(row.spentMinor) : "Ready",
      budgetAmountLabel: row.budgetedMinor > 0 ? spendCurrency(row.budgetedMinor) : undefined,
      spentMinor: row.spentMinor,
      budgetMinor: row.budgetedMinor > 0 ? row.budgetedMinor : undefined,
      pct: row.budgetedMinor > 0 ? row.spentMinor / row.budgetedMinor : 0,
      // undefined means "no comparable previous month", which the card skips.
      deltaMinor: previousSpent.has(row.categoryId)
        ? row.spentMinor - (previousSpent.get(row.categoryId) ?? 0)
        : undefined,
      parentId: row.parentId,
      depth: row.parentId ? 1 : 0,
    }));
  const reviewItems = reviewTransactions.map((transaction) => ({
    transactionId: transaction.id,
    payee: transaction.merchantName,
    amountLabel: spendCurrency(transaction.amountMinor),
    occurredAtLabel: new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }).format(new Date(transaction.occurredAt)),
    description: transaction.description,
  }));
  const firstReview = reviewItems[0];
  const todayBucket = dailyBuckets.find((bucket) => bucket.isToday);
  const summary = {
    monthLabel: summaryBase.monthLabel,
    totalFormatted: spendCurrency(summaryBase.totalMinor),
    subtitle: summaryBase.transactionCount > 0
      ? summaryBase.reviewCount > 0
        ? `Review ${summaryBase.reviewCount} transfer${summaryBase.reviewCount === 1 ? "" : "s"} to keep this total accurate.`
        : `${summaryBase.transactionCount} spend${summaryBase.transactionCount === 1 ? "" : "s"} captured this month.`
      : "Refresh SMS to build your month.",
    syncLabel: syncStates.find((item) => item.status === "ready")?.label ?? "Awaiting first sync",
  };
  const todayKey = currentAccountingDateKey();
  const todaySpends = transactions
    .filter((transaction) =>
      transaction.direction === "debit" &&
      transaction.status !== "ignored" &&
      currentAccountingDateKey(Date.parse(transaction.occurredAt)) === todayKey)
    .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt))
    .slice(0, 8)
    .map((transaction) => ({
      label: transaction.merchantName || "Unknown payee",
      amountLabel: spendCurrency(transaction.amountMinor),
    }));
  const widgetSnapshot = {
    monthLabel: summaryBase.monthLabel,
    totalFormatted: summary.totalFormatted,
    todayLabel: "Today",
    todayFormatted: spendCurrency(todayBucket?.amountMinor ?? 0),
    monthTotalCaption: `${summaryBase.monthLabel} · ${summary.totalFormatted}`,
    syncLabel: summary.syncLabel,
    topCategories: categoriesPreview.slice(0, 4).map((category) => ({ label: category.label, amountLabel: category.amountLabel, spentMinor: category.spentMinor, budgetMinor: category.budgetMinor })),
    todaySpends,
    monthBudgetMinor: budget?.amountMinor ?? null,
    monthSpentMinor: summaryBase.totalMinor,
    daysRemainingInMonth: summaryRow.daysRemaining,
  };
  return {
    monthKey,
    state: domain.state,
    domain,
    summary,
    categories: categoriesPreview,
    categoryOptions,
    reviewItems,
    reviewPreview: firstReview
      ? { transactionId: firstReview.transactionId, payee: firstReview.payee, amountLabel: firstReview.amountLabel, hint: "This transfer needs a category. Choose one to teach Spend the right category." }
      : { payee: "No pending reviews", hint: "Unclear personal payments will appear here for review." },
    widgetSnapshot,
    currentMonthBudget: budget,
    dailyBuckets,
  };
}

export function SpendProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const repository = sqliteRepository;
  const [selectedMonth, setSelectedMonth] = useState(accountingMonthKey());
  const [availableMonths, setAvailableMonths] = useState<string[]>([accountingMonthKey()]);
  const [loaded, setLoaded] = useState<LoadedSpendData | null>(null);
  const [loading, setLoading] = useState(true);
  const [dataRevision, setDataRevision] = useState(0);
  const [hydrating, setHydrating] = useState(false);
  const [syncStates, setSyncStates] = useState(initialSyncStates);

  const updateSyncState = useCallback((source: SpendSourceKind, patch: Partial<SpendSyncState>) => {
    setSyncStates((current) => {
      let changed = false;
      const next = current.map((item) => {
        if (item.source !== source) return item;
        const merged = { ...item, ...patch };
        const differs = (Object.keys(patch) as (keyof SpendSyncState)[]).some((key) => item[key] !== patch[key]);
        if (!differs) return item;
        changed = true;
        return merged;
      });
      // Returning a fresh array for an unchanged value would retrigger every
      // effect that watches sync state — including the one that reloads the
      // whole month — so an idempotent write has to be a genuine no-op.
      return changed ? next : current;
    });
  }, []);

  const syncAccount = useCallback(async () => {
    if (!user) return;
    updateSyncState("gmail", { status: "syncing", detail: "Syncing your account across devices." });
    const report = await syncClient.sync();
    updateSyncState("gmail", {
      status: report.error ? "error" : "ready",
      detail: report.error
        ? `${report.error}${report.deadLetterCount ? ` ${report.deadLetterCount} operation${report.deadLetterCount === 1 ? "" : "s"} need attention.` : ""}`
        : report.deadLetterCount
          ? `${report.deadLetterCount} operation${report.deadLetterCount === 1 ? "" : "s"} need attention.`
          : "Account sync is up to date.",
      ...(report.error ? {} : { lastSyncedAt: new Date().toISOString() }),
    });
  }, [updateSyncState, user]);

  const getTransactionsForDay = useCallback(
    (dateKey: string) => repository.getTransactionsForDay(dateKey),
    [repository],
  );

  const reload = useCallback(async (monthKey = selectedMonth) => {
    const [summary, breakdown, previousBreakdown, transactions, review, budget, daily, categories] = await Promise.all([
      repository.monthSummary(monthKey),
      repository.categoryBreakdown(monthKey),
      repository.categoryBreakdown(previousAccountingMonthKey(monthKey)),
      repository.transactionsForMonth(monthKey),
      repository.needsReview(monthKey),
      repository.budgetsForMonth(monthKey),
      repository.dailyBuckets(monthKey),
      repository.categories(monthKey),
    ]);
    repository.monthsWithData().then(setAvailableMonths).catch(() => undefined);
    setLoaded(buildLoadedData(monthKey, syncStates, transactions, categories, breakdown, previousBreakdown, summary, review, budget, daily));
    setDataRevision((revision) => revision + 1);
  }, [repository, selectedMonth, syncStates]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await repository.ensureSystemCategories();
        if (!cancelled) await reload(selectedMonth);
      } catch (error) {
        if (!cancelled) Alert.alert("Spend database unavailable", error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [repository, reload, selectedMonth]);

  useEffect(() => {
    if (loading || !loaded) return;
    reload(selectedMonth).catch((error) => console.warn("Spend reload failed", error));
  }, [syncStates, loading, selectedMonth]); // sync status is provider-local but should be visible in the domain snapshot

  /**
   * The write is done by the time this is called — the coordinator has already
   * committed it. What follows is a re-read of the whole month: eight queries
   * plus the month list, rebuilt into a snapshot. Awaiting that before letting
   * the UI respond made every save and delete sit under a spinner for about a
   * second, for work the user is not waiting on.
   *
   * So the reload runs, but nobody blocks on it. Screens pick the new data up
   * through `dataRevision` a beat later, which is what that counter is for.
   */
  const refreshAfterWrite = useCallback(async () => {
    void reload(selectedMonth).catch((error) => console.warn("Spend reload failed", error));
    syncEngine.nudge();
  }, [reload, selectedMonth]);

  // Data pulled from the server has to reach the screen on its own. Without
  // this the rows landed in SQLite and sat there unseen until the app was
  // killed and reopened, which looks exactly like data loss.
  const lastSyncSeen = useRef<number | null>(null);
  useEffect(() => syncEngine.subscribe((state) => {
    setHydrating(state.running);
    if (state.lastSyncedAt && state.lastSyncedAt !== lastSyncSeen.current) {
      lastSyncSeen.current = state.lastSyncedAt;
      reload(selectedMonth).catch(() => undefined);
    }
  }), [reload, selectedMonth]);

  const assignReviewCategory = useCallback(async (transactionId: string, categoryLabel: string, opts?: { parentId?: SpendCategoryId }) => {
    const category = await repository.createCategory(categoryLabel, opts);
    await repository.assignCategory(transactionId, category.id);
    await refreshAfterWrite();
  }, [repository, refreshAfterWrite]);

  const assignCategory = useCallback(async (transactionId: string, categoryId: SpendCategoryId) => {
    await repository.assignCategory(transactionId, categoryId);
    await refreshAfterWrite();
  }, [repository, refreshAfterWrite]);

  const ignoreTransaction = useCallback(async (transactionId: string) => {
    await repository.ignoreTransaction(transactionId);
    await refreshAfterWrite();
  }, [repository, refreshAfterWrite]);

  const addManualTransaction = useCallback(async (input: Parameters<SpendContextType["actions"]["addManualTransaction"]>[0]) => {
    await repository.createTransaction({
      id: `manual:${cryptoUuid()}`,
      source: "manual",
      occurredAt: input.occurredAt,
      amountMinor: input.amountMinor,
      currencyCode: "INR",
      merchantName: input.merchantName,
      description: input.description ?? input.merchantName,
      channel: "unknown",
      direction: "debit",
      status: "posted",
      planType: input.planType ?? "planned",
      categoryLabel: input.categoryLabel,
      categoryParentId: input.categoryParentId,
    });
    await refreshAfterWrite();
  }, [repository, refreshAfterWrite]);

  const setTransactionPlanType = useCallback(async (transactionId: string, planType: SpendPlanType) => {
    await repository.setPlanType(transactionId, planType);
    await refreshAfterWrite();
  }, [repository, refreshAfterWrite]);

  const setPlanType = setTransactionPlanType;

  const setBudgetAmount = useCallback(async (monthKey: string, categoryId: SpendCategoryId, amountMinor: number, recurring?: boolean, expectedRevision?: number) => {
    const result = await repository.setBudgetAmount(monthKey, categoryId, amountMinor, recurring, expectedRevision);
    await refreshAfterWrite();
    return result;
  }, [repository, refreshAfterWrite]);

  const carryForwardBudget = useCallback(async (monthKey: string) => {
    const [source, destination] = await Promise.all([
      repository.budgetsForMonth(previousAccountingMonthKey(monthKey)),
      repository.budgetsForMonth(monthKey),
    ]);
    if (!source) return 0;
    const existing = new Set(Object.keys(destination?.categoryBudgets ?? {}));
    let copied = 0;
    for (const [categoryId, amountMinor] of Object.entries(source.categoryBudgets)) {
      if (!source.categoryRecurring?.[categoryId] || existing.has(categoryId)) continue;
      await repository.setBudgetAmount(monthKey, categoryId as SpendCategoryId, amountMinor, true);
      copied += 1;
    }
    if (copied > 0) await refreshAfterWrite();
    return copied;
  }, [repository, refreshAfterWrite]);

  const createCategory = useCallback(async (label: string, opts?: { parentId?: SpendCategoryId }) => {
    const category = await repository.createCategory(label, opts);
    await refreshAfterWrite();
    return { id: category.id, label: category.label, tint: category.tint, isCustom: !category.isSystem, parentId: category.parentId };
  }, [repository, refreshAfterWrite]);

  const renameCategory = useCallback(async (categoryId: SpendCategoryId, newLabel: string) => {
    await repository.renameCategory(categoryId, newLabel);
    await refreshAfterWrite();
  }, [repository, refreshAfterWrite]);

  const archiveCategory = useCallback(async (categoryId: SpendCategoryId) => {
    await repository.archiveCategory(categoryId);
    await refreshAfterWrite();
  }, [repository, refreshAfterWrite]);

  const setBudget = useCallback(async (monthKey: string, categoryBudgets: CategoryBudgetMap) => {
    await repository.setBudget(monthKey, categoryBudgets);
    await refreshAfterWrite();
  }, [repository, refreshAfterWrite]);

  const clearMonthBudget = useCallback(async (monthKey: string) => {
    await repository.clearMonthBudget(monthKey);
    await refreshAfterWrite();
  }, [repository, refreshAfterWrite]);

  const isRefreshingSms = useRef(false);
  const refreshSmsInboxToday = useCallback(async (detail: string) => {
    if (isRefreshingSms.current) return;
    isRefreshingSms.current = true;
    updateSyncState("sms", { status: "syncing", detail });
    try {
      const snapshot = await loadSmsIngestionSnapshot({ sinceMillis: startOfTodayMillis() });
      for (const transaction of convertSmsCandidatesToTransactions(snapshot.parsedCandidates)) {
        await repository.createTransaction(transaction);
      }
      // An ingest attempt reports what it INGESTED. Whether permission is
      // granted is the permission watcher's business — letting this path also
      // write "needs_permission" is what left the banner up after the user had
      // already said yes.
      if (snapshot.permission === "granted") {
        updateSyncState("sms", {
          status: "ready",
          detail: snapshot.parsedCandidates.length ? `Today: ${snapshot.parsedCandidates.length} SMS transactions.` : "No transaction SMS found for today yet.",
          lastSyncedAt: new Date(Date.now()).toISOString(),
        });
      }
      await refreshAfterWrite();
    } catch (error) {
      updateSyncState("sms", { status: "error", detail: error instanceof Error ? error.message : "SMS sync failed." });
    } finally {
      isRefreshingSms.current = false;
    }
  }, [repository, refreshAfterWrite, updateSyncState]);

  const refreshSmsInbox = useCallback(() => refreshSmsInboxToday("Scanning today's SMS for transaction alerts."), [refreshSmsInboxToday]);
  const grantSmsAccess = useCallback(async () => {
    const permission = await requestSmsReadPermission();
    updateSyncState("sms", { status: permission === "granted" ? "ready" : "needs_permission", detail: permission === "granted" ? "SMS access granted." : "SMS access is still required." });
    if (permission === "granted") await refreshSmsInbox();
  }, [refreshSmsInbox, updateSyncState]);

  /**
   * The permission banner follows the ACTUAL permission, re-checked whenever
   * the app comes forward.
   *
   * It used to be written only as a side effect of an ingest attempt, so a
   * check that ran while the system dialog was still on screen recorded
   * "denied" — and nothing ever looked again. The user granted access and the
   * banner kept asking for it.
   */
  useEffect(() => {
    if (loading) return;
    let cancelled = false;
    const syncPermissionState = async () => {
      const permission = await getSmsPermissionState();
      if (cancelled) return;
      if (permission === "unavailable") return;
      updateSyncState("sms", {
        status: permission === "granted" ? "ready" : "needs_permission",
        ...(permission === "granted" ? {} : { detail: "SMS access is required to capture bank alerts." }),
      });
    };
    void syncPermissionState();
    const subscription = AppState.addEventListener("change", (state: AppStateStatus) => {
      if (state === "active") void syncPermissionState();
    });
    return () => { cancelled = true; subscription.remove(); };
  }, [loading, updateSyncState]);

  useEffect(() => {
    if (loading) return;
    getSmsPermissionState().then((permission) => {
      if (permission === "granted") refreshSmsInboxToday("Scanning today's SMS for transaction alerts.").catch(() => undefined);
    });
    const smsSubscription = DeviceEventEmitter.addListener("spendSmsTransactionReceived", () => refreshSmsInboxToday("New SMS received. Updating today's spend.").catch(() => undefined));
    const appStateSubscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        refreshSmsInboxToday("Refreshing today's SMS.").catch(() => undefined);
        consumePendingSmsRefreshFlag().catch(() => undefined);
      }
    });
    return () => { smsSubscription.remove(); appStateSubscription.remove(); };
  }, [loading, refreshSmsInboxToday]);

  useEffect(() => {
    if (!user) return;
    syncAccount().catch((error) => updateSyncState("gmail", {
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    }));
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") syncAccount().catch(() => undefined);
    });
    return () => subscription.remove();
  }, [syncAccount, updateSyncState, user]);

  const value = useMemo((): SpendContextType => {
    const data = loaded ?? buildLoadedData(selectedMonth, syncStates, [], [], [], [], { totalSpentMinor: 0, budgetTotalMinor: 0, daysRemaining: 0, transactionCount: 0, reviewCount: 0 }, [], null, []);
    return {
      repository,
      domain: data.domain,
      summary: data.summary,
      categories: data.categories,
      categoryOptions: data.categoryOptions,
      sourceStatuses: [],
      reviewPreview: data.reviewPreview,
      reviewItems: data.reviewItems,
      recentPreview: [],
      widgetSnapshot: data.widgetSnapshot,
      currentMonthBudget: data.currentMonthBudget,
      selectedMonth,
      setSelectedMonth,
      availableMonths,
      dailyBuckets: data.dailyBuckets,
      getTransactionsForDay,
      dataRevision,
      // Switching months re-reads everything, and until it lands the screen is
      // showing the PREVIOUS month's numbers under the new month's name. That
      // is the moment a skeleton is actually for.
      hydrating: hydrating || !loaded || loaded.monthKey !== selectedMonth,
      actions: {
        grantSmsAccess,
        refreshSmsInbox,
        connectGmailInbox: async () => {},
        refreshGmailInbox: async () => {},
        assignReviewCategory,
        assignCategory,
        ignoreTransaction,
        addManualTransaction,
        setTransactionPlanType,
        setPlanType,
        setBudgetAmount,
        carryForwardBudget,
        createCategory,
        renameCategory,
        archiveCategory,
        setBudget,
        clearMonthBudget,
      },
    };
  }, [loaded, dataRevision, hydrating, repository, selectedMonth, syncStates, grantSmsAccess, refreshSmsInbox, assignReviewCategory, assignCategory, ignoreTransaction, addManualTransaction, setTransactionPlanType, setPlanType, setBudgetAmount, carryForwardBudget, createCategory, renameCategory, archiveCategory, setBudget, clearMonthBudget]);

  useEffect(() => {
    if (!loading) pushWidgetSnapshot(value.widgetSnapshot);
  }, [loading, value.widgetSnapshot]);

  if (loading) return <View style={{ flex: 1, backgroundColor: "#070709", alignItems: "center", justifyContent: "center" }}><ActivityIndicator color="#FFD27A" /></View>;
  return <SpendContext.Provider value={value}>{children}</SpendContext.Provider>;
}

function cryptoUuid(): string {
  const randomUuid = (globalThis.crypto as Crypto | undefined)?.randomUUID;
  if (randomUuid) return randomUuid.call(globalThis.crypto);
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    return (character === "x" ? random : (random & 0x3) | 0x8).toString(16);
  });
}

export function useSpend(): SpendContextType {
  const context = useContext(SpendContext);
  if (!context) throw new Error("useSpend must be used within SpendProvider");
  return context;
}
