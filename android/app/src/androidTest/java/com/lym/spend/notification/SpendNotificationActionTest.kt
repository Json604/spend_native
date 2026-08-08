package com.lym.spend.notification

import android.content.Context
import android.content.ContextWrapper
import android.database.sqlite.SQLiteDatabase
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.lym.spend.db.Command
import com.lym.spend.db.CreateCategoryPayload
import com.lym.spend.db.CreateTransactionFromAlertPayload
import com.lym.spend.db.NewAlertPayload
import com.lym.spend.db.NewTransactionPayload
import com.lym.spend.db.PlanType
import com.lym.spend.db.SpendCoordinator
import com.lym.spend.db.SpendDatabase
import com.lym.spend.db.TransactionDirection
import com.lym.spend.db.TransactionStatus
import java.io.File
import java.lang.reflect.InvocationTargetException
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SpendNotificationActionTest {
  @Test
  fun twoTransactionsHaveDistinctPendingIntents() {
    val context = testContext()
    val first = SpendNotificationActions.assignPendingIntent(context, UUID.randomUUID().toString(), "food")
    val second = SpendNotificationActions.assignPendingIntent(context, UUID.randomUUID().toString(), "food")

    assertFalse("transaction data URI must be part of PendingIntent identity", first == second)
  }

  @Test
  fun handlingTheSameActionTwiceAssignsOnceAndLearnsOnce() = withFreshDatabase { coordinator ->
    val categoryId = createCategory(coordinator, "Food")
    val transactionId = createTransaction(coordinator, "merchant:lock-screen")
    val intent = SpendNotificationActions.assignIntent(testContext(), transactionId, categoryId)
    val receiver = SpendNotificationActionReceiver()

    receiver.handle(testContext(), coordinator, intent)
    receiver.handle(testContext(), coordinator, intent)

    val state = coordinator.query(
      """SELECT t.revision, a.category_id, a.source,
                (SELECT observation_count FROM category_memory WHERE counterparty_key = ?) memory_count
         FROM transactions t
         JOIN transaction_allocations a ON a.transaction_id = t.id
         WHERE t.id = ?""",
      arrayOf("merchant:lock-screen", transactionId),
    ).single()
    assertEquals(2L, state["revision"])
    assertEquals(categoryId, state["category_id"])
    assertEquals("manual", state["source"])
    assertEquals(1L, state["memory_count"])
  }

  @Test
  fun deletedTransactionActionIsAStableNoop() = withFreshDatabase { coordinator ->
    val categoryId = createCategory(coordinator, "Food")
    val transactionId = createTransaction(coordinator, "merchant:deleted")
    writableDatabase(coordinator).execSQL(
      "UPDATE transactions SET deleted_at = ? WHERE id = ?",
      arrayOf(System.currentTimeMillis(), transactionId),
    )

    SpendNotificationActionReceiver().handle(
      testContext(), coordinator,
      SpendNotificationActions.assignIntent(testContext(), transactionId, categoryId),
    )

    assertEquals(
      0L,
      coordinator.query(
        "SELECT count(*) AS count FROM category_memory WHERE counterparty_key = ?",
        arrayOf("merchant:deleted"),
      ).single()["count"],
    )
  }

  @Test
  fun actionKeepsTheStoredPreviousMonth() = withFreshDatabase { coordinator ->
    val categoryId = createCategory(coordinator, "Travel")
    val transactionId = createTransaction(coordinator, "merchant:december", month = "2025-12")

    SpendNotificationActionReceiver().handle(
      testContext(), coordinator,
      SpendNotificationActions.assignIntent(testContext(), transactionId, categoryId),
    )

    val state = coordinator.query(
      "SELECT accounting_month_key, a.category_id FROM transactions t JOIN transaction_allocations a ON a.transaction_id = t.id WHERE t.id = ?",
      arrayOf(transactionId),
    ).single()
    assertEquals("2025-12", state["accounting_month_key"])
    assertEquals(categoryId, state["category_id"])
  }

  @Test
  fun actionWithMissingCategoryCannotWrite() = withFreshDatabase { coordinator ->
    val transactionId = createTransaction(coordinator, "merchant:invalid-category")
    val missingCategoryId = UUID.randomUUID().toString()

    SpendNotificationActionReceiver().handle(
      testContext(), coordinator,
      SpendNotificationActions.assignIntent(testContext(), transactionId, missingCategoryId),
    )

    val state = coordinator.query(
      "SELECT a.category_id, a.source FROM transaction_allocations a WHERE a.transaction_id = ?",
      arrayOf(transactionId),
    ).single()
    assertEquals(null, state["category_id"])
    assertEquals("rule", state["source"])
  }

  private fun testContext(): Context = InstrumentationRegistry.getInstrumentation().targetContext

  private fun <T> withFreshDatabase(block: (SpendCoordinator) -> T): T {
    val file = File(testContext().cacheDir, "spend-${UUID.randomUUID()}.sqlite")
    val context = TemporaryDatabaseContext(testContext(), file)
    val database = newSpendDatabase(context)
    val coordinator = newSpendCoordinator(database)
    return try {
      block(coordinator)
    } finally {
      SpendDatabase::class.java.getDeclaredField("database").apply { isAccessible = true }
        .get(database).let { (it as SQLiteDatabase).close() }
      file.delete()
      File(file.path + "-wal").delete()
      File(file.path + "-shm").delete()
    }
  }

  private fun createCategory(coordinator: SpendCoordinator, label: String): String {
    val categoryId = UUID.randomUUID().toString()
    coordinator.execute(
      Command.CreateCategory(UUID.randomUUID().toString(), CreateCategoryPayload(categoryId, label)),
    )
    return categoryId
  }

  private fun createTransaction(coordinator: SpendCoordinator, key: String, month: String = "2026-01"): String {
    val transactionId = UUID.randomUUID().toString()
    coordinator.execute(
      Command.CreateTransactionFromAlert(
        UUID.randomUUID().toString(),
        CreateTransactionFromAlertPayload(
          alert = NewAlertPayload(id = UUID.randomUUID().toString(), receivedAt = 1_700_000_000_000L),
          transaction = NewTransactionPayload(
            id = transactionId,
            occurredAt = 1_700_000_000_000L,
            receivedAt = 1_700_000_000_000L,
            accountingMonthKey = month,
            amountMinor = 10_000,
            direction = TransactionDirection.DEBIT,
            currencyCode = "INR",
            counterpartyKey = key,
            status = TransactionStatus.POSTED,
            planType = PlanType.PLANNED,
          ),
        ),
      ),
    )
    return transactionId
  }

  private fun writableDatabase(coordinator: SpendCoordinator): SQLiteDatabase {
    val database = SpendCoordinator::class.java.getDeclaredField("spendDatabase").apply { isAccessible = true }
      .get(coordinator)
    return SpendDatabase::class.java.getDeclaredField("database").apply { isAccessible = true }
      .get(database) as SQLiteDatabase
  }

  private fun newSpendDatabase(context: Context): SpendDatabase = try {
    SpendDatabase::class.java.getDeclaredConstructor(Context::class.java).apply { isAccessible = true }
      .newInstance(context)
  } catch (error: InvocationTargetException) {
    throw (error.cause ?: error)
  }

  private fun newSpendCoordinator(database: SpendDatabase): SpendCoordinator =
    SpendCoordinator::class.java.getDeclaredConstructor(SpendDatabase::class.java).apply { isAccessible = true }
      .newInstance(database)

  private class TemporaryDatabaseContext(base: Context, private val file: File) : ContextWrapper(base) {
    override fun getApplicationContext(): Context = this
    override fun getDatabasePath(name: String): File = file
  }
}
