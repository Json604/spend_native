import { NativeModules } from "react-native";

import type { DatabaseCoordinator } from "./coordinator.ts";
import type { Command, CommandResult } from "./commands.ts";

export type NativeCoordinatorErrorCode =
  | "CONFLICT"
  | "ALLOCATION_INVARIANT"
  | "ROW_NOT_FOUND"
  | "READ_ONLY_VIOLATION";

export class ConflictError extends Error {
  readonly code = "CONFLICT" as const;
  constructor(
    readonly entityId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Revision conflict for ${entityId}: expected ${expectedRevision}, found ${actualRevision}`,
    );
    this.name = "ConflictError";
  }
}

export class AllocationInvariantError extends Error {
  readonly code = "ALLOCATION_INVARIANT" as const;
  constructor(
    readonly transactionId: string,
    readonly transactionAmountMinor: number,
    readonly allocationAmountMinor: number,
  ) {
    super(
      `Allocations for ${transactionId} total ${allocationAmountMinor}, expected ${transactionAmountMinor}`,
    );
    this.name = "AllocationInvariantError";
  }
}

export class RowNotFoundError extends Error {
  readonly code = "ROW_NOT_FOUND" as const;
  constructor(readonly entityId: string) {
    super(`Row not found: ${entityId}`);
    this.name = "RowNotFoundError";
  }
}

export class ReadOnlyViolationError extends Error {
  readonly code = "READ_ONLY_VIOLATION" as const;
  constructor(message = "query() only permits a single SELECT or read-only WITH statement") {
    super(message);
    this.name = "ReadOnlyViolationError";
  }
}

export class NativeCoordinatorError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "NativeCoordinatorError";
    this.code = code;
  }
}

interface NativeSpendDatabaseModule {
  execute(commandJson: string): Promise<string>;
  query(sql: string, paramsJson: string): Promise<string>;
}

const SpendDatabase = NativeModules.SpendDatabase as NativeSpendDatabaseModule;

export class NativeDatabaseCoordinator implements DatabaseCoordinator {
  async execute(command: Command): Promise<CommandResult> {
    try {
      const resultJson = await SpendDatabase.execute(JSON.stringify(command));
      return JSON.parse(resultJson) as CommandResult;
    } catch (error) {
      throw toNativeCoordinatorError(error);
    }
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    try {
      const rowsJson = await SpendDatabase.query(sql, JSON.stringify(params));
      return JSON.parse(rowsJson) as T[];
    } catch (error) {
      throw toNativeCoordinatorError(error);
    }
  }
}

export function createNativeCoordinator(): DatabaseCoordinator {
  return new NativeDatabaseCoordinator();
}

export const nativeCoordinator: DatabaseCoordinator = new NativeDatabaseCoordinator();

function toNativeCoordinatorError(error: unknown): Error {
  const nativeError = (error ?? {}) as {
    code?: unknown;
    message?: unknown;
    userInfo?: Record<string, unknown>;
  };
  const code = typeof nativeError.code === "string" ? nativeError.code : "NATIVE_ERROR";
  const message = typeof nativeError.message === "string" ? nativeError.message : code;
  const details = nativeError.userInfo ?? {};

  switch (code) {
    case "CONFLICT": {
      const match = /Revision conflict for (.*): expected (-?\d+), found (-?\d+)/.exec(message);
      return new ConflictError(
        stringDetail(details.entityId, match?.[1] ?? "unknown"),
        numberDetail(details.expectedRevision, Number(match?.[2] ?? 0)),
        numberDetail(details.actualRevision, Number(match?.[3] ?? 0)),
      );
    }
    case "ALLOCATION_INVARIANT": {
      const match = /Allocations for (.*) total (-?\d+), expected (-?\d+)/.exec(message);
      return new AllocationInvariantError(
        stringDetail(details.transactionId, match?.[1] ?? "unknown"),
        numberDetail(details.transactionAmountMinor, Number(match?.[3] ?? 0)),
        numberDetail(details.allocationAmountMinor, Number(match?.[2] ?? 0)),
      );
    }
    case "ROW_NOT_FOUND": {
      const match = /Row not found: (.*)/.exec(message);
      return new RowNotFoundError(stringDetail(details.entityId, match?.[1] ?? "unknown"));
    }
    case "READ_ONLY_VIOLATION":
      return new ReadOnlyViolationError(message);
    default:
      return new NativeCoordinatorError(code, message);
  }
}

function stringDetail(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberDetail(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}
