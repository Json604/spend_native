package com.lym.spend.db

import android.content.Context
import android.content.ContextWrapper
import android.database.sqlite.SQLiteDatabase
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.lang.reflect.InvocationTargetException
import java.util.Collections
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SpendCoordinatorTest {
  @Test
  fun migrationsApplyFromScratchAtTheNewestVersion() = withFreshDatabase { coordinator ->
    val newestVersion = Migrations.loadMigrationChain(testContext()).last().version
    val version = coordinator.query("PRAGMA user_version").single()["user_version"]
    val commandLog = coordinator.query("SELECT name FROM pragma_table_info('processed_commands')")

    assertEquals(newestVersion.toLong(), version)
    assertEquals(listOf("command_id", "kind", "result_json", "created_at"), commandLog.map { it["name"] })
  }

  @Test
  fun newerDatabaseVersionIsRefusedWithoutResettingTheFile() {
    val file = freshDatabaseFile()
    val context = TemporaryDatabaseContext(testContext(), file)
    try {
      SQLiteDatabase.openDatabase(
        file.absolutePath,
        null,
        SQLiteDatabase.OPEN_READWRITE or SQLiteDatabase.CREATE_IF_NECESSARY,
      ).use { database -> database.execSQL("PRAGMA user_version = 99") }

      try {
        newSpendDatabase(context)
        fail("Expected a database newer than the supported migrations to be refused")
      } catch (error: IllegalStateException) {
        assertTrue(error.message.orEmpty().contains("user_version 99 is newer than supported version"))
      }

      SQLiteDatabase.openDatabase(file.absolutePath, null, SQLiteDatabase.OPEN_READWRITE).use { database ->
        database.rawQuery("PRAGMA user_version", emptyArray()).use { cursor ->
          assertTrue(cursor.moveToFirst())
          assertEquals(99, cursor.getInt(0))
        }
      }
    } finally {
      deleteDatabaseFiles(file)
    }
  }

  @Test
  fun executingACommandTwiceWritesOnceAndReturnsTheOriginalResult() = withFreshDatabase { coordinator ->
    val command = Command.CreateCategory(
      commandId = UUID.randomUUID().toString(),
      payload = CreateCategoryPayload(UUID.randomUUID().toString(), "Food"),
    )

    val firstResult = coordinator.execute(command)
    val secondResult = coordinator.execute(command)
    val counts = coordinator.query(
      """SELECT
           (SELECT count(*) FROM categories WHERE id = ?) categories,
           (SELECT count(*) FROM outbox WHERE id = ?) outbox,
           (SELECT count(*) FROM processed_commands WHERE command_id = ?) processed""",
      arrayOf(command.payload.categoryId, command.commandId, command.commandId),
    ).single()

    assertEquals(firstResult, secondResult)
    assertEquals(1L, counts["categories"])
    // outbox.id IS the commandId, so one row is expected. The guarantee under
    // test is that replaying the command does not write a SECOND one.
    assertEquals(1L, counts["outbox"])
    assertEquals(1L, counts["processed"])
  }

  @Test
  fun staleExpectedRevisionThrowsAndMutatesNothing() = withFreshDatabase { coordinator ->
    val categoryId = createCategory(coordinator, "Food")
    val transactionId = createTransaction(coordinator)
    coordinator.execute(
      Command.AssignCategory(
        UUID.randomUUID().toString(),
        expectedRevision = 1,
        payload = AssignCategoryPayload(transactionId, categoryId, AllocationSource.MANUAL),
      ),
    )

    val staleCommandId = UUID.randomUUID().toString()
    try {
      coordinator.execute(
        Command.IgnoreTransaction(
          staleCommandId,
          expectedRevision = 1,
          payload = IgnoreTransactionPayload(transactionId),
        ),
      )
      fail("Expected a revision conflict")
    } catch (error: ConflictError) {
      assertEquals(transactionId, error.entityId)
      assertEquals(1, error.expectedRevision)
      assertEquals(2, error.actualRevision)
    }

    val state = coordinator.query(
      """SELECT t.revision, t.status,
           (SELECT count(*) FROM transaction_allocations WHERE transaction_id = t.id) allocations,
           (SELECT sum(amount_minor) FROM transaction_allocations WHERE transaction_id = t.id) allocated,
           (SELECT count(*) FROM outbox WHERE id = ?) outbox,
           (SELECT count(*) FROM processed_commands WHERE command_id = ?) processed
         FROM transactions t WHERE t.id = ?""",
      arrayOf(staleCommandId, staleCommandId, transactionId),
    ).single()

    assertEquals(2L, state["revision"])
    assertEquals("posted", state["status"])
    assertEquals(1L, state["allocations"])
    assertEquals(10_000L, state["allocated"])
    assertEquals(0L, state["outbox"])
    assertEquals(0L, state["processed"])
  }

  @Test
  fun machineAssignmentsNeverOverwriteManualAllocation() = withFreshDatabase { coordinator ->
    val manualCategoryId = createCategory(coordinator, "Manual")
    val machineCategoryId = createCategory(coordinator, "Machine")
    val transactionId = createTransaction(coordinator)
    coordinator.execute(
      Command.AssignCategory(
        UUID.randomUUID().toString(),
        expectedRevision = 1,
        payload = AssignCategoryPayload(transactionId, manualCategoryId, AllocationSource.MANUAL),
      ),
    )

    val machineSources = listOf(
      AllocationSource.LLM,
      AllocationSource.RULE,
      AllocationSource.SIMILARITY,
      AllocationSource.LEARNED,
    )
    machineSources.forEach { source ->
      val result = coordinator.execute(
        Command.AssignCategory(
          UUID.randomUUID().toString(),
          expectedRevision = 2,
          payload = AssignCategoryPayload(transactionId, machineCategoryId, source, confidence = 0.99),
        ),
      )
      assertTrue(result is CommandResult.Noop)
      assertEquals("manual_provenance", (result as CommandResult.Noop).reason)
    }

    val allocation = coordinator.query(
      """SELECT t.revision, a.category_id, a.source, a.amount_minor
         FROM transactions t
         JOIN transaction_allocations a ON a.transaction_id = t.id
         WHERE t.id = ?""",
      arrayOf(transactionId),
    ).single()
    assertEquals(2L, allocation["revision"])
    assertEquals(manualCategoryId, allocation["category_id"])
    assertEquals("manual", allocation["source"])
    assertEquals(10_000L, allocation["amount_minor"])
  }

  @Test
  fun failedCommandLeavesNoOrphanedOutboxRow() = withFreshDatabase { coordinator ->
    val commandId = UUID.randomUUID().toString()
    val missingTransactionId = UUID.randomUUID().toString()

    try {
      coordinator.execute(
        Command.IgnoreTransaction(
          commandId,
          expectedRevision = 1,
          payload = IgnoreTransactionPayload(missingTransactionId),
        ),
      )
      fail("Expected a missing transaction failure")
    } catch (error: RowNotFoundError) {
      assertEquals(missingTransactionId, error.entityId)
    }

    val counts = coordinator.query(
      """SELECT
           (SELECT count(*) FROM outbox WHERE id = ?) outbox,
           (SELECT count(*) FROM processed_commands WHERE command_id = ?) processed""",
      arrayOf(commandId, commandId),
    ).single()
    assertEquals(0L, counts["outbox"])
    assertEquals(0L, counts["processed"])
  }

  @Test
  fun concurrentWritesAreSerializedWithoutSqliteBusyEscaping() = withFreshDatabase { coordinator ->
    val commandCount = 50
    val start = CountDownLatch(1)
    val finished = CountDownLatch(commandCount)
    val failures = Collections.synchronizedList(mutableListOf<Throwable>())
    val executor = Executors.newFixedThreadPool(8)

    repeat(commandCount) { index ->
      executor.execute {
        try {
          start.await()
          coordinator.execute(
            Command.CreateCategory(
              UUID.randomUUID().toString(),
              CreateCategoryPayload(UUID.randomUUID().toString(), "Category $index"),
            ),
          )
        } catch (error: Throwable) {
          failures.add(error)
        } finally {
          finished.countDown()
        }
      }
    }

    start.countDown()
    assertTrue("Timed out waiting for concurrent writes", finished.await(30, TimeUnit.SECONDS))
    executor.shutdown()
    assertTrue("Concurrent write failures: ${failures.joinToString()}", failures.isEmpty())
    assertTrue(executor.awaitTermination(30, TimeUnit.SECONDS))

    val count = coordinator.query("SELECT count(*) AS count FROM categories").single()["count"]
    assertEquals(commandCount.toLong(), count)
  }

  private fun testContext(): Context = InstrumentationRegistry.getInstrumentation().targetContext

  private fun <T> withFreshDatabase(block: (SpendCoordinator) -> T): T {
    val file = freshDatabaseFile()
    val context = TemporaryDatabaseContext(testContext(), file)
    val database = newSpendDatabase(context)
    val coordinator = newSpendCoordinator(database)
    return try {
      block(coordinator)
    } finally {
      closeSpendDatabase(database)
      deleteDatabaseFiles(file)
    }
  }

  private fun freshDatabaseFile(): File {
    val directory = File(testContext().cacheDir, "spend-instrumented-databases")
    check(directory.exists() || directory.mkdirs())
    return File(directory, "spend-${UUID.randomUUID()}.sqlite")
  }

  private fun createCategory(coordinator: SpendCoordinator, label: String): String {
    val categoryId = UUID.randomUUID().toString()
    coordinator.execute(
      Command.CreateCategory(
        UUID.randomUUID().toString(),
        CreateCategoryPayload(categoryId, label),
      ),
    )
    return categoryId
  }

  private fun createTransaction(coordinator: SpendCoordinator): String {
    val transactionId = UUID.randomUUID().toString()
    coordinator.execute(
      Command.CreateTransactionFromAlert(
        UUID.randomUUID().toString(),
        CreateTransactionFromAlertPayload(
          alert = NewAlertPayload(
            id = UUID.randomUUID().toString(),
            receivedAt = 1_775_779_200_000L,
          ),
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
    return transactionId
  }

  private fun newSpendDatabase(context: Context): SpendDatabase = try {
    SpendDatabase::class.java.getDeclaredConstructor(Context::class.java).apply {
      isAccessible = true
    }.newInstance(context)
  } catch (error: InvocationTargetException) {
    throw (error.cause ?: error)
  }

  private fun newSpendCoordinator(database: SpendDatabase): SpendCoordinator =
    SpendCoordinator::class.java.getDeclaredConstructor(SpendDatabase::class.java).apply {
      isAccessible = true
    }.newInstance(database)

  private fun closeSpendDatabase(database: SpendDatabase) {
    SpendDatabase::class.java.getDeclaredField("database").apply {
      isAccessible = true
    }.get(database).let { (it as SQLiteDatabase).close() }
  }

  private fun deleteDatabaseFiles(file: File) {
    file.delete()
    File(file.path + "-wal").delete()
    File(file.path + "-shm").delete()
  }

  private class TemporaryDatabaseContext(
    base: Context,
    private val databaseFile: File,
  ) : ContextWrapper(base) {
    override fun getApplicationContext(): Context = this

    override fun getDatabasePath(name: String): File = databaseFile
  }
}
