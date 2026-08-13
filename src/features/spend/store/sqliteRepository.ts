import type { Command, CommandResult } from "../../../db/commands";
import type { DatabaseCoordinator } from "../../../db/coordinator";
import type {
  CategoryBudgetMap,
  MonthlyBudget,
  SpendCategoryDefinition,
  SpendCategoryId,
  SpendDailyBucket,
  SpendDataRepository,
  BudgetWriteResult,
  SpendPlanType,
  SpendSeedTransactionInput,
  SpendTransaction,
} from "../types/types";

export const ACCOUNTING_TIME_ZONE = "Asia/Kolkata";

type SqlRow = Record<string, unknown>;

const numberValue = (value: unknown): number =>
  typeof value === "number" ? value : Number(value ?? 0);

const stringValue = (value: unknown): string => String(value ?? "");

export function currentAccountingDateKey(epochMillis = Date.now()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ACCOUNTING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(epochMillis));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function accountingMonthKey(epochMillis = Date.now()): string {
  return currentAccountingDateKey(epochMillis).slice(0, 7);
}

export function monthLabel(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: ACCOUNTING_TIME_ZONE,
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

function daysInMonth(monthKey: string): number {
  const [year, month] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function daysRemaining(monthKey: string, epochMillis = Date.now()): number {
  const today = currentAccountingDateKey(epochMillis);
  const currentMonth = today.slice(0, 7);
  if (monthKey < currentMonth) return 0;
  if (monthKey > currentMonth) return daysInMonth(monthKey);
  return Math.max(daysInMonth(monthKey) - Number(today.slice(8, 10)), 0);
}

function uuid(): string {
  const randomUuid = (globalThis.crypto as Crypto | undefined)?.randomUUID;
  if (randomUuid) return randomUuid.call(globalThis.crypto);
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const value = character === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

function formatCurrency(amountMinor: number): string {
  const amount = amountMinor / 100;
  return `Rs${Number.isInteger(amount) ? amount.toFixed(0) : amount.toFixed(2)}`;
}

function transactionSource(id: string): "sms" | "gmail" | "manual" {
  if (id.startsWith("sms:")) return "sms";
  if (id.startsWith("gmail:")) return "gmail";
  return "manual";
}

function mapTransaction(row: SqlRow): SpendTransaction {
  const categoryId = row.category_id == null ? undefined : stringValue(row.category_id) as SpendCategoryId;
  const allocationSource = row.allocation_source == null ? "uncategorized" : stringValue(row.allocation_source);
  const direction = stringValue(row.direction);
  const status = stringValue(row.status);
  return {
    id: stringValue(row.id),
    source: transactionSource(stringValue(row.id)),
    sourceMessageId: row.provider_message_id == null ? undefined : stringValue(row.provider_message_id),
    occurredAt: new Date(numberValue(row.occurred_at)).toISOString(),
    amountMinor: numberValue(row.amount_minor),
    currencyCode: stringValue(row.currency_code),
    merchantName: stringValue(row.merchant_raw) || "Unknown payee",
    normalizedMerchantName: stringValue(row.counterparty_key || row.merchant_raw).toLowerCase(),
    counterpartyKey: row.counterparty_key == null ? undefined : stringValue(row.counterparty_key),
    description: stringValue(row.raw_body || row.merchant_raw),
    channel: (stringValue(row.channel) || "unknown") as SpendTransaction["channel"],
    direction: direction === "debit" ? "debit" : direction === "transfer" ? "credit" : "credit",
    status: status === "ignored" ? "ignored" : status === "pending" ? "pending" : "posted",
    categoryId,
    categoryLabel: row.category_label == null ? undefined : stringValue(row.category_label),
    categorySource: allocationSource === "manual" ? "manual" : allocationSource === "learned" ? "learned_rule" : allocationSource === "uncategorized" ? "uncategorized" : "merchant_rule",
    needsReview: categoryId == null && direction === "debit" && status !== "ignored",
    planType: stringValue(row.plan_type) === "unplanned" ? "unplanned" : "planned",
  };
}

function mapCategory(row: SqlRow): SpendCategoryDefinition {
  const id = stringValue(row.id) as SpendCategoryId;
  return {
    id,
    label: stringValue(row.label),
    tint: stringValue(row.tint) || "#9C8B5C",
    isSystem: numberValue(row.is_system) === 1,
    isReviewCategory: id === "needs-review",
    parentId: row.parent_id == null ? undefined : stringValue(row.parent_id) as SpendCategoryId,
  };
}

export class SpendConflictError extends Error {
  readonly code = "CONFLICT" as const;
  readonly entityId: string;
  readonly expectedRevision: number;
  readonly currentRevision: number;
  constructor(
    entityId: string,
    expectedRevision: number,
    currentRevision: number,
  ) {
    super(`The ${entityId} changed while you were editing it. Please review the latest value and try again.`);
    this.name = "SpendConflictError";
    this.entityId = entityId;
    this.expectedRevision = expectedRevision;
    this.currentRevision = currentRevision;
  }
}

function loadDefaultCoordinator(): DatabaseCoordinator {
  // Lazy-load so this module has no runtime import of react-native.
  const loaded = require("../../../db/nativeCoordinator") as {
    nativeCoordinator: DatabaseCoordinator;
  };
  return loaded.nativeCoordinator;
}

function isConflictError(
  error: unknown,
): error is {entityId: string; expectedRevision: number} {
  return error instanceof Error && error.name === "ConflictError" && "entityId" in error && "expectedRevision" in error;
}

export class SqliteSpendRepository implements SpendDataRepository {
  #coordinator: DatabaseCoordinator | undefined;

  constructor(coordinator?: DatabaseCoordinator) {
    this.#coordinator = coordinator;
  }

  private get coordinator(): DatabaseCoordinator {
    this.#coordinator ??= loadDefaultCoordinator();
    return this.#coordinator;
  }

  /**
   * Months the user actually has something in — any transaction or any budget —
   * plus the current month, newest first. Derived from the database rather than
   * generated, so the picker never offers an empty month the user never used,
   * and never hides one they did.
   */
  async monthsWithData(): Promise<string[]> {
    const rows = await this.coordinator.query<SqlRow>(
      `SELECT month_key FROM (
         SELECT DISTINCT accounting_month_key AS month_key
           FROM transactions
          WHERE deleted_at IS NULL AND status <> 'ignored'
         UNION
         SELECT DISTINCT month_key FROM budgets
       )
       WHERE month_key IS NOT NULL AND month_key <= ?
       ORDER BY month_key DESC`,
      [accountingMonthKey()],
    );
    const months = rows
      .map((row) => String(row.month_key))
      .filter((month) => /^\d{4}-\d{2}$/.test(month));
    const current = accountingMonthKey();
    return months.includes(current) ? months : [current, ...months];
  }

  async monthSummary(monthKey: string) {
    const [row] = await this.coordinator.query<SqlRow>(
      `SELECT
         COALESCE((SELECT SUM(t.amount_minor) FROM transactions t
           WHERE t.accounting_month_key = ? AND t.direction = 'debit'
             AND t.plan_type = 'planned' AND t.status NOT IN ('ignored') AND t.deleted_at IS NULL), 0) AS total_spent_minor,
         COALESCE((SELECT SUM(b.amount_minor) FROM budgets b WHERE b.month_key = ?), 0) AS budget_total_minor,
         (SELECT COUNT(*) FROM transactions t
           WHERE t.accounting_month_key = ? AND t.direction = 'debit'
             AND t.status NOT IN ('ignored') AND t.deleted_at IS NULL) AS transaction_count,
         (SELECT COUNT(*) FROM transactions t
           LEFT JOIN transaction_allocations a ON a.id = (
             SELECT MIN(a2.id) FROM transaction_allocations a2 WHERE a2.transaction_id = t.id)
           WHERE t.accounting_month_key = ? AND t.direction = 'debit'
             AND t.status NOT IN ('ignored') AND t.deleted_at IS NULL
             AND a.category_id IS NULL) AS review_count`,
      [monthKey, monthKey, monthKey, monthKey],
    );
    return {
      totalSpentMinor: numberValue(row?.total_spent_minor),
      budgetTotalMinor: numberValue(row?.budget_total_minor),
      daysRemaining: daysRemaining(monthKey),
      transactionCount: numberValue(row?.transaction_count),
      reviewCount: numberValue(row?.review_count),
    };
  }

  async categoryBreakdown(monthKey: string) {
    const rows = await this.coordinator.query<SqlRow>(
      `WITH spent AS (
         SELECT a.category_id, SUM(a.amount_minor) AS spent_minor
         FROM transaction_allocations a
         JOIN transactions t ON t.id = a.transaction_id
         WHERE t.accounting_month_key = ? AND a.category_id IS NOT NULL
           AND t.plan_type = 'planned' AND t.status NOT IN ('ignored') AND t.deleted_at IS NULL
         GROUP BY a.category_id
       )
       SELECT c.id, c.label, c.tint, c.parent_id,
              COALESCE(s.spent_minor, 0) AS spent_minor,
              COALESCE(b.amount_minor, 0) AS budgeted_minor,
              COALESCE(b.recurring, 0) AS recurring
       FROM categories c
       LEFT JOIN spent s ON s.category_id = c.id
       LEFT JOIN budgets b ON b.category_id = c.id AND b.month_key = ?
       WHERE c.deleted_at IS NULL
       ORDER BY (budgeted_minor > 0) DESC, spent_minor DESC, lower(c.label)`,
      [monthKey, monthKey],
    );
    return rows.map((row) => ({
      categoryId: stringValue(row.id) as SpendCategoryId,
      label: stringValue(row.label),
      tint: stringValue(row.tint) || "#9C8B5C",
      parentId: row.parent_id == null ? undefined : stringValue(row.parent_id) as SpendCategoryId,
      spentMinor: numberValue(row.spent_minor),
      budgetedMinor: numberValue(row.budgeted_minor),
      recurring: numberValue(row.recurring) === 1,
    }));
  }

  async dailyBuckets(monthKey: string): Promise<SpendDailyBucket[]> {
    const rows = await this.coordinator.query<SqlRow>(
      `SELECT strftime('%Y-%m-%d', t.occurred_at / 1000, 'unixepoch', '+5 hours', '+30 minutes') AS date_key,
              SUM(CASE WHEN t.plan_type = 'planned' THEN t.amount_minor ELSE 0 END) AS amount_minor,
              COUNT(*) AS transaction_count
       FROM transactions t
       WHERE t.accounting_month_key = ? AND t.direction = 'debit'
         AND t.status NOT IN ('ignored') AND t.deleted_at IS NULL
       GROUP BY date_key ORDER BY date_key`,
      [monthKey],
    );
    const today = currentAccountingDateKey();
    const byDate = new Map(
      rows.map((row) => [
        stringValue(row.date_key),
        { amountMinor: numberValue(row.amount_minor), transactionCount: numberValue(row.transaction_count) },
      ]),
    );

    // Emit EVERY day of the month, not only days that already have spending.
    // A day with no transactions still needs to exist so it can be selected and
    // a past-dated entry added to it — grouping over existing rows alone made
    // the first week of a month unreachable.
    const [year, month] = monthKey.split("-").map(Number);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const lastDay = monthKey === today.slice(0, 7) ? Number(today.slice(8, 10)) : daysInMonth;

    const buckets: SpendDailyBucket[] = [];
    for (let day = 1; day <= lastDay; day += 1) {
      const date = `${monthKey}-${String(day).padStart(2, "0")}`;
      const dateObject = new Date(`${date}T00:00:00+05:30`);
      const totals = byDate.get(date);
      buckets.push({
        date,
        dayLabel: String(day),
        weekdayLabel: new Intl.DateTimeFormat("en-IN", { weekday: "short", timeZone: ACCOUNTING_TIME_ZONE }).format(dateObject).charAt(0),
        fullLabel: new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: ACCOUNTING_TIME_ZONE }).format(dateObject),
        amountMinor: totals?.amountMinor ?? 0,
        transactionCount: totals?.transactionCount ?? 0,
        isToday: date === today,
      });
    }
    return buckets;
  }

  async transactionsForDay(dateKey: string): Promise<SpendTransaction[]> {
    const monthKey = dateKey.slice(0, 7);
    const rows = await this.coordinator.query<SqlRow>(
      `SELECT t.*, a.category_id, a.source AS allocation_source,
              c.label AS category_label, sa.provider_message_id, sa.raw_body
       FROM transactions t
       LEFT JOIN transaction_allocations a ON a.id = (
         SELECT MIN(a2.id) FROM transaction_allocations a2 WHERE a2.transaction_id = t.id)
       LEFT JOIN categories c ON c.id = a.category_id
       LEFT JOIN source_alerts sa ON sa.transaction_id = t.id
       WHERE t.accounting_month_key = ?
         AND strftime('%Y-%m-%d', t.occurred_at / 1000, 'unixepoch', '+5 hours', '+30 minutes') = ?
         AND t.direction = 'debit' AND t.status NOT IN ('ignored') AND t.deleted_at IS NULL
       ORDER BY t.occurred_at DESC`,
      [monthKey, dateKey],
    );
    return rows.map(mapTransaction);
  }

  async budgetsForMonth(monthKey: string): Promise<MonthlyBudget | null> {
    const rows = await this.coordinator.query<SqlRow>(
      `SELECT b.category_id, b.amount_minor, b.recurring,
              b.updated_at, SUM(b.amount_minor) OVER () AS total_minor
       FROM budgets b WHERE b.month_key = ? ORDER BY b.category_id`,
      [monthKey],
    );
    if (!rows.length) return null;
    const categoryBudgets: CategoryBudgetMap = {};
    const categoryRecurring: Record<string, boolean> = {};
    rows.forEach((row) => {
      const categoryId = stringValue(row.category_id);
      categoryBudgets[categoryId] = numberValue(row.amount_minor);
      categoryRecurring[categoryId] = numberValue(row.recurring) === 1;
    });
    return {
      monthKey,
      amountMinor: numberValue(rows[0].total_minor),
      categoryBudgets,
      categoryRecurring,
      setAt: new Date(numberValue(rows[rows.length - 1].updated_at)).toISOString(),
    };
  }

  async needsReview(monthKey: string): Promise<SpendTransaction[]> {
    const rows = await this.coordinator.query<SqlRow>(
      `SELECT t.*, a.category_id, a.source AS allocation_source,
              c.label AS category_label, sa.provider_message_id, sa.raw_body
       FROM transactions t
       LEFT JOIN transaction_allocations a ON a.id = (
         SELECT MIN(a2.id) FROM transaction_allocations a2 WHERE a2.transaction_id = t.id)
       LEFT JOIN categories c ON c.id = a.category_id
       LEFT JOIN source_alerts sa ON sa.transaction_id = t.id
       WHERE t.accounting_month_key = ? AND t.direction = 'debit'
         AND t.status NOT IN ('ignored') AND t.deleted_at IS NULL
         AND a.category_id IS NULL
       ORDER BY t.occurred_at DESC`,
      [monthKey],
    );
    return rows.map(mapTransaction);
  }

  async transactionsForMonth(monthKey: string): Promise<SpendTransaction[]> {
    const rows = await this.coordinator.query<SqlRow>(
      `SELECT t.*, a.category_id, a.source AS allocation_source,
              c.label AS category_label, sa.provider_message_id, sa.raw_body
       FROM transactions t
       LEFT JOIN transaction_allocations a ON a.id = (
         SELECT MIN(a2.id) FROM transaction_allocations a2 WHERE a2.transaction_id = t.id)
       LEFT JOIN categories c ON c.id = a.category_id
       LEFT JOIN source_alerts sa ON sa.transaction_id = t.id
       WHERE t.accounting_month_key = ? AND t.deleted_at IS NULL
       ORDER BY t.occurred_at DESC`,
      [monthKey],
    );
    return rows.map(mapTransaction);
  }

  async categories(monthKey: string): Promise<SpendCategoryDefinition[]> {
    const rows = await this.coordinator.query<SqlRow>(
      `SELECT id, label, tint, parent_id, is_system
       FROM categories WHERE deleted_at IS NULL AND ? IS NOT NULL
       ORDER BY lower(label)`,
      [monthKey],
    );
    return rows.map(mapCategory);
  }

  async getTransactionsForDay(dateKey: string) {
    return this.transactionsForDay(dateKey);
  }

  async createTransaction(input: SpendSeedTransactionInput): Promise<void> {
    const occurredAt = new Date(input.occurredAt).getTime();
    const monthKey = accountingMonthKey(occurredAt);
    const [existing] = await this.coordinator.query<SqlRow>(
      `SELECT t.id
         FROM transactions t
         LEFT JOIN source_alerts sa ON sa.transaction_id = t.id
        WHERE t.deleted_at IS NULL AND t.status <> 'ignored'
          AND (
            (t.id = ? AND t.accounting_month_key = ?)
            OR (
              ? = 'sms' AND sa.raw_body = ? AND t.amount_minor = ?
              AND t.direction = 'debit' AND ABS(t.received_at - ?) <= 300000
            )
          )
        LIMIT 1`,
      [input.id, monthKey, input.source, input.description, input.amountMinor, occurredAt],
    );
    if (existing) return;

    let categoryId: string | null = null;
    let allocationSource: "manual" | "rule" = "rule";
    if (input.categoryLabel?.trim()) {
      const category = await this.createCategory(input.categoryLabel, input.categoryParentId ? { parentId: input.categoryParentId } : undefined);
      categoryId = category.id;
      allocationSource = "manual";
    }
    const receivedAt = Date.now();
    const command: Command = {
      commandId: uuid(),
      kind: "createTransactionFromAlert",
      payload: {
        alert: {
          id: `${input.source}:alert:${input.id}`,
          rawBody: input.description,
          receivedAt,
          providerMessageId: input.sourceMessageId ?? input.externalFingerprint ?? input.id,
          parseStatus: "parsed",
        },
        transaction: {
          id: input.id,
          occurredAt,
          receivedAt,
          accountingMonthKey: monthKey,
          amountMinor: input.amountMinor,
          direction: input.direction === "debit" ? "debit" : input.direction === "credit" ? "credit" : "credit",
          currencyCode: input.currencyCode,
          merchantRaw: input.merchantName,
          counterpartyKey: input.counterpartyKey ?? input.merchantName,
          channel: input.channel,
          status: input.status === "ignored" ? "ignored" : input.status === "pending" ? "pending" : "posted",
          planType: input.planType ?? "planned",
        },
        allocation: {
          categoryId,
          source: allocationSource,
        },
      },
    };
    await this.coordinator.execute(command);
  }

  async reconcileDuplicateSmsTransactions(): Promise<number> {
    const duplicates = await this.coordinator.query<SqlRow>(
      `SELECT js.id
         FROM transactions js
         JOIN transaction_allocations jsa_alloc ON jsa_alloc.transaction_id = js.id
         JOIN source_alerts jsa ON jsa.transaction_id = js.id
        WHERE js.id LIKE 'sms:%'
          AND js.deleted_at IS NULL AND js.status <> 'ignored'
          AND jsa_alloc.category_id IS NULL
          AND EXISTS (
            SELECT 1
              FROM transactions native
              JOIN source_alerts native_alert ON native_alert.transaction_id = native.id
             WHERE native.id <> js.id
               AND native.deleted_at IS NULL AND native.status <> 'ignored'
               AND native_alert.provider_message_id LIKE 'sms:%'
               AND native_alert.raw_body = jsa.raw_body
               AND native.amount_minor = js.amount_minor
               AND ABS(native.received_at - js.occurred_at) <= 300000
          )`,
    );
    for (const row of duplicates) {
      await this.ignoreTransaction(stringValue(row.id));
    }
    return duplicates.length;
  }

  async assignCategory(transactionId: string, categoryId: SpendCategoryId): Promise<void> {
    const revision = await this.transactionRevision(transactionId);
    await this.executeWithConflict({
      commandId: uuid(), kind: "assignCategory", expectedRevision: revision,
      payload: { transactionId, categoryId, source: "manual", allocationId: `${transactionId}:allocation` },
    }, () => this.transactionRevision(transactionId));
  }

  async splitTransaction(
    transactionId: string,
    allocations: Array<{categoryId: SpendCategoryId; amountMinor: number}>,
  ): Promise<void> {
    const revision = await this.transactionRevision(transactionId);
    await this.executeWithConflict({
      commandId: uuid(),
      kind: "splitTransaction",
      expectedRevision: revision,
      payload: {
        transactionId,
        allocations: allocations.map((allocation, index) => ({
          ...allocation,
          allocationId: `${transactionId}:split:${index}`,
        })),
      },
    }, () => this.transactionRevision(transactionId));
  }

  async ignoreTransaction(transactionId: string): Promise<void> {
    const revision = await this.transactionRevision(transactionId);
    await this.executeWithConflict({ commandId: uuid(), kind: "ignoreTransaction", expectedRevision: revision, payload: { transactionId } }, () => this.transactionRevision(transactionId));
  }

  async setPlanType(transactionId: string, planType: SpendPlanType): Promise<void> {
    const revision = await this.transactionRevision(transactionId);
    await this.executeWithConflict({ commandId: uuid(), kind: "setPlanType", expectedRevision: revision, payload: { transactionId, planType } }, () => this.transactionRevision(transactionId));
  }

  async setBudgetAmount(monthKey: string, categoryId: SpendCategoryId, amountMinor: number, recurring = false, expectedRevision?: number): Promise<BudgetWriteResult> {
    const revision = expectedRevision ?? await this.monthRevision(monthKey);
    const result = await this.executeWithConflict({ commandId: uuid(), kind: "setBudgetAmount", expectedRevision: revision, payload: { monthKey, categoryId, amountMinor, recurring } }, () => this.monthRevision(monthKey));
    return { revision: result.revision };
  }

  async budgetRevision(monthKey: string): Promise<number> {
    return this.monthRevision(monthKey);
  }

  async clearMonthBudget(monthKey: string): Promise<void> {
    const revision = await this.monthRevision(monthKey);
    await this.executeWithConflict({ commandId: uuid(), kind: "clearMonthBudget", expectedRevision: revision, payload: { monthKey } }, () => this.monthRevision(monthKey));
  }

  async createCategory(label: string, opts?: { parentId?: SpendCategoryId }): Promise<SpendCategoryDefinition> {
    const trimmed = label.trim();
    if (!trimmed) throw new Error("Category label is required.");
    const [existing] = await this.coordinator.query<SqlRow>(
      "SELECT id, label, tint, parent_id, is_system FROM categories WHERE lower(label) = lower(?) AND deleted_at IS NULL AND ? IS NOT NULL",
      [trimmed, accountingMonthKey()],
    );
    if (existing) return mapCategory(existing);
    const [countRow] = await this.coordinator.query<SqlRow>(
      "SELECT COUNT(*) AS count FROM categories WHERE is_system = 0 AND deleted_at IS NULL AND ? IS NOT NULL",
      [accountingMonthKey()],
    );
    const palette = ["rgba(121, 214, 255, 0.88)", "rgba(160, 255, 180, 0.88)", "rgba(255, 179, 102, 0.88)", "rgba(255, 134, 180, 0.88)", "rgba(196, 167, 255, 0.88)"];
    const categoryId = `custom:${uuid()}` as SpendCategoryId;
    const command: Command = {
      commandId: uuid(), kind: "createCategory",
      payload: { categoryId, label: trimmed, tint: palette[numberValue(countRow?.count) % palette.length], parentId: opts?.parentId ?? null, isSystem: false },
    };
    await this.coordinator.execute(command);
    const [created] = await this.coordinator.query<SqlRow>(
      "SELECT id, label, tint, parent_id, is_system FROM categories WHERE id = ? AND ? IS NOT NULL",
      [categoryId, accountingMonthKey()],
    );
    if (!created) throw new Error(`Category was not created: ${trimmed}`);
    return mapCategory(created);
  }

  async renameCategory(categoryId: SpendCategoryId, newLabel: string): Promise<void> {
    const trimmed = newLabel.trim();
    if (!trimmed) throw new Error("Category label is required.");
    const revision = await this.categoryRevision(categoryId);
    await this.executeWithConflict({ commandId: uuid(), kind: "renameCategory", expectedRevision: revision, payload: { categoryId, label: trimmed } }, () => this.categoryRevision(categoryId));
  }

  async archiveCategory(categoryId: SpendCategoryId): Promise<void> {
    const revision = await this.categoryRevision(categoryId);
    await this.executeWithConflict({ commandId: uuid(), kind: "archiveCategory", expectedRevision: revision, payload: { categoryId } }, () => this.categoryRevision(categoryId));
  }

  async setBudget(monthKey: string, categoryBudgets: CategoryBudgetMap): Promise<void> {
    await this.clearMonthBudget(monthKey);
    for (const [categoryId, amountMinor] of Object.entries(categoryBudgets)) {
      if (amountMinor > 0) await this.setBudgetAmount(monthKey, categoryId as SpendCategoryId, Math.round(amountMinor));
    }
  }

  async ensureSystemCategories(): Promise<void> {
    const { SPEND_CATEGORY_DEFINITIONS } = require("../categories/categorySeeds") as typeof import("../categories/categorySeeds");
    const monthKey = accountingMonthKey();
    const existing = new Set((await this.categories(monthKey)).map((category) => category.id));
    for (const category of SPEND_CATEGORY_DEFINITIONS) {
      if (existing.has(category.id)) continue;
      await this.coordinator.execute({
        commandId: uuid(), kind: "createCategory",
        payload: { categoryId: category.id, label: category.label, tint: category.tint, isSystem: true },
      });
    }
  }

  private async transactionRevision(transactionId: string): Promise<number> {
    const [row] = await this.coordinator.query<SqlRow>(
      "SELECT revision, accounting_month_key FROM transactions WHERE id = ? AND ? IS NOT NULL",
      [transactionId, accountingMonthKey()],
    );
    if (!row) throw new Error(`Transaction not found: ${transactionId}`);
    return numberValue(row.revision);
  }

  private async monthRevision(monthKey: string): Promise<number> {
    const [row] = await this.coordinator.query<SqlRow>(
      "SELECT revision FROM budget_month_revisions WHERE month_key = ?",
      [monthKey],
    );
    return numberValue(row?.revision);
  }

  private async categoryRevision(categoryId: SpendCategoryId): Promise<number> {
    const [row] = await this.coordinator.query<SqlRow>(
      "SELECT revision FROM categories WHERE id = ? AND ? IS NOT NULL",
      [categoryId, accountingMonthKey()],
    );
    if (!row) throw new Error(`Category not found: ${categoryId}`);
    return numberValue(row.revision);
  }

  private async executeWithConflict(command: Command, reread: () => Promise<number>): Promise<CommandResult> {
    try {
      return await this.coordinator.execute(command);
    } catch (error) {
      if (!isConflictError(error)) throw error;
      const currentRevision = await reread();
      throw new SpendConflictError(error.entityId, error.expectedRevision, currentRevision);
    }
  }
}

export const sqliteRepository = new SqliteSpendRepository();

export function spendMonthLabel(monthKey: string): string {
  return monthLabel(monthKey);
}

export function previousAccountingMonthKey(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function nextAccountingMonthKey(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function spendCurrency(amountMinor: number): string {
  return formatCurrency(amountMinor);
}
