import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { constants as sqliteConstants, DatabaseSync } from "node:sqlite";
import { fileURLToPath, URL } from "node:url";

import type {
  AcceptSuggestionCommand,
  AllocationSource,
  ArchiveCategoryCommand,
  AssignCategoryCommand,
  ClearMonthBudgetCommand,
  Command,
  CommandKind,
  CommandResult,
  CreateCategoryCommand,
  CreateTransactionFromAlertCommand,
  IgnoreTransactionCommand,
  LinkRefundCommand,
  RecordSuggestionCommand,
  RenameCategoryCommand,
  ResolvePossibleMatchCommand,
  SetBudgetAmountCommand,
  SetPlanTypeCommand,
} from "./commands.ts";

export type { Command, CommandResult } from "./commands.ts";

export interface DatabaseCoordinator {
  execute(cmd: Command): Promise<CommandResult>;
  /** Read-only SQL. Reads intentionally do not wait behind the write queue. */
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

export class ConflictError extends Error {
  readonly entityId: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(entityId: string, expectedRevision: number, actualRevision: number) {
    super(
      `Revision conflict for ${entityId}: expected ${expectedRevision}, found ${actualRevision}`,
    );
    this.name = "ConflictError";
    this.entityId = entityId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class AllocationInvariantError extends Error {
  readonly transactionId: string;
  readonly transactionAmountMinor: number;
  readonly allocationAmountMinor: number;

  constructor(
    transactionId: string,
    transactionAmountMinor: number,
    allocationAmountMinor: number,
  ) {
    super(
      `Allocations for ${transactionId} total ${allocationAmountMinor}, expected ${transactionAmountMinor}`,
    );
    this.name = "AllocationInvariantError";
    this.transactionId = transactionId;
    this.transactionAmountMinor = transactionAmountMinor;
    this.allocationAmountMinor = allocationAmountMinor;
  }
}

export class RowNotFoundError extends Error {
  readonly entityId: string;

  constructor(entityId: string) {
    super(`Row not found: ${entityId}`);
    this.name = "RowNotFoundError";
    this.entityId = entityId;
  }
}

type SqlValue = null | number | string | bigint | Uint8Array;

interface RevisionRow {
  revision: number;
}

interface TransactionRow extends RevisionRow {
  id: string;
  amount_minor: number;
  counterparty_key: string | null;
}

interface SuggestionRow extends RevisionRow {
  id: string;
  transaction_id: string;
  category_id: string;
  transaction_revision: number;
  accepted_at: number | null;
}

interface PossibleMatchRow extends RevisionRow {
  id: string;
  resolved: number;
}

interface ProcessedCommandRow {
  result_json: string;
}

const MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL("../../db/migrations/", import.meta.url),
);

// Factories for the same file share a queue too. This prevents accidentally
// constructing two JS coordinators from reintroducing two in-process writers.
const WRITE_TAILS_BY_DATABASE = new Map<string, Promise<void>>();

function applyMigrations(db: DatabaseSync): void {
  const migrations = readdirSync(MIGRATIONS_DIRECTORY)
    .map((name) => {
      const match = /^(\d{3})_.+\.sql$/.exec(name);
      return match ? { name, version: Number(match[1]) } : null;
    })
    .filter((entry): entry is { name: string; version: number } => entry !== null)
    .sort((left, right) => left.version - right.version);

  if (migrations.length === 0) {
    throw new Error("No database migrations were found");
  }

  migrations.forEach((migration, index) => {
    const expected = index + 1;
    if (migration.version !== expected) {
      throw new Error(
        `Migration chain is not replayable: expected version ${expected}, found ${migration.version}`,
      );
    }
  });

  const newestVersion = migrations[migrations.length - 1].version;
  const versionRow = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  let currentVersion = versionRow.user_version;

  if (currentVersion > newestVersion) {
    throw new Error(
      `Database user_version ${currentVersion} is newer than supported version ${newestVersion}`,
    );
  }

  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue;
    if (migration.version !== currentVersion + 1) {
      throw new Error(
        `Cannot migrate database from ${currentVersion} to ${migration.version}; migrations must be N->N+1`,
      );
    }

    const sql = readFileSync(`${MIGRATIONS_DIRECTORY}/${migration.name}`, "utf8");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      // user_version is committed atomically with the schema change. This is
      // essential when an APK jumps across more than one released version.
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
      currentVersion = migration.version;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  ensureSyncSchema(db);
}

function ensureSyncSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS sync_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
  const columns = db.prepare("PRAGMA table_info(outbox)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "next_attempt_at")) {
    db.exec("ALTER TABLE outbox ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0");
  }
  db.exec(`CREATE INDEX IF NOT EXISTS outbox_ready_created_at_idx
    ON outbox (dead_lettered, next_attempt_at, created_at)`);
}

function configureConnection(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL");
  // op-sqlite does not enable foreign keys by default. Every implementation of
  // this contract must enable them explicitly on every connection it opens.
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
}

function assertExpectedRevision(
  entityId: string,
  expectedRevision: number,
  actualRevision: number,
): void {
  if (expectedRevision !== actualRevision) {
    throw new ConflictError(entityId, expectedRevision, actualRevision);
  }
}

function applied(
  command: Command,
  entityId: string,
  revision: number,
): CommandResult {
  return {
    commandId: command.commandId,
    kind: command.kind,
    status: "applied",
    entityId,
    revision,
  };
}

function noop(
  command: Command,
  entityId: string,
  revision: number,
  reason: "manual_provenance" | "already_resolved" | "already_accepted",
): CommandResult {
  return {
    commandId: command.commandId,
    kind: command.kind,
    status: "noop",
    entityId,
    revision,
    reason,
  };
}

function bind(values: unknown[]): SqlValue[] {
  return values as SqlValue[];
}

class NodeDatabaseCoordinator implements DatabaseCoordinator {
  readonly #db: DatabaseSync;
  readonly #queueKey: string;

  constructor(db: DatabaseSync, queueKey: string) {
    this.#db = db;
    this.#queueKey = queueKey;
  }

  execute(command: Command): Promise<CommandResult> {
    const previous =
      WRITE_TAILS_BY_DATABASE.get(this.#queueKey) ?? Promise.resolve();
    const execution = previous.then(() => this.#executeNow(command));
    // A rejected command must not poison the queue for commands behind it.
    const settledTail = execution.then(
      () => undefined,
      () => undefined,
    );
    WRITE_TAILS_BY_DATABASE.set(this.#queueKey, settledTail);
    void settledTail.then(() => {
      if (WRITE_TAILS_BY_DATABASE.get(this.#queueKey) === settledTail) {
        WRITE_TAILS_BY_DATABASE.delete(this.#queueKey);
      }
    });
    return execution;
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.#db.setAuthorizer((actionCode, arg1, arg2) => {
      const isReadAction =
        actionCode === sqliteConstants.SQLITE_SELECT ||
        actionCode === sqliteConstants.SQLITE_READ ||
        actionCode === sqliteConstants.SQLITE_FUNCTION ||
        actionCode === sqliteConstants.SQLITE_RECURSIVE;
      const readOnlyPragmas = new Set([
        "busy_timeout",
        "compile_options",
        "database_list",
        "foreign_key_check",
        "foreign_key_list",
        "foreign_keys",
        "index_info",
        "index_list",
        "index_xinfo",
        "integrity_check",
        "journal_mode",
        "quick_check",
        "table_info",
        "table_list",
        "table_xinfo",
        "user_version",
      ]);
      const isReadOnlyPragma =
        actionCode === sqliteConstants.SQLITE_PRAGMA &&
        readOnlyPragmas.has(arg1 ?? "") &&
        // The listed introspection pragmas may use arg2 as a table name. The
        // state pragmas are writable when arg2 supplies a new value.
        (arg2 === null ||
          [
            "foreign_key_check",
            "foreign_key_list",
            "index_info",
            "index_list",
            "index_xinfo",
            "table_info",
            "table_xinfo",
          ].includes(arg1 ?? ""));
      return isReadAction || isReadOnlyPragma
        ? sqliteConstants.SQLITE_OK
        : sqliteConstants.SQLITE_DENY;
    });
    try {
      return this.#db.prepare(sql).all(...bind(params)) as T[];
    } finally {
      this.#db.setAuthorizer(null);
    }
  }

  #executeNow(command: Command): CommandResult {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const processed = this.#get<ProcessedCommandRow>(
        "SELECT result_json FROM processed_commands WHERE command_id = ?",
        [command.commandId],
      );
      if (processed) {
        const original = JSON.parse(processed.result_json) as CommandResult;
        this.#db.exec("COMMIT");
        return original;
      }

      // Insert the outbox event before applying the domain mutation. Apart from
      // making both writes inseparable, this ordering lets a later failure prove
      // that an already-inserted outbox row is rolled back too.
      this.#insertOutbox(command);
      const result = this.#dispatch(command);

      if (result.status === "noop") {
        this.#run("DELETE FROM outbox WHERE id = ?", [command.commandId]);
      }

      this.#run(
        `INSERT INTO processed_commands (command_id, kind, result_json, created_at)
         VALUES (?, ?, ?, ?)`,
        [command.commandId, command.kind, JSON.stringify(result), Date.now()],
      );
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #dispatch(command: Command): CommandResult {
    switch (command.kind) {
      case "createTransactionFromAlert":
        return this.#createTransactionFromAlert(command);
      case "assignCategory":
        return this.#assignCategory(command);
      case "acceptSuggestion":
        return this.#acceptSuggestion(command);
      case "setBudgetAmount":
        return this.#setBudgetAmount(command);
      case "clearMonthBudget":
        return this.#clearMonthBudget(command);
      case "createCategory":
        return this.#createCategory(command);
      case "renameCategory":
        return this.#renameCategory(command);
      case "archiveCategory":
        return this.#archiveCategory(command);
      case "ignoreTransaction":
        return this.#ignoreTransaction(command);
      case "setPlanType":
        return this.#setPlanType(command);
      case "linkRefund":
        return this.#linkRefund(command);
      case "recordSuggestion":
        return this.#recordSuggestion(command);
      case "resolvePossibleMatch":
        return this.#resolvePossibleMatch(command);
    }
  }

  #createTransactionFromAlert(
    command: CreateTransactionFromAlertCommand,
  ): CommandResult {
    const { alert, transaction } = command.payload;
    const now = Date.now();

    this.#run(
      `INSERT INTO transactions (
         id, occurred_at, received_at, accounting_month_key, amount_minor,
         direction, currency_code, merchant_raw, counterparty_key, channel,
         status, plan_type, revision, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        transaction.id,
        transaction.occurredAt,
        transaction.receivedAt,
        transaction.accountingMonthKey,
        transaction.amountMinor,
        transaction.direction,
        transaction.currencyCode ?? "INR",
        transaction.merchantRaw ?? null,
        transaction.counterpartyKey ?? null,
        transaction.channel ?? null,
        transaction.status ?? "posted",
        transaction.planType ?? "planned",
        now,
      ],
    );

    const allocation = command.payload.allocation ?? {
      categoryId: null,
      source: "rule" as const,
      confidence: null,
    };
    this.#insertFullAllocation(
      allocation.id ?? `${transaction.id}:allocation`,
      transaction.id,
      allocation.categoryId,
      transaction.amountMinor,
      allocation.source,
      allocation.confidence ?? null,
      now,
    );

    this.#run(
      `INSERT INTO source_alerts (
         id, transaction_id, raw_sender, raw_body, received_at,
         provider_message_id, subscription_id, bank_reference, parse_status,
         created_at, revision, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        alert.id,
        transaction.id,
        alert.rawSender ?? null,
        alert.rawBody ?? null,
        alert.receivedAt,
        alert.providerMessageId ?? null,
        alert.subscriptionId ?? null,
        alert.bankReference ?? null,
        alert.parseStatus ?? "parsed",
        now,
        now,
      ],
    );

    this.#assertAllocationInvariant(transaction.id);
    if (allocation.source === "manual" && allocation.categoryId !== null) {
      this.#rememberCategory(
        transaction.id,
        transaction.counterpartyKey ?? null,
        allocation.categoryId,
        now,
      );
    }
    return applied(command, transaction.id, 1);
  }

  #assignCategory(command: AssignCategoryCommand): CommandResult {
    const transaction = this.#transaction(command.payload.transactionId);
    assertExpectedRevision(
      transaction.id,
      command.expectedRevision,
      transaction.revision,
    );

    if (command.payload.source !== "manual") {
      const manual = this.#get<{ present: number }>(
        `SELECT 1 AS present FROM transaction_allocations
         WHERE transaction_id = ? AND source = 'manual' LIMIT 1`,
        [transaction.id],
      );
      if (manual) {
        return noop(
          command,
          transaction.id,
          transaction.revision,
          "manual_provenance",
        );
      }
    }

    const now = Date.now();
    this.#replaceWithFullAllocation(
      command.payload.allocationId ?? `${transaction.id}:allocation`,
      transaction,
      command.payload.categoryId,
      command.payload.source,
      command.payload.confidence ?? null,
      now,
    );
    this.#bumpTransaction(transaction.id, transaction.revision, now);
    this.#assertAllocationInvariant(transaction.id);

    if (command.payload.source === "manual") {
      // This is intentionally last: a failure here must roll back the domain,
      // allocation, and the outbox event inserted at command start.
      this.#rememberCategory(
        transaction.id,
        transaction.counterparty_key,
        command.payload.categoryId,
        now,
      );
    }

    return applied(command, transaction.id, transaction.revision + 1);
  }

  #acceptSuggestion(command: AcceptSuggestionCommand): CommandResult {
    const transaction = this.#transaction(command.payload.transactionId);
    assertExpectedRevision(
      transaction.id,
      command.expectedRevision,
      transaction.revision,
    );
    const suggestion = this.#get<SuggestionRow>(
      "SELECT * FROM suggestions WHERE id = ?",
      [command.payload.suggestionId],
    );
    if (!suggestion || suggestion.transaction_id !== transaction.id) {
      throw new RowNotFoundError(command.payload.suggestionId);
    }
    if (suggestion.accepted_at !== null) {
      return noop(
        command,
        transaction.id,
        transaction.revision,
        "already_accepted",
      );
    }
    assertExpectedRevision(
      transaction.id,
      suggestion.transaction_revision,
      transaction.revision,
    );

    const now = Date.now();
    this.#run(
      `UPDATE suggestions
       SET accepted_at = ?, revision = revision + 1, updated_at = ?
       WHERE id = ? AND revision = ?`,
      [now, now, suggestion.id, suggestion.revision],
    );
    this.#replaceWithFullAllocation(
      command.payload.allocationId ?? `${transaction.id}:allocation`,
      transaction,
      suggestion.category_id,
      "manual",
      null,
      now,
    );
    this.#bumpTransaction(transaction.id, transaction.revision, now);
    this.#assertAllocationInvariant(transaction.id);
    this.#rememberCategory(
      transaction.id,
      transaction.counterparty_key,
      suggestion.category_id,
      now,
    );

    return applied(command, transaction.id, transaction.revision + 1);
  }

  #setBudgetAmount(command: SetBudgetAmountCommand): CommandResult {
    const { monthKey, categoryId, amountMinor } = command.payload;
    const actualMonthRevision = this.#monthRevision(monthKey);
    assertExpectedRevision(
      `budget-month:${monthKey}`,
      command.expectedRevision,
      actualMonthRevision,
    );
    const now = Date.now();
    const existing = this.#get<RevisionRow>(
      "SELECT revision FROM budgets WHERE month_key = ? AND category_id = ?",
      [monthKey, categoryId],
    );

    if (existing) {
      this.#run(
        `UPDATE budgets
         SET amount_minor = ?, recurring = ?, updated_at = ?, revision = revision + 1
         WHERE month_key = ? AND category_id = ? AND revision = ?`,
        [
          amountMinor,
          command.payload.recurring ? 1 : 0,
          now,
          monthKey,
          categoryId,
          existing.revision,
        ],
      );
    } else {
      this.#run(
        `INSERT INTO budgets (
           month_key, category_id, amount_minor, recurring, updated_at, revision
         ) VALUES (?, ?, ?, ?, ?, 1)`,
        [
          monthKey,
          categoryId,
          amountMinor,
          command.payload.recurring ? 1 : 0,
          now,
        ],
      );
    }

    const revision = this.#bumpMonth(monthKey, actualMonthRevision, now);
    return applied(command, monthKey, revision);
  }

  #clearMonthBudget(command: ClearMonthBudgetCommand): CommandResult {
    const { monthKey } = command.payload;
    const actualMonthRevision = this.#monthRevision(monthKey);
    assertExpectedRevision(
      `budget-month:${monthKey}`,
      command.expectedRevision,
      actualMonthRevision,
    );
    const now = Date.now();
    this.#run("DELETE FROM budgets WHERE month_key = ?", [monthKey]);
    const revision = this.#bumpMonth(monthKey, actualMonthRevision, now);
    return applied(command, monthKey, revision);
  }

  #createCategory(command: CreateCategoryCommand): CommandResult {
    const now = Date.now();
    this.#run(
      `INSERT INTO categories (
         id, label, tint, parent_id, is_system, catalog_version,
         updated_at, revision
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        command.payload.categoryId,
        command.payload.label,
        command.payload.tint ?? null,
        command.payload.parentId ?? null,
        command.payload.isSystem ? 1 : 0,
        command.payload.catalogVersion ?? 1,
        now,
      ],
    );
    return applied(command, command.payload.categoryId, 1);
  }

  #renameCategory(command: RenameCategoryCommand): CommandResult {
    const category = this.#revisionRow("categories", command.payload.categoryId);
    assertExpectedRevision(
      command.payload.categoryId,
      command.expectedRevision,
      category.revision,
    );
    const now = Date.now();
    this.#run(
      `UPDATE categories
       SET label = ?, revision = revision + 1, updated_at = ?
       WHERE id = ? AND revision = ?`,
      [
        command.payload.label,
        now,
        command.payload.categoryId,
        category.revision,
      ],
    );
    return applied(command, command.payload.categoryId, category.revision + 1);
  }

  #archiveCategory(command: ArchiveCategoryCommand): CommandResult {
    const category = this.#revisionRow("categories", command.payload.categoryId);
    assertExpectedRevision(
      command.payload.categoryId,
      command.expectedRevision,
      category.revision,
    );
    const now = Date.now();
    this.#run(
      `UPDATE categories
       SET deleted_at = ?, revision = revision + 1, updated_at = ?
       WHERE id = ? AND revision = ?`,
      [now, now, command.payload.categoryId, category.revision],
    );
    return applied(command, command.payload.categoryId, category.revision + 1);
  }

  #ignoreTransaction(command: IgnoreTransactionCommand): CommandResult {
    const transaction = this.#transaction(command.payload.transactionId);
    assertExpectedRevision(
      transaction.id,
      command.expectedRevision,
      transaction.revision,
    );
    const now = Date.now();
    this.#run(
      `UPDATE transactions
       SET status = 'ignored', revision = revision + 1, updated_at = ?
       WHERE id = ? AND revision = ?`,
      [now, transaction.id, transaction.revision],
    );
    return applied(command, transaction.id, transaction.revision + 1);
  }

  #setPlanType(command: SetPlanTypeCommand): CommandResult {
    const transaction = this.#transaction(command.payload.transactionId);
    assertExpectedRevision(
      transaction.id,
      command.expectedRevision,
      transaction.revision,
    );
    const now = Date.now();
    this.#run(
      `UPDATE transactions
       SET plan_type = ?, revision = revision + 1, updated_at = ?
       WHERE id = ? AND revision = ?`,
      [
        command.payload.planType,
        now,
        transaction.id,
        transaction.revision,
      ],
    );
    return applied(command, transaction.id, transaction.revision + 1);
  }

  #linkRefund(command: LinkRefundCommand): CommandResult {
    const refund = this.#transaction(command.payload.refundTransactionId);
    assertExpectedRevision(
      refund.id,
      command.expectedRevision,
      refund.revision,
    );
    if (refund.id === command.payload.originalTransactionId) {
      throw new Error("A transaction cannot reverse itself");
    }
    this.#transaction(command.payload.originalTransactionId);
    const now = Date.now();
    this.#run(
      `UPDATE transactions
       SET reverses_transaction_id = ?, revision = revision + 1, updated_at = ?
       WHERE id = ? AND revision = ?`,
      [
        command.payload.originalTransactionId,
        now,
        refund.id,
        refund.revision,
      ],
    );
    return applied(command, refund.id, refund.revision + 1);
  }

  #recordSuggestion(command: RecordSuggestionCommand): CommandResult {
    const transaction = this.#transaction(command.payload.transactionId);
    assertExpectedRevision(
      transaction.id,
      command.payload.transactionRevision,
      transaction.revision,
    );
    this.#run(
      `INSERT INTO suggestions (
         id, transaction_id, category_id, confidence, tier, catalog_version,
         transaction_revision, created_at, revision, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        command.payload.suggestionId,
        transaction.id,
        command.payload.categoryId,
        command.payload.confidence,
        command.payload.tier,
        command.payload.catalogVersion,
        command.payload.transactionRevision,
        Date.now(),
        Date.now(),
      ],
    );
    return applied(command, command.payload.suggestionId, 1);
  }

  #resolvePossibleMatch(
    command: ResolvePossibleMatchCommand,
  ): CommandResult {
    const match = this.#get<PossibleMatchRow>(
      "SELECT id, resolved, revision FROM possible_matches WHERE id = ?",
      [command.payload.possibleMatchId],
    );
    if (!match) throw new RowNotFoundError(command.payload.possibleMatchId);
    assertExpectedRevision(match.id, command.expectedRevision, match.revision);
    if (match.resolved === 1) {
      return noop(command, match.id, match.revision, "already_resolved");
    }
    this.#run(
      `UPDATE possible_matches
       SET resolved = 1, resolution = ?, revision = revision + 1, updated_at = ?
       WHERE id = ? AND revision = ?`,
      [command.payload.resolution, Date.now(), match.id, match.revision],
    );
    return applied(command, match.id, match.revision + 1);
  }

  #transaction(id: string): TransactionRow {
    const row = this.#get<TransactionRow>(
      `SELECT id, amount_minor, counterparty_key, revision
       FROM transactions WHERE id = ?`,
      [id],
    );
    if (!row) throw new RowNotFoundError(id);
    return row;
  }

  #revisionRow(table: "categories", id: string): RevisionRow {
    const row = this.#get<RevisionRow>(
      `SELECT revision FROM ${table} WHERE id = ?`,
      [id],
    );
    if (!row) throw new RowNotFoundError(id);
    return row;
  }

  #replaceWithFullAllocation(
    allocationId: string,
    transaction: TransactionRow,
    categoryId: string,
    source: AllocationSource,
    confidence: number | null,
    now: number,
  ): void {
    this.#run(
      "DELETE FROM transaction_allocations WHERE transaction_id = ?",
      [transaction.id],
    );
    this.#insertFullAllocation(
      allocationId,
      transaction.id,
      categoryId,
      transaction.amount_minor,
      source,
      confidence,
      now,
    );
  }

  #insertFullAllocation(
    allocationId: string,
    transactionId: string,
    categoryId: string | null,
    amountMinor: number,
    source: AllocationSource,
    confidence: number | null,
    now: number,
  ): void {
    this.#run(
      `INSERT INTO transaction_allocations (
         id, transaction_id, category_id, amount_minor, source,
         confidence, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        allocationId,
        transactionId,
        categoryId,
        amountMinor,
        source,
        confidence,
        now,
      ],
    );
  }

  #bumpTransaction(id: string, revision: number, now: number): void {
    const result = this.#run(
      `UPDATE transactions
       SET revision = revision + 1, updated_at = ?
       WHERE id = ? AND revision = ?`,
      [now, id, revision],
    );
    if (Number(result.changes) !== 1) {
      const actual = this.#transaction(id).revision;
      throw new ConflictError(id, revision, actual);
    }
  }

  #assertAllocationInvariant(transactionId: string): void {
    const transaction = this.#transaction(transactionId);
    const allocation = this.#get<{ total: number | null }>(
      `SELECT sum(amount_minor) AS total
       FROM transaction_allocations WHERE transaction_id = ?`,
      [transactionId],
    );
    const total = allocation?.total ?? 0;
    if (total !== transaction.amount_minor) {
      throw new AllocationInvariantError(
        transactionId,
        transaction.amount_minor,
        total,
      );
    }
  }

  #rememberCategory(
    transactionId: string,
    counterpartyKey: string | null,
    categoryId: string,
    now: number,
  ): void {
    if (!counterpartyKey) return;
    const memoryId = `memory:${transactionId}:${categoryId}`;
    this.#run(
      `INSERT INTO category_memory (
         id, counterparty_key, category_id, observation_count,
         last_observed_at, provisional, updated_at
       ) VALUES (?, ?, ?, 1, ?, 0, ?)
       ON CONFLICT(counterparty_key, category_id) DO UPDATE SET
         observation_count = category_memory.observation_count + 1,
         last_observed_at = excluded.last_observed_at,
         provisional = 0,
         updated_at = excluded.updated_at,
         revision = category_memory.revision + 1`,
      [memoryId, counterpartyKey, categoryId, now, now],
    );
  }

  #monthRevision(monthKey: string): number {
    return (
      this.#get<RevisionRow>(
        "SELECT revision FROM budget_month_revisions WHERE month_key = ?",
        [monthKey],
      )?.revision ?? 0
    );
  }

  #bumpMonth(monthKey: string, revision: number, now: number): number {
    if (revision === 0) {
      this.#run(
        `INSERT INTO budget_month_revisions (month_key, revision, updated_at)
         VALUES (?, 1, ?)`,
        [monthKey, now],
      );
      return 1;
    }
    const result = this.#run(
      `UPDATE budget_month_revisions
       SET revision = revision + 1, updated_at = ?
       WHERE month_key = ? AND revision = ?`,
      [now, monthKey, revision],
    );
    if (Number(result.changes) !== 1) {
      throw new ConflictError(
        `budget-month:${monthKey}`,
        revision,
        this.#monthRevision(monthKey),
      );
    }
    return revision + 1;
  }

  #insertOutbox(command: Command): void {
    const target = this.#outboxTarget(command);
    this.#run(
      `INSERT INTO outbox (
         id, device_id, op, table_name, row_id, payload, created_at
       ) VALUES (?, 'local', ?, ?, ?, ?, ?)`,
      [
        command.commandId,
        command.kind,
        target.table,
        target.id,
        JSON.stringify(command),
        Date.now(),
      ],
    );
  }

  #outboxTarget(command: Command): { table: string; id: string } {
    switch (command.kind) {
      case "createTransactionFromAlert":
        return { table: "transactions", id: command.payload.transaction.id };
      case "assignCategory":
      case "acceptSuggestion":
      case "ignoreTransaction":
      case "setPlanType":
        return { table: "transactions", id: command.payload.transactionId };
      case "linkRefund":
        return {
          table: "transactions",
          id: command.payload.refundTransactionId,
        };
      case "setBudgetAmount":
        return {
          table: "budgets",
          id: `${command.payload.monthKey}:${command.payload.categoryId}`,
        };
      case "clearMonthBudget":
        return { table: "budgets", id: command.payload.monthKey };
      case "createCategory":
      case "renameCategory":
      case "archiveCategory":
        return { table: "categories", id: command.payload.categoryId };
      case "recordSuggestion":
        return { table: "suggestions", id: command.payload.suggestionId };
      case "resolvePossibleMatch":
        return {
          table: "possible_matches",
          id: command.payload.possibleMatchId,
        };
    }
  }

  #get<T>(sql: string, params: SqlValue[] = []): T | undefined {
    return this.#db.prepare(sql).get(...params) as T | undefined;
  }

  #run(sql: string, params: SqlValue[] = []) {
    return this.#db.prepare(sql).run(...params);
  }
}

/**
 * Opens and fully migrates a Node SQLite database before returning it. Because
 * construction is synchronous, neither query() nor execute() can observe a
 * partially migrated schema.
 */
export function createNodeCoordinator(dbPath: string): DatabaseCoordinator {
  const db = new DatabaseSync(dbPath);
  try {
    configureConnection(db);
    applyMigrations(db);
    const queueKey = dbPath === ":memory:" ? dbPath : resolve(dbPath);
    return new NodeDatabaseCoordinator(db, queueKey);
  } catch (error) {
    db.close();
    throw error;
  }
}
