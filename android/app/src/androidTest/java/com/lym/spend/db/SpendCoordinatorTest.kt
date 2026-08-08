package com.lym.spend.db

import android.test.InstrumentationTestCase
import java.util.UUID

@Suppress("DEPRECATION")
class SpendCoordinatorTest : InstrumentationTestCase() {
  fun testCommandsAreAtomicIdempotentRevisionedAndPreserveManualProvenance() {
    val context = instrumentation.targetContext
    context.deleteDatabase(SpendDatabase.DATABASE_NAME)
    val coordinator = SpendCoordinator.getInstance(context)
    val categoryId = UUID.randomUUID().toString()
    val transactionId = UUID.randomUUID().toString()
    val alertId = UUID.randomUUID().toString()

    coordinator.execute(
      Command.CreateCategory(
        UUID.randomUUID().toString(),
        CreateCategoryPayload(categoryId, "Food"),
      ),
    )
    coordinator.execute(
      Command.CreateTransactionFromAlert(
        UUID.randomUUID().toString(),
        CreateTransactionFromAlertPayload(
          alert = NewAlertPayload(alertId, receivedAt = 1_775_779_200_000L),
          transaction = NewTransactionPayload(
            id = transactionId,
            occurredAt = 1_775_579_200_000L,
            receivedAt = 1_775_579_200_000L,
            accountingMonthKey = "2026-04",
            amountMinor = 10_000,
            direction = TransactionDirection.DEBIT,
            counterpartyKey = "merchant:test",
          ),
        ),
      ),
    )

    val commandId = UUID.randomUUID().toString()
    val manual = Command.AssignCategory(
      commandId,
      expectedRevision = 1,
      payload = AssignCategoryPayload(transactionId, categoryId, AllocationSource.MANUAL),
    )
    val firstResult = coordinator.execute(manual)
    assertEquals(firstResult, coordinator.execute(manual))

    val machineId = UUID.randomUUID().toString()
    val machineResult = coordinator.execute(
      Command.AssignCategory(
        machineId,
        expectedRevision = 2,
        payload = AssignCategoryPayload(transactionId, categoryId, AllocationSource.LLM, 0.99),
      ),
    )
    assertEquals("manual_provenance", (machineResult as CommandResult.Noop).reason)

    val staleId = UUID.randomUUID().toString()
    try {
      coordinator.execute(
        Command.IgnoreTransaction(staleId, 1, IgnoreTransactionPayload(transactionId)),
      )
      fail("Expected a revision conflict")
    } catch (error: ConflictError) {
      assertEquals(1, error.expectedRevision)
      assertEquals(2, error.actualRevision)
    }

    val state = coordinator.query(
      """SELECT t.revision, t.amount_minor,
           (SELECT sum(amount_minor) FROM transaction_allocations WHERE transaction_id = t.id) allocated,
           (SELECT source FROM transaction_allocations WHERE transaction_id = t.id) source,
           (SELECT count(*) FROM outbox WHERE id = ?) stale_outbox,
           (SELECT count(*) FROM outbox WHERE id = ?) machine_outbox,
           (SELECT count(*) FROM processed_commands WHERE command_id = ?) machine_log
         FROM transactions t WHERE id = ?""",
      arrayOf(staleId, machineId, machineId, transactionId),
    ).single()
    assertEquals(2L, state["revision"])
    assertEquals(state["amount_minor"], state["allocated"])
    assertEquals("manual", state["source"])
    assertEquals(0L, state["stale_outbox"])
    assertEquals(0L, state["machine_outbox"])
    assertEquals(1L, state["machine_log"])
  }
}
