package com.lym.spend.db

class ConflictError(
  val entityId: String,
  val expectedRevision: Int,
  val actualRevision: Int,
) : IllegalStateException(
  "Revision conflict for $entityId: expected $expectedRevision, found $actualRevision",
)

class AllocationInvariantError(
  val transactionId: String,
  val transactionAmountMinor: Long,
  val allocationAmountMinor: Long,
) : IllegalStateException(
  "Allocations for $transactionId total $allocationAmountMinor, expected $transactionAmountMinor",
)

class RowNotFoundError(val entityId: String) : NoSuchElementException("Row not found: $entityId")
