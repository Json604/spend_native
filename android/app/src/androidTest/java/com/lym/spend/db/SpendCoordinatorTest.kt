package com.lym.spend.db

import android.content.Context
import android.content.ContextWrapper
import android.database.sqlite.SQLiteDatabase
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.lym.spend.classify.ClassifierThresholds
import com.lym.spend.sms.SmsIngestInput
import com.lym.spend.sms.SpendSmsIngestor
import com.lym.spend.widget.SpendWidgetStorage
import java.io.File
import java.lang.reflect.InvocationTargetException
import java.util.Collections
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SpendCoordinatorTest {
  @Test
  fun widgetSnapshotRefreshReadsThePersistedMerchantColumn() = withFreshDatabase { coordinator ->
    val now = System.currentTimeMillis()
    val transactionId = UUID.randomUUID().toString()
    coordinator.execute(
      Command.CreateTransactionFromAlert(
        UUID.randomUUID().toString(),
        CreateTransactionFromAlertPayload(
          alert = NewAlertPayload(
            id = UUID.randomUUID().toString(),
            rawBody = "Paid Rs.125.50 to Zepto",
            receivedAt = now,
          ),
          transaction = NewTransactionPayload(
            id = transactionId,
            occurredAt = now,
            receivedAt = now,
            accountingMonthKey = java.text.SimpleDateFormat("yyyy-MM", java.util.Locale.ROOT)
              .format(java.util.Date(now)),
            amountMinor = 12_550,
            direction = TransactionDirection.DEBIT,
            merchantRaw = "Zepto",
          ),
        ),
      ),
    )

    SpendWidgetStorage.refreshFromDatabase(testContext(), coordinator)
    val snapshot = SpendWidgetStorage.readSnapshot(testContext())

    assertTrue(snapshot.todaySpends.any { it.label == "Zepto" && it.amountLabel == "₹125.50" })
    assertEquals("₹125.50", snapshot.todayFormatted)
  }

  @Test
  fun migrationsApplyFromScratchAtTheNewestVersion() = withFreshDatabase { coordinator ->
    val newestVersion = Migrations.loadMigrationChain(testContext()).last().version
    val version = coordinator.query("PRAGMA user_version").single()["user_version"]
    val commandLog = coordinator.query("SELECT name FROM pragma_table_info('processed_commands')")
    val rejected = coordinator.query("SELECT name FROM pragma_table_info('sync_rejected')")

    assertEquals(newestVersion.toLong(), version)
    assertEquals(listOf("command_id", "kind", "result_json", "created_at"), commandLog.map { it["name"] })
    assertEquals(
      listOf("command_id", "command_json", "error", "attempt_count", "created_at", "updated_at"),
      rejected.map { it["name"] },
    )
    val aliases = coordinator.query("SELECT name FROM pragma_table_info('category_aliases')")
    assertEquals(listOf("remote_id", "local_id"), aliases.map { it["name"] })
  }

  @Test
  fun pulledCreateCategoryWithTheSameLabelAliasesOntoTheLiveLocalRow() = withFreshDatabase { coordinator ->
    val localId = createCategory(coordinator, "Food")
    val remoteId = UUID.randomUUID().toString()
    coordinator.execute(
      Command.CreateCategory(
        UUID.randomUUID().toString(),
        CreateCategoryPayload(remoteId, "Food"),
      ),
    )
    coordinator.execute(
      Command.SetBudgetAmount(
        UUID.randomUUID().toString(),
        expectedRevision = 0,
        payload = SetBudgetAmountPayload(
          monthKey = "2026-08",
          categoryId = remoteId,
          amountMinor = 10_000,
        ),
      ),
    )

    val alias = coordinator.query(
      "SELECT remote_id, local_id FROM category_aliases WHERE remote_id = ?",
      arrayOf(remoteId),
    ).single()
    assertEquals(remoteId, alias["remote_id"])
    assertEquals(localId, alias["local_id"])

    val budget = coordinator.query(
      "SELECT category_id, amount_minor FROM budgets WHERE month_key = ?",
      arrayOf("2026-08"),
    ).single()
    assertEquals(localId, budget["category_id"])
    assertEquals(10_000L, budget["amount_minor"])

    assertEquals(
      0L,
      coordinator.query("SELECT count(*) AS n FROM categories WHERE id = ?", arrayOf(remoteId)).single()["n"],
    )
  }

  @Test
  fun aliasToAnArchivedCategoryIsIgnoredThenRetargetedOntoTheNewLiveLabel() = withFreshDatabase { coordinator ->
    val archivedId = createCategory(coordinator, "Food")
    val remoteId = UUID.randomUUID().toString()
    coordinator.execute(
      Command.CreateCategory(
        UUID.randomUUID().toString(),
        CreateCategoryPayload(remoteId, "Food"),
      ),
    )
    coordinator.execute(
      Command.ArchiveCategory(
        UUID.randomUUID().toString(),
        expectedRevision = 1,
        payload = ArchiveCategoryPayload(archivedId),
      ),
    )

    try {
      coordinator.execute(
        Command.SetBudgetAmount(
          UUID.randomUUID().toString(),
          expectedRevision = 0,
          payload = SetBudgetAmountPayload(
            monthKey = "2026-08",
            categoryId = remoteId,
            amountMinor = 10_000,
          ),
        ),
      )
      fail("Expected setBudgetAmount on an archived alias to fail rather than write a tombstone")
    } catch (_: Throwable) {
      // FOREIGN KEY / row-not-found — either is fine so long as A is untouched.
    }
    assertEquals(
      0L,
      coordinator.query("SELECT count(*) AS n FROM budgets WHERE category_id = ?", arrayOf(archivedId))
        .single()["n"],
    )

    val liveId = createCategory(coordinator, "Food")
    coordinator.execute(
      Command.SetBudgetAmount(
        UUID.randomUUID().toString(),
        expectedRevision = 0,
        payload = SetBudgetAmountPayload(
          monthKey = "2026-08",
          categoryId = remoteId,
          amountMinor = 10_000,
        ),
      ),
    )

    val alias = coordinator.query(
      "SELECT local_id FROM category_aliases WHERE remote_id = ?",
      arrayOf(remoteId),
    ).single()
    assertEquals(liveId, alias["local_id"])
    val budget = coordinator.query(
      "SELECT category_id, amount_minor FROM budgets WHERE month_key = ?",
      arrayOf("2026-08"),
    ).single()
    assertEquals(liveId, budget["category_id"])
    assertEquals(10_000L, budget["amount_minor"])
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
  fun aSingleMemoryObservationDoesNotAutoApply() = withFreshDatabase { coordinator ->
    val categoryId = createCategory(coordinator, "Personal")
    val first = createTransaction(coordinator, counterpartyKey = "merchant:single")
    assignManual(coordinator, first, categoryId)

    val second = createTransaction(coordinator, counterpartyKey = "merchant:single")
    val state = coordinator.query(
      """SELECT a.category_id, a.source,
           (SELECT count(*) FROM suggestions WHERE transaction_id = ?) suggestions
         FROM transaction_allocations a WHERE a.transaction_id = ?""",
      arrayOf(second, second),
    ).single()
    assertEquals(null, state["category_id"])
    assertEquals("rule", state["source"])
    assertEquals(1L, state["suggestions"])
  }

  @Test
  fun repeatedConsistentMemoryObservationsAutoApply() = withFreshDatabase { coordinator ->
    val categoryId = createCategory(coordinator, "Personal")
    repeat(30) {
      val transactionId = createTransaction(coordinator, counterpartyKey = "merchant:repeat")
      assignManual(coordinator, transactionId, categoryId)
    }

    val transactionId = createTransaction(coordinator, counterpartyKey = "merchant:repeat")
    val allocation = coordinator.query(
      "SELECT category_id, source, confidence FROM transaction_allocations WHERE transaction_id = ?",
      arrayOf(transactionId),
    ).single()
    assertEquals(categoryId, allocation["category_id"])
    assertEquals("learned", allocation["source"])
    assertTrue((allocation["confidence"] as Double) >= ClassifierThresholds.MEMORY_AUTO_APPLY_CONFIDENCE)
  }

  @Test
  fun conflictingMemoryAbstainsAndRecordsTopTwoSuggestions() = withFreshDatabase { coordinator ->
    val firstCategory = createCategory(coordinator, "Personal")
    val secondCategory = createCategory(coordinator, "Travel")
    repeat(4) {
      val transactionId = createTransaction(coordinator, counterpartyKey = "merchant:conflict")
      assignManual(coordinator, transactionId, firstCategory)
    }
    repeat(3) {
      val transactionId = createTransaction(coordinator, counterpartyKey = "merchant:conflict")
      assignManual(coordinator, transactionId, secondCategory)
    }

    val transactionId = createTransaction(coordinator, counterpartyKey = "merchant:conflict")
    val state = coordinator.query(
      """SELECT a.category_id, a.source,
           (SELECT count(*) FROM suggestions WHERE transaction_id = ?) suggestions
         FROM transaction_allocations a WHERE a.transaction_id = ?""",
      arrayOf(transactionId, transactionId),
    ).single()
    assertEquals(null, state["category_id"])
    assertEquals("rule", state["source"])
    assertEquals(2L, state["suggestions"])
  }

  @Test
  fun manualAssignmentWritesMemoryWithTheAllocationTransaction() = withFreshDatabase { coordinator ->
    val categoryId = createCategory(coordinator, "Personal")
    val transactionId = createTransaction(coordinator, counterpartyKey = "merchant:atomic-memory")
    assignManual(coordinator, transactionId, categoryId)

    val state = coordinator.query(
      """SELECT a.source, m.category_id, m.observation_count
         FROM transaction_allocations a
         LEFT JOIN category_memory m ON m.counterparty_key = 'merchant:atomic-memory'
         WHERE a.transaction_id = ?""",
      arrayOf(transactionId),
    ).single()
    assertEquals("manual", state["source"])
    assertEquals(categoryId, state["category_id"])
    assertEquals(1L, state["observation_count"])
  }

  @Test
  fun pspAggregatorKeyIsNeverLearned() = withFreshDatabase { coordinator ->
    val categoryId = createCategory(coordinator, "Personal")
    val transactionId = createTransaction(coordinator, counterpartyKey = "vpa:paytm@okaxis")
    assignManual(coordinator, transactionId, categoryId)

    assertEquals(0L, coordinator.query("SELECT count(*) AS count FROM category_memory").single()["count"])
  }

  @Test
  fun provisionalMemoryCannotAutoApply() = withFreshDatabase { coordinator ->
    val categoryId = createCategory(coordinator, "Personal")
    val first = createTransaction(coordinator, counterpartyKey = "merchant:provisional")
    assignManual(coordinator, first, categoryId)
    writableDatabase(coordinator).execSQL("UPDATE category_memory SET provisional = 1")

    val second = createTransaction(coordinator, counterpartyKey = "merchant:provisional")
    val state = coordinator.query(
      """SELECT a.category_id,
           (SELECT count(*) FROM suggestions WHERE transaction_id = ?) suggestions
         FROM transaction_allocations a WHERE a.transaction_id = ?""",
      arrayOf(second, second),
    ).single()
    assertEquals(null, state["category_id"])
    assertEquals(1L, state["suggestions"])
  }

  @Test
  fun similarityDoesNotAutoApplyBelowMinimumSupport() = withFreshDatabase { coordinator ->
    val categoryId = createCategory(coordinator, "Travel")
    repeat(2) { index ->
      val transactionId = createTransaction(
        coordinator,
        counterpartyKey = "merchant:history-$index",
        merchantRaw = "Cafe Central",
      )
      assignManual(coordinator, transactionId, categoryId)
    }

    val transactionId = createTransaction(
      coordinator,
      counterpartyKey = "merchant:new-cafe",
      merchantRaw = "Cafe Central",
    )
    val state = coordinator.query(
      """SELECT a.category_id,
           (SELECT count(*) FROM suggestions WHERE transaction_id = ?) suggestions,
           (SELECT tier FROM suggestions WHERE transaction_id = ? LIMIT 1) suggestion_tier,
           (SELECT confidence FROM suggestions WHERE transaction_id = ? LIMIT 1) suggestion_confidence
         FROM transaction_allocations a WHERE a.transaction_id = ?""",
      arrayOf(transactionId, transactionId, transactionId, transactionId),
    ).single()

    // Similarity abstains below its minimum support. The one suggestion is the
    // cascade's zero-confidence fallback, which keeps the transaction visible
    // for review rather than silently dropping it; it is not an auto-apply.
    assertEquals(null, state["category_id"])
    assertEquals(1L, state["suggestions"])
    assertEquals("memory", state["suggestion_tier"])
    assertEquals(0.0, state["suggestion_confidence"])
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

  @Test
  fun ingestingIndianUpiDebitWritesOneAlertAndOneTransaction() = withFreshDatabase { coordinator ->
    SpendSmsIngestor.ingest(
      testContext(),
      coordinator,
      SmsIngestInput(
        sender = "KOTAKB",
        body = "Sent Rs.48.00 from XXXXXX1234 to RAHUL SHARMA on 01/06/2026. UPI ref no. 651805890728.",
        timestamp = 1_780_272_000_000L,
        subscriptionId = 1,
        providerMessageId = "provider-upi-48",
      ),
    )

    val state = coordinator.query(
      """SELECT
           (SELECT count(*) FROM source_alerts) alerts,
           (SELECT count(*) FROM transactions) transactions,
           (SELECT amount_minor FROM transactions) amount,
           (SELECT direction FROM transactions) direction""",
    ).single()
    assertEquals(1L, state["alerts"])
    assertEquals(1L, state["transactions"])
    assertEquals(4_800L, state["amount"])
    assertEquals("debit", state["direction"])
  }

  @Test
  fun marketingCreditCardOfferIsRetainedButDoesNotCreatePhantomTransaction() = withFreshDatabase { coordinator ->
    SpendSmsIngestor.ingest(
      testContext(),
      coordinator,
      SmsIngestInput(
        sender = "KOTAK",
        body = "Get upto 8 PVR INOX tickets on Lifetime Free pre-approved Kotak League Credit Card. Limit Rs. 90000",
        timestamp = 1_780_272_000_000L,
        subscriptionId = 1,
        providerMessageId = "provider-kotak-offer",
      ),
    )

    val state = coordinator.query(
      """SELECT
           (SELECT count(*) FROM source_alerts) alerts,
           (SELECT parse_status FROM source_alerts) parse_status,
           (SELECT count(*) FROM transactions) transactions""",
    ).single()
    assertEquals(1L, state["alerts"])
    assertEquals("non_transaction_marketing", state["parse_status"])
    assertEquals(0L, state["transactions"])
  }

  @Test
  fun availableBalanceIsNotUsedAsTheDebitAmount() = withFreshDatabase { coordinator ->
    SpendSmsIngestor.ingest(
      testContext(),
      coordinator,
      SmsIngestInput(
        sender = "HDFCBK",
        body = "Avl Bal Rs.12,345 in A/c X1234 after debit of Rs.500.",
        timestamp = 1_780_272_000_000L,
        subscriptionId = 1,
        providerMessageId = "provider-balance-500",
      ),
    )

    val transaction = coordinator.query(
      "SELECT amount_minor, direction FROM transactions",
    ).single()
    assertEquals(50_000L, transaction["amount_minor"])
    assertEquals("debit", transaction["direction"])
  }

  @Test
  fun repeatingProviderMessageAndSubscriptionIsDeduplicatedEndToEnd() = withFreshDatabase { coordinator ->
    val input = SmsIngestInput(
      sender = "ICICIB",
      body = "You have spent Rs.125.00 at SWIGGY using your card.",
      timestamp = 1_780_272_000_000L,
      subscriptionId = 2,
      providerMessageId = "provider-dedupe-125",
    )
    SpendSmsIngestor.ingest(testContext(), coordinator, input)
    SpendSmsIngestor.ingest(testContext(), coordinator, input)

    val counts = coordinator.query(
      """SELECT
           (SELECT count(*) FROM source_alerts WHERE provider_message_id = ?) alerts,
           (SELECT count(*) FROM transactions) transactions""",
      arrayOf(input.providerMessageId!!),
    ).single()
    assertEquals(1L, counts["alerts"])
    assertEquals(1L, counts["transactions"])
  }

  @Test
  fun ingestingTheSameFingerprintTwiceWritesOneTransaction() = withFreshDatabase { coordinator ->
    val input = SmsIngestInput(
      sender = "KOTAKB",
      body = "Sent Rs.48.00 from XXXXXX1234 to RAHUL SHARMA on 01/06/2026. UPI ref no. 651805890728.",
      timestamp = 1_780_272_000_000L,
      subscriptionId = 1,
    )
    SpendSmsIngestor.ingest(testContext(), coordinator, input)
    SpendSmsIngestor.ingest(testContext(), coordinator, input)

    assertEquals(
      1L,
      coordinator.query("SELECT count(*) AS count FROM transactions").single()["count"],
    )
  }

  @Test
  fun reingestingAnExistingTransactionSkipsWidgetSideEffects() = withFreshDatabase { coordinator ->
    val input = SmsIngestInput(
      sender = "KOTAKB",
      body = "Sent Rs.48.00 from XXXXXX1234 to RAHUL SHARMA on 01/06/2026. UPI ref no. 651805890728.",
      timestamp = 1_780_272_000_000L,
      subscriptionId = 1,
    )
    SpendSmsIngestor.ingest(testContext(), coordinator, input)
    SpendWidgetStorage.writeSnapshotJson(
      testContext(),
      """{"monthLabel":"SENTINEL","todayFormatted":"₹0","monthSpentMinor":0,"monthBudgetMinor":null,"daysRemainingInMonth":0,"topCategories":[],"todaySpends":[]}""",
    )
    assertEquals("SENTINEL", SpendWidgetStorage.readSnapshot(testContext()).monthLabel)

    SpendSmsIngestor.ingest(testContext(), coordinator, input)

    assertEquals(
      1L,
      coordinator.query("SELECT count(*) AS count FROM transactions").single()["count"],
    )
    assertEquals("SENTINEL", SpendWidgetStorage.readSnapshot(testContext()).monthLabel)
  }

  @Test
  fun nonTransactionMessageKeepsParseStatusForLaterReprocessing() = withFreshDatabase { coordinator ->
    SpendSmsIngestor.ingest(
      testContext(),
      coordinator,
      SmsIngestInput(
        sender = "BANK",
        body = "Your monthly statement is ready to view in the mobile app.",
        timestamp = 1_780_272_000_000L,
        subscriptionId = 1,
        providerMessageId = "provider-statement",
      ),
    )

    val alert = coordinator.query("SELECT parse_status FROM source_alerts").single()
    assertEquals("unknown_classification", alert["parse_status"])
    assertEquals(0L, coordinator.query("SELECT count(*) AS count FROM transactions").single()["count"])
  }

  @Test
  fun pulledBatchAppliesSuccessesStoresRejectsAndAdvancesCursor() = withFreshDatabase { coordinator ->
    val userId = "user-1"
    coordinator.claimLocalData(userId, "device-1")
    val categoryId = UUID.randomUUID().toString()
    val good = Command.CreateCategory(
      UUID.randomUUID().toString(),
      CreateCategoryPayload(categoryId, "Food"),
    )
    val badId = UUID.randomUUID().toString()
    val badJson = JSONObject()
      .put("commandId", badId)
      .put("kind", "notACommand")
      .put("payload", JSONObject())
      .toString()
    val commandsJson = JSONArray()
      .put(good.toJson().toString())
      .put(badJson)
      .toString()

    coordinator.applyPulledOps(commandsJson, "cursor-after-page", userId)
    coordinator.applyPulledOps(JSONArray().put(badJson).toString(), "cursor-after-retry", userId)

    val state = coordinator.query(
      """SELECT
           (SELECT count(*) FROM categories WHERE id = ?) categories,
           (SELECT count(*) FROM processed_commands WHERE command_id = ?) good_processed,
           (SELECT count(*) FROM processed_commands WHERE command_id = ?) bad_processed,
           (SELECT count(*) FROM sync_rejected WHERE command_id = ?) rejected,
           (SELECT command_json FROM sync_rejected WHERE command_id = ?) rejected_json,
           (SELECT attempt_count FROM sync_rejected WHERE command_id = ?) attempts,
           (SELECT value FROM sync_metadata WHERE key = 'pull_cursor') cursor""",
      arrayOf(categoryId, good.commandId, badId, badId, badId, badId),
    ).single()
    assertEquals(1L, state["categories"])
    assertEquals(1L, state["good_processed"])
    assertEquals(0L, state["bad_processed"])
    assertEquals(1L, state["rejected"])
    assertEquals(badJson, state["rejected_json"])
    assertEquals(1L, state["attempts"])
    assertEquals("cursor-after-retry", state["cursor"])
  }

  @Test
  fun retryRejectedOpsAppliesANowValidCommandAndClearsTheRow() = withFreshDatabase { coordinator ->
    val categoryId = UUID.randomUUID().toString()
    val command = Command.CreateCategory(
      UUID.randomUUID().toString(),
      CreateCategoryPayload(categoryId, "Travel"),
    )
    val now = System.currentTimeMillis()
    writableDatabase(coordinator).execSQL(
      """INSERT INTO sync_rejected (
           command_id, command_json, error, attempt_count, created_at, updated_at
         ) VALUES (?, ?, ?, 1, ?, ?)""",
      arrayOf(command.commandId, command.toJson().toString(), "previous failure", now, now),
    )

    val report = JSONObject(coordinator.retryRejectedOps())
    val state = coordinator.query(
      """SELECT
           (SELECT count(*) FROM categories WHERE id = ?) categories,
           (SELECT count(*) FROM processed_commands WHERE command_id = ?) processed,
           (SELECT count(*) FROM sync_rejected WHERE command_id = ?) rejected,
           (SELECT count(*) FROM outbox WHERE id = ?) outbox""",
      arrayOf(categoryId, command.commandId, command.commandId, command.commandId),
    ).single()

    assertEquals(1, report.getInt("retried"))
    assertEquals(1, report.getInt("applied"))
    assertEquals(0, report.getInt("rejected"))
    assertEquals(1L, state["categories"])
    assertEquals(1L, state["processed"])
    assertEquals(0L, state["rejected"])
    assertEquals(0L, state["outbox"])
  }

  @Test
  fun retryRejectedOpsIncrementsAttemptCountWhenStillInvalid() = withFreshDatabase { coordinator ->
    val badId = UUID.randomUUID().toString()
    val badJson = JSONObject()
      .put("commandId", badId)
      .put("kind", "notACommand")
      .put("payload", JSONObject())
      .toString()
    val now = System.currentTimeMillis()
    writableDatabase(coordinator).execSQL(
      """INSERT INTO sync_rejected (
           command_id, command_json, error, attempt_count, created_at, updated_at
         ) VALUES (?, ?, ?, 1, ?, ?)""",
      arrayOf(badId, badJson, "previous failure", now, now),
    )

    val report = JSONObject(coordinator.retryRejectedOps())
    val state = coordinator.query(
      """SELECT command_json, attempt_count, error
         FROM sync_rejected WHERE command_id = ?""",
      arrayOf(badId),
    ).single()

    assertEquals(1, report.getInt("retried"))
    assertEquals(0, report.getInt("applied"))
    assertEquals(1, report.getInt("rejected"))
    assertEquals(badJson, state["command_json"])
    assertEquals(2L, state["attempt_count"])
    assertTrue((state["error"] as String).isNotEmpty())
  }

  @Test
  fun successfulApplyClearsAMatchingRejectedRow() = withFreshDatabase { coordinator ->
    val userId = "user-1"
    coordinator.claimLocalData(userId, "device-1")
    val categoryId = UUID.randomUUID().toString()
    val command = Command.CreateCategory(
      UUID.randomUUID().toString(),
      CreateCategoryPayload(categoryId, "Travel"),
    )
    val now = System.currentTimeMillis()
    writableDatabase(coordinator).execSQL(
      """INSERT INTO sync_rejected (
           command_id, command_json, error, attempt_count, created_at, updated_at
         ) VALUES (?, ?, ?, 1, ?, ?)""",
      arrayOf(command.commandId, command.toJson().toString(), "previous failure", now, now),
    )

    coordinator.applyPulledOps(JSONArray().put(command.toJson().toString()).toString(), "cursor-2", userId)

    val state = coordinator.query(
      """SELECT
           (SELECT count(*) FROM categories WHERE id = ?) categories,
           (SELECT count(*) FROM sync_rejected WHERE command_id = ?) rejected""",
      arrayOf(categoryId, command.commandId),
    ).single()
    assertEquals(1L, state["categories"])
    assertEquals(0L, state["rejected"])
  }

  @Test
  fun unparseableProcessedRejectedRowDoesNotBlockApply() = withFreshDatabase { coordinator ->
    val userId = "user-1"
    coordinator.claimLocalData(userId, "device-1")
    val categoryId = UUID.randomUUID().toString()
    val command = Command.CreateCategory(
      UUID.randomUUID().toString(),
      CreateCategoryPayload(categoryId, "Books"),
    )
    writableDatabase(coordinator).execSQL(
      """INSERT INTO processed_commands (command_id, kind, result_json, created_at)
         VALUES (?, ?, ?, ?)""",
      arrayOf(
        command.commandId,
        "rejected",
        JSONObject().put("error", "old").put("command", command.toJson().toString().take(300)).toString(),
        System.currentTimeMillis(),
      ),
    )

    coordinator.applyPulledOps(JSONArray().put(command.toJson().toString()).toString(), "cursor-3", userId)

    val state = coordinator.query(
      """SELECT
           (SELECT count(*) FROM categories WHERE id = ?) categories,
           (SELECT kind FROM processed_commands WHERE command_id = ?) kind""",
      arrayOf(categoryId, command.commandId),
    ).single()
    assertEquals(1L, state["categories"])
    assertEquals("createCategory", state["kind"])
  }

  @Test
  fun persistFailureDoesNotAdvanceThePullCursor() = withFreshDatabase { coordinator ->
    val userId = "user-1"
    coordinator.claimLocalData(userId, "device-1")
    val categoryId = UUID.randomUUID().toString()
    val good = Command.CreateCategory(
      UUID.randomUUID().toString(),
      CreateCategoryPayload(categoryId, "Food"),
    )
    val badJson = JSONObject()
      .put("commandId", UUID.randomUUID().toString())
      .put("kind", "notACommand")
      .put("payload", JSONObject())
      .toString()
    writableDatabase(coordinator).execSQL("DROP TABLE sync_rejected")

    try {
      coordinator.applyPulledOps(
        JSONArray().put(good.toJson().toString()).put(badJson).toString(),
        "cursor-must-not-advance",
        userId,
      )
      fail("Expected persist of a rejected command to fail")
    } catch (_: Throwable) {
      // The good command is already committed; the page must be retried.
    }

    val state = coordinator.query(
      """SELECT
           (SELECT count(*) FROM categories WHERE id = ?) categories,
           (SELECT value FROM sync_metadata WHERE key = 'pull_cursor') cursor""",
      arrayOf(categoryId),
    ).single()
    assertEquals(1L, state["categories"])
    assertEquals(null, state["cursor"])
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

  private fun createTransaction(
    coordinator: SpendCoordinator,
    counterpartyKey: String? = "merchant:test",
    merchantRaw: String? = null,
    amountMinor: Long = 10_000,
  ): String {
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
            amountMinor = amountMinor,
            direction = TransactionDirection.DEBIT,
            merchantRaw = merchantRaw,
            counterpartyKey = counterpartyKey,
          ),
        ),
      ),
    )
    return transactionId
  }

  private fun assignManual(coordinator: SpendCoordinator, transactionId: String, categoryId: String) {
    coordinator.execute(
      Command.AssignCategory(
        UUID.randomUUID().toString(),
        expectedRevision = 1,
        payload = AssignCategoryPayload(transactionId, categoryId, AllocationSource.MANUAL),
      ),
    )
  }

  private fun writableDatabase(coordinator: SpendCoordinator): SQLiteDatabase {
    val spendDatabase = SpendCoordinator::class.java.getDeclaredField("spendDatabase").apply {
      isAccessible = true
    }.get(coordinator)
    return SpendDatabase::class.java.getDeclaredField("database").apply {
      isAccessible = true
    }.get(spendDatabase) as SQLiteDatabase
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
