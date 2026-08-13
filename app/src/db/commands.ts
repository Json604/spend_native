/**
 * The complete write API for the local spend database.
 *
 * Commands are deliberately data-only.  They can cross a JS/native boundary and
 * can be persisted or retried without carrying closures or platform objects.
 * `commandId` must be a client-generated UUID and is the idempotency key.
 */

export type TransactionDirection = "debit" | "credit" | "transfer";
export type TransactionStatus =
  | "pending"
  | "posted"
  | "failed"
  | "reversed"
  | "ignored";
export type PlanType = "planned" | "unplanned";
export type AllocationSource =
  | "manual"
  | "learned"
  | "rule"
  | "similarity"
  | "llm"
  | "migrated";
export type AssignableAllocationSource = Exclude<AllocationSource, "migrated">;

export interface NewTransactionPayload {
  id: string;
  occurredAt: number;
  receivedAt: number;
  accountingMonthKey: string;
  amountMinor: number;
  direction: TransactionDirection;
  currencyCode?: string;
  merchantRaw?: string | null;
  counterpartyKey?: string | null;
  channel?: string | null;
  status?: TransactionStatus;
  planType?: PlanType;
}

export interface NewAlertPayload {
  id: string;
  rawSender?: string | null;
  rawBody?: string | null;
  receivedAt: number;
  providerMessageId?: string | null;
  subscriptionId?: number | null;
  bankReference?: string | null;
  parseStatus?: string;
}

export interface InitialAllocationPayload {
  id?: string;
  categoryId: string | null;
  source: AllocationSource;
  confidence?: number | null;
}

export interface CreateTransactionFromAlertCommand {
  commandId: string;
  kind: "createTransactionFromAlert";
  payload: {
    alert: NewAlertPayload;
    transaction: NewTransactionPayload;
    /** Defaults to a full-amount, uncategorized rule allocation. */
    allocation?: InitialAllocationPayload;
  };
}

export interface AssignCategoryCommand {
  commandId: string;
  kind: "assignCategory";
  /** Revision of the transaction aggregate, which owns its allocations. */
  expectedRevision: number;
  payload: {
    transactionId: string;
    categoryId: string;
    source: AssignableAllocationSource;
    confidence?: number | null;
    allocationId?: string;
  };
}

export interface SplitTransactionCommand {
  commandId: string;
  kind: "splitTransaction";
  expectedRevision: number;
  payload: {
    transactionId: string;
    allocations: Array<{
      categoryId: string;
      amountMinor: number;
      allocationId?: string;
    }>;
  };
}

export interface AcceptSuggestionCommand {
  commandId: string;
  kind: "acceptSuggestion";
  /** Revision of the transaction aggregate. */
  expectedRevision: number;
  payload: {
    transactionId: string;
    suggestionId: string;
    allocationId?: string;
  };
}

export interface SetBudgetAmountCommand {
  commandId: string;
  kind: "setBudgetAmount";
  /** Revision of the month budget aggregate; use 0 when it does not exist. */
  expectedRevision: number;
  payload: {
    monthKey: string;
    categoryId: string;
    amountMinor: number;
    recurring?: boolean;
  };
}

export interface ClearMonthBudgetCommand {
  commandId: string;
  kind: "clearMonthBudget";
  /** Revision of the month budget aggregate; use 0 when it does not exist. */
  expectedRevision: number;
  payload: {
    monthKey: string;
  };
}

export interface CreateCategoryCommand {
  commandId: string;
  kind: "createCategory";
  payload: {
    categoryId: string;
    label: string;
    tint?: string | null;
    parentId?: string | null;
    isSystem?: boolean;
    catalogVersion?: number;
  };
}

export interface RenameCategoryCommand {
  commandId: string;
  kind: "renameCategory";
  expectedRevision: number;
  payload: {
    categoryId: string;
    label: string;
  };
}

export interface ArchiveCategoryCommand {
  commandId: string;
  kind: "archiveCategory";
  expectedRevision: number;
  payload: {
    categoryId: string;
  };
}

export interface IgnoreTransactionCommand {
  commandId: string;
  kind: "ignoreTransaction";
  expectedRevision: number;
  payload: {
    transactionId: string;
  };
}

export interface SetPlanTypeCommand {
  commandId: string;
  kind: "setPlanType";
  expectedRevision: number;
  payload: {
    transactionId: string;
    planType: PlanType;
  };
}

export interface LinkRefundCommand {
  commandId: string;
  kind: "linkRefund";
  /** Revision of the refund transaction being linked. */
  expectedRevision: number;
  payload: {
    refundTransactionId: string;
    originalTransactionId: string;
  };
}

export interface RecordSuggestionCommand {
  commandId: string;
  kind: "recordSuggestion";
  payload: {
    suggestionId: string;
    transactionId: string;
    categoryId: string;
    confidence: number;
    tier: string;
    catalogVersion: number;
    /** The transaction snapshot against which the suggestion was calculated. */
    transactionRevision: number;
  };
}

export type PossibleMatchResolution = "duplicate" | "distinct";

export interface ResolvePossibleMatchCommand {
  commandId: string;
  kind: "resolvePossibleMatch";
  expectedRevision: number;
  payload: {
    possibleMatchId: string;
    resolution: PossibleMatchResolution;
  };
}

/** This union is intentionally closed; adding a mutation is a contract change. */
export type Command =
  | CreateTransactionFromAlertCommand
  | AssignCategoryCommand
  | SplitTransactionCommand
  | AcceptSuggestionCommand
  | SetBudgetAmountCommand
  | ClearMonthBudgetCommand
  | CreateCategoryCommand
  | RenameCategoryCommand
  | ArchiveCategoryCommand
  | IgnoreTransactionCommand
  | SetPlanTypeCommand
  | LinkRefundCommand
  | RecordSuggestionCommand
  | ResolvePossibleMatchCommand;

export type CommandKind = Command["kind"];

export type CommandResult =
  | {
      commandId: string;
      kind: CommandKind;
      status: "applied";
      entityId: string;
      revision: number;
    }
  | {
      commandId: string;
      kind: CommandKind;
      status: "noop";
      entityId: string;
      revision: number;
      reason: "manual_provenance" | "already_resolved" | "already_accepted";
    };
