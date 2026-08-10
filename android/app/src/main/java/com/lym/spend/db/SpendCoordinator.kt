package com.lym.spend.db

import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteStatement
import com.lym.spend.classify.ClassifierCascade
import com.lym.spend.classify.ClassifierTransactionInput
import com.lym.spend.classify.ClassificationCandidate
import com.lym.spend.classify.ClassificationTier
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.min

class SpendCoordinator private constructor(private val spendDatabase: SpendDatabase) {
  private val classifierCascade = ClassifierCascade(spendDatabase.applicationContext)

  /** Executes one complete command transaction on the process-wide writer. */
  fun execute(command: Command): CommandResult = spendDatabase.writeTransaction { database ->
    processedResult(database, command.commandId)?.let { return@writeTransaction it }

    insertOutbox(database, command)
    val result = dispatch(database, command)
    if (result is CommandResult.Noop) {
      database.execSQL("DELETE FROM outbox WHERE id = ?", arrayOf(command.commandId))
    }
    database.execSQL(
      """INSERT INTO processed_commands (command_id, kind, result_json, created_at)
         VALUES (?, ?, ?, ?)""",
      arrayOf(command.commandId, command.kind, result.toJsonString(), System.currentTimeMillis()),
    )
    result
  }

  /** Claims pre-login local data without creating a sync operation of its own. */
  fun claimLocalData(userId: String, deviceId: String): String = spendDatabase.writeTransaction { database ->
    val owner = metadata(database, OWNER_KEY)
    if (owner != null && owner != userId) throw SyncOwnershipError(owner, userId)
    if (owner == null) {
      database.execSQL(
        "INSERT INTO sync_metadata (key, value) VALUES (?, ?)",
        arrayOf(OWNER_KEY, userId),
      )
    }
    // Offline commands use the provisional device id. Bind them to the stable
    // installation id when the account is first claimed (or reclaimed).
    database.execSQL(
      "UPDATE outbox SET device_id = ? WHERE device_id = 'local'",
      arrayOf(deviceId),
    )
    owner ?: "claimed"
  }

  fun acknowledgeOutbox(idsJson: String): Int = spendDatabase.writeTransaction { database ->
    val ids = JSONArray(idsJson)
    var removed = 0
    for (index in 0 until ids.length()) {
      removed += database.delete("outbox", "id = ?", arrayOf(ids.getString(index)))
    }
    removed
  }

  fun recordOutboxFailure(id: String, error: String, maxAttempts: Int): Int =
    spendDatabase.writeTransaction { database ->
      val attempt = scalarInt(database, "SELECT attempt_count FROM outbox WHERE id = ?", arrayOf(id))
        ?: return@writeTransaction 0
      val nextAttempt = attempt + 1
      val deadLettered = if (nextAttempt >= maxAttempts) 1 else 0
      val exponent = min(nextAttempt - 1, 10)
      val backoff = min(7L * 24 * 60 * 60 * 1000, 5_000L * (1L shl exponent))
      database.execSQL(
        """UPDATE outbox
           SET attempt_count = ?, last_error = ?, dead_lettered = ?, next_attempt_at = ?
           WHERE id = ?""",
        arrayOf(nextAttempt, error.take(1_000), deadLettered, System.currentTimeMillis() + backoff, id),
      )
      nextAttempt
    }

  /**
   * Applies every pulled command, then advances the cursor.
   *
   * Each command commits in its OWN transaction. This used to be a single
   * transaction around the whole batch, which meant one command that could not
   * apply — a constraint the server tolerates and this schema does not — rolled
   * back every other command AND the cursor with it. Sync then retried the same
   * batch forever, hitting the same wall: the app said "Backup paused, will
   * retry automatically" indefinitely while nothing moved in either direction.
   *
   * A command that cannot apply is recorded as rejected and skipped rather than
   * retried, because a poison op is otherwise permanent. It is counted and
   * reported, never silently dropped: the caller surfaces the number so the data
   * is known to be incomplete instead of quietly wrong.
   */
  fun applyPulledOps(commandsJson: String, cursor: String, userId: String): String {
    spendDatabase.writeTransaction { database ->
      val owner = metadata(database, OWNER_KEY)
      if (owner != userId) throw SyncOwnershipError(owner ?: "none", userId)
    }
    val commands = JSONArray(commandsJson)
    val results = JSONArray()
    val rejected = JSONArray()
    for (index in 0 until commands.length()) {
      val raw = commands.getString(index)
      try {
        val command = Command.fromJsonString(raw)
        val result = spendDatabase.writeTransaction { database ->
          processedResult(database, command.commandId) ?: dispatch(database, command).also {
            database.execSQL(
              """INSERT INTO processed_commands (command_id, kind, result_json, created_at)
                 VALUES (?, ?, ?, ?)""",
              arrayOf(command.commandId, command.kind, it.toJsonString(), System.currentTimeMillis()),
            )
          }
        }
        results.put(result.toJsonString())
      } catch (error: Throwable) {
        val detail = JSONObject()
          .put("error", error.message ?: error::class.java.simpleName)
          .put("command", raw.take(300))
        rejected.put(detail)
        // Mark it processed so the next pull does not stop on it again. The
        // rejection is reported upward, so this is a decision the user can see
        // rather than a silent discard.
        runCatching {
          val commandId = JSONObject(raw).optString("commandId", "")
          if (commandId.isNotEmpty()) spendDatabase.writeTransaction { database ->
            database.execSQL(
              """INSERT OR IGNORE INTO processed_commands (command_id, kind, result_json, created_at)
                 VALUES (?, ?, ?, ?)""",
              arrayOf(commandId, "rejected", detail.toString(), System.currentTimeMillis()),
            )
          }
        }
      }
    }
    spendDatabase.writeTransaction { database ->
      database.execSQL(
        "INSERT OR REPLACE INTO sync_metadata (key, value) VALUES (?, ?)",
        arrayOf(CURSOR_KEY, cursor),
      )
    }
    return JSONObject()
      .put("applied", results)
      .put("rejected", rejected)
      .toString()
  }

  fun deadLetterCount(): Int = spendDatabase.read { database ->
    scalarInt(database, "SELECT COUNT(*) FROM outbox WHERE dead_lettered = 1", emptyArray()) ?: 0
  }

  /**
   * Read-only helper. It deliberately does not acquire the writer lock; WAL lets
   * readers observe the last committed snapshot while a command is in flight.
   */
  fun query(
    sql: String,
    selectionArgs: Array<String> = emptyArray(),
  ): List<Map<String, Any?>> {
    val statement = requireReadOnlyStatement(sql)
    return spendDatabase.read { database ->
      database.rawQuery(statement, selectionArgs).use { cursor ->
        buildList {
          while (cursor.moveToNext()) add(cursor.toMap())
        }
      }
    }
  }

  private fun dispatch(database: SQLiteDatabase, command: Command): CommandResult = when (command) {
    is Command.CreateTransactionFromAlert -> createTransactionFromAlert(database, command)
    is Command.RecordSourceAlert -> recordSourceAlert(database, command)
    is Command.UpdateAlertParseStatus -> updateAlertParseStatus(database, command)
    is Command.AssignCategory -> assignCategory(database, command)
    is Command.SplitTransaction -> splitTransaction(database, command)
    is Command.AcceptSuggestion -> acceptSuggestion(database, command)
    is Command.SetBudgetAmount -> setBudgetAmount(database, command)
    is Command.ClearMonthBudget -> clearMonthBudget(database, command)
    is Command.CreateCategory -> createCategory(database, command)
    is Command.RenameCategory -> renameCategory(database, command)
    is Command.ArchiveCategory -> archiveCategory(database, command)
    is Command.IgnoreTransaction -> ignoreTransaction(database, command)
    is Command.SetPlanType -> setPlanType(database, command)
    is Command.LinkRefund -> linkRefund(database, command)
    is Command.RecordSuggestion -> recordSuggestion(database, command)
    is Command.ResolvePossibleMatch -> resolvePossibleMatch(database, command)
  }

  private fun createTransactionFromAlert(
    database: SQLiteDatabase,
    command: Command.CreateTransactionFromAlert,
  ): CommandResult {
    val alert = command.payload.alert
    val transaction = command.payload.transaction
    val now = System.currentTimeMillis()

    // This transaction may already be here. The device creates it from the SMS
    // as it arrives, under its own command id; the server later replays the
    // same creation under a DIFFERENT op id, so processed_commands cannot
    // recognise the repeat and the INSERT hits transactions.id — one collision
    // aborts the entire pulled batch and sync stops dead.
    //
    // Treat it as the idempotent no-op it is. Deliberately a full no-op: the
    // allocation and any learned category already exist too, and re-running the
    // classifier here could overwrite a categorisation the user has since made
    // by hand.
    val existingRevision = scalarInt(
      database,
      "SELECT revision FROM transactions WHERE id = ?",
      arrayOf(transaction.id),
    )
    if (existingRevision != null) return applied(command, transaction.id, existingRevision)

    database.execSQL(
      """INSERT INTO transactions (
           id, occurred_at, received_at, accounting_month_key, amount_minor,
           direction, currency_code, merchant_raw, counterparty_key, channel,
           status, plan_type, revision, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)""",
      arrayOf(
        transaction.id,
        transaction.occurredAt,
        transaction.receivedAt,
        transaction.accountingMonthKey,
        transaction.amountMinor,
        transaction.direction.wireValue,
        transaction.currencyCode,
        transaction.merchantRaw,
        transaction.counterpartyKey,
        transaction.channel,
        transaction.status.wireValue,
        transaction.planType.wireValue,
        now,
      ),
    )

    val updatedAlert = executeUpdateDelete(
      database,
      """UPDATE source_alerts
         SET transaction_id = ?, parse_status = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND transaction_id IS NULL""",
      arrayOf(transaction.id, alert.parseStatus, now, alert.id),
    )
    if (updatedAlert == 0) database.execSQL(
      """INSERT INTO source_alerts (
           id, transaction_id, raw_sender, raw_body, received_at,
           provider_message_id, subscription_id, bank_reference, parse_status,
           created_at, revision, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)""",
      arrayOf(
        alert.id,
        transaction.id,
        alert.rawSender,
        alert.rawBody,
        alert.receivedAt,
        alert.providerMessageId,
        alert.subscriptionId,
        alert.bankReference,
        alert.parseStatus,
        now,
        now,
      ),
    )

    val requestedAllocation = command.payload.allocation
    val cascade = if (requestedAllocation == null && transaction.direction == TransactionDirection.DEBIT) {
      classifierCascade.classify(
        database,
        ClassifierTransactionInput(
          transactionId = transaction.id,
          amountMinor = transaction.amountMinor,
          merchantRaw = transaction.merchantRaw,
          counterpartyKey = transaction.counterpartyKey,
          channel = transaction.channel,
          rawMessage = alert.rawBody,
        ),
      )
    } else null
    val autoCandidate = cascade?.autoApply
    val allocation = requestedAllocation ?: autoCandidate?.let { candidate ->
      InitialAllocationPayload(
        categoryId = candidate.categoryId,
        source = candidate.allocationSource(),
        confidence = candidate.confidence,
      )
    } ?: InitialAllocationPayload(categoryId = null, source = AllocationSource.RULE)

    insertFullAllocation(
      database,
      allocation.id ?: "${transaction.id}:allocation",
      transaction.id,
      allocation.categoryId,
      transaction.amountMinor,
      allocation.source,
      allocation.confidence,
      now,
    )
    cascade?.suggestions?.forEach { suggestion ->
      insertClassifierSuggestion(database, transaction.id, suggestion, now)
    }

    assertAllocationInvariant(database, transaction.id)
    if (allocation.source == AllocationSource.MANUAL && allocation.categoryId != null) {
      rememberCategory(database, transaction.id, transaction.counterpartyKey, allocation.categoryId, now)
    }
    return applied(command, transaction.id, 1)
  }

  private fun recordSourceAlert(
    database: SQLiteDatabase,
    command: Command.RecordSourceAlert,
  ): CommandResult {
    val alert = command.payload
    val now = System.currentTimeMillis()
    val inserted = executeUpdateDelete(
      database,
      """INSERT OR IGNORE INTO source_alerts (
           id, transaction_id, raw_sender, raw_body, received_at,
           provider_message_id, subscription_id, bank_reference, parse_status,
           created_at, revision, updated_at
         ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)""",
      arrayOf(
        alert.id, alert.rawSender, alert.rawBody, alert.receivedAt,
        alert.providerMessageId, alert.subscriptionId, alert.bankReference, alert.parseStatus,
        now, now,
      ),
    )
    return if (inserted == 1) applied(command, alert.id, 1)
    else noop(command, alert.id, 1, "duplicate_provider_alert")
  }

  private fun updateAlertParseStatus(
    database: SQLiteDatabase,
    command: Command.UpdateAlertParseStatus,
  ): CommandResult {
    val payload = command.payload
    val changed = executeUpdateDelete(
      database,
      """UPDATE source_alerts
         SET parse_status = ?, revision = revision + 1, updated_at = ?
         WHERE id = ?""",
      arrayOf(payload.parseStatus, System.currentTimeMillis(), payload.alertId),
    )
    return if (changed == 1) applied(command, payload.alertId, 1)
    else noop(command, payload.alertId, 0, "alert_not_found")
  }

  private fun assignCategory(
    database: SQLiteDatabase,
    command: Command.AssignCategory,
  ): CommandResult {
    val transaction = transaction(database, command.payload.transactionId)
    assertExpectedRevision(transaction.id, command.expectedRevision, transaction.revision)

    if (command.payload.source != AllocationSource.MANUAL && hasManualAllocation(database, transaction.id)) {
      return noop(command, transaction.id, transaction.revision, "manual_provenance")
    }

    val now = System.currentTimeMillis()
    replaceWithFullAllocation(
      database,
      command.payload.allocationId ?: "${transaction.id}:allocation",
      transaction,
      command.payload.categoryId,
      command.payload.source,
      command.payload.confidence,
      now,
    )
    bumpTransaction(database, transaction.id, transaction.revision, now)
    assertAllocationInvariant(database, transaction.id)
    if (command.payload.source == AllocationSource.MANUAL) {
      rememberCategory(database, transaction.id, transaction.counterpartyKey, command.payload.categoryId, now)
    }
    return applied(command, transaction.id, transaction.revision + 1)
  }

  private fun acceptSuggestion(
    database: SQLiteDatabase,
    command: Command.AcceptSuggestion,
  ): CommandResult {
    val transaction = transaction(database, command.payload.transactionId)
    assertExpectedRevision(transaction.id, command.expectedRevision, transaction.revision)
    val suggestion = suggestion(database, command.payload.suggestionId)
    if (suggestion == null || suggestion.transactionId != transaction.id) {
      throw RowNotFoundError(command.payload.suggestionId)
    }
    if (suggestion.acceptedAt != null) {
      return noop(command, transaction.id, transaction.revision, "already_accepted")
    }
    assertExpectedRevision(transaction.id, suggestion.transactionRevision, transaction.revision)

    val now = System.currentTimeMillis()
    database.execSQL(
      """UPDATE suggestions
         SET accepted_at = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ?""",
      arrayOf(now, now, suggestion.id, suggestion.revision),
    )
    replaceWithFullAllocation(
      database,
      command.payload.allocationId ?: "${transaction.id}:allocation",
      transaction,
      suggestion.categoryId,
      AllocationSource.MANUAL,
      null,
      now,
    )
    bumpTransaction(database, transaction.id, transaction.revision, now)
    assertAllocationInvariant(database, transaction.id)
    rememberCategory(database, transaction.id, transaction.counterpartyKey, suggestion.categoryId, now)
    return applied(command, transaction.id, transaction.revision + 1)
  }

  private fun splitTransaction(
    database: SQLiteDatabase,
    command: Command.SplitTransaction,
  ): CommandResult {
    val transaction = transaction(database, command.payload.transactionId)
    assertExpectedRevision(transaction.id, command.expectedRevision, transaction.revision)
    val allocations = command.payload.allocations
    require(allocations.size >= 2) { "A split requires at least two categories" }
    require(allocations.map { it.categoryId }.distinct().size == allocations.size) {
      "Split categories must be unique"
    }
    require(allocations.all { it.amountMinor > 0 }) { "Split amounts must be positive" }
    val now = System.currentTimeMillis()
    database.execSQL("DELETE FROM transaction_allocations WHERE transaction_id = ?", arrayOf(transaction.id))
    allocations.forEachIndexed { index, allocation ->
      insertFullAllocation(
        database,
        allocation.allocationId ?: "${transaction.id}:split:$index",
        transaction.id,
        allocation.categoryId,
        allocation.amountMinor,
        AllocationSource.MANUAL,
        null,
        now,
      )
    }
    assertAllocationInvariant(database, transaction.id)
    bumpTransaction(database, transaction.id, transaction.revision, now)
    return applied(command, transaction.id, transaction.revision + 1)
  }

  private fun setBudgetAmount(
    database: SQLiteDatabase,
    command: Command.SetBudgetAmount,
  ): CommandResult {
    val payload = command.payload
    val actualRevision = monthRevision(database, payload.monthKey)
    assertExpectedRevision("budget-month:${payload.monthKey}", command.expectedRevision, actualRevision)
    val now = System.currentTimeMillis()
    val existingRevision = scalarInt(
      database,
      "SELECT revision FROM budgets WHERE month_key = ? AND category_id = ?",
      arrayOf(payload.monthKey, payload.categoryId),
    )
    if (existingRevision == null) {
      database.execSQL(
        """INSERT INTO budgets (
             month_key, category_id, amount_minor, recurring, updated_at, revision
           ) VALUES (?, ?, ?, ?, ?, 1)""",
        arrayOf(payload.monthKey, payload.categoryId, payload.amountMinor, payload.recurring.asSqlInt(), now),
      )
    } else {
      database.execSQL(
        """UPDATE budgets
           SET amount_minor = ?, recurring = ?, updated_at = ?, revision = revision + 1
           WHERE month_key = ? AND category_id = ? AND revision = ?""",
        arrayOf(
          payload.amountMinor,
          payload.recurring.asSqlInt(),
          now,
          payload.monthKey,
          payload.categoryId,
          existingRevision,
        ),
      )
    }
    val revision = bumpMonth(database, payload.monthKey, actualRevision, now)
    return applied(command, payload.monthKey, revision)
  }

  private fun clearMonthBudget(
    database: SQLiteDatabase,
    command: Command.ClearMonthBudget,
  ): CommandResult {
    val monthKey = command.payload.monthKey
    val actualRevision = monthRevision(database, monthKey)
    assertExpectedRevision("budget-month:$monthKey", command.expectedRevision, actualRevision)
    val now = System.currentTimeMillis()
    database.execSQL("DELETE FROM budgets WHERE month_key = ?", arrayOf(monthKey))
    return applied(command, monthKey, bumpMonth(database, monthKey, actualRevision, now))
  }

  private fun createCategory(
    database: SQLiteDatabase,
    command: Command.CreateCategory,
  ): CommandResult {
    val payload = command.payload
    val now = System.currentTimeMillis()

    // A category with this LABEL may already exist under a different id — the
    // device creates categories from SMS ingest before a sync ever arrives, and
    // categories_active_label_idx is unique on lower(label) where deleted_at IS
    // NULL. Treat that as the same category rather than failing: an id clash or
    // a label clash both mean "this category is already here". Without this a
    // single collision aborts an entire pulled batch, which silently blocked
    // 500 ops from ever applying.
    val existingId = database.rawQuery(
      """SELECT id FROM categories
          WHERE (id = ? OR lower(label) = lower(?)) AND deleted_at IS NULL
          LIMIT 1""",
      arrayOf(payload.categoryId, payload.label),
    ).use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }

    if (existingId != null) {
      // Idempotent no-op. Do NOT rewrite the existing row: the local one may
      // carry edits the incoming op predates.
      return applied(command, existingId, categoryRevision(database, existingId))
    }

    database.execSQL(
      """INSERT INTO categories (
           id, label, tint, parent_id, is_system, catalog_version, updated_at, revision
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)""",
      arrayOf(
        payload.categoryId,
        payload.label,
        payload.tint,
        payload.parentId,
        payload.isSystem.asSqlInt(),
        payload.catalogVersion,
        now,
      ),
    )
    return applied(command, payload.categoryId, 1)
  }

  private fun renameCategory(
    database: SQLiteDatabase,
    command: Command.RenameCategory,
  ): CommandResult {
    val revision = categoryRevision(database, command.payload.categoryId)
    assertExpectedRevision(command.payload.categoryId, command.expectedRevision, revision)

    // categories_active_label_idx is unique on lower(label) among live rows. A
    // pulled rename can collide with a category this device already created
    // from SMS ingest, and because a pulled batch runs in ONE transaction, a
    // raw UNIQUE violation aborts every remaining op. Treat a clash as a no-op:
    // the label the user wants already exists.
    val clash = database.rawQuery(
      """SELECT id FROM categories
          WHERE lower(label) = lower(?) AND id <> ? AND deleted_at IS NULL
          LIMIT 1""",
      arrayOf(command.payload.label, command.payload.categoryId),
    ).use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }
    if (clash != null) return applied(command, command.payload.categoryId, revision)

    database.execSQL(
      """UPDATE categories SET label = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ?""",
      arrayOf(command.payload.label, System.currentTimeMillis(), command.payload.categoryId, revision),
    )
    return applied(command, command.payload.categoryId, revision + 1)
  }

  private fun archiveCategory(
    database: SQLiteDatabase,
    command: Command.ArchiveCategory,
  ): CommandResult {
    val revision = categoryRevision(database, command.payload.categoryId)
    assertExpectedRevision(command.payload.categoryId, command.expectedRevision, revision)
    val now = System.currentTimeMillis()
    database.execSQL(
      """UPDATE categories SET deleted_at = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ?""",
      arrayOf(now, now, command.payload.categoryId, revision),
    )
    return applied(command, command.payload.categoryId, revision + 1)
  }

  private fun ignoreTransaction(
    database: SQLiteDatabase,
    command: Command.IgnoreTransaction,
  ): CommandResult {
    val transaction = transaction(database, command.payload.transactionId)
    assertExpectedRevision(transaction.id, command.expectedRevision, transaction.revision)
    database.execSQL(
      """UPDATE transactions SET status = 'ignored', revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ?""",
      arrayOf(System.currentTimeMillis(), transaction.id, transaction.revision),
    )
    return applied(command, transaction.id, transaction.revision + 1)
  }

  private fun setPlanType(
    database: SQLiteDatabase,
    command: Command.SetPlanType,
  ): CommandResult {
    val transaction = transaction(database, command.payload.transactionId)
    assertExpectedRevision(transaction.id, command.expectedRevision, transaction.revision)
    database.execSQL(
      """UPDATE transactions SET plan_type = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ?""",
      arrayOf(
        command.payload.planType.wireValue,
        System.currentTimeMillis(),
        transaction.id,
        transaction.revision,
      ),
    )
    return applied(command, transaction.id, transaction.revision + 1)
  }

  private fun linkRefund(
    database: SQLiteDatabase,
    command: Command.LinkRefund,
  ): CommandResult {
    val refund = transaction(database, command.payload.refundTransactionId)
    assertExpectedRevision(refund.id, command.expectedRevision, refund.revision)
    require(refund.id != command.payload.originalTransactionId) { "A transaction cannot reverse itself" }
    transaction(database, command.payload.originalTransactionId)
    database.execSQL(
      """UPDATE transactions
         SET reverses_transaction_id = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ?""",
      arrayOf(
        command.payload.originalTransactionId,
        System.currentTimeMillis(),
        refund.id,
        refund.revision,
      ),
    )
    return applied(command, refund.id, refund.revision + 1)
  }

  private fun recordSuggestion(
    database: SQLiteDatabase,
    command: Command.RecordSuggestion,
  ): CommandResult {
    val payload = command.payload
    val transaction = transaction(database, payload.transactionId)
    assertExpectedRevision(transaction.id, payload.transactionRevision, transaction.revision)
    val now = System.currentTimeMillis()
    database.execSQL(
      """INSERT INTO suggestions (
           id, transaction_id, category_id, confidence, tier, catalog_version,
           transaction_revision, created_at, revision, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)""",
      arrayOf(
        payload.suggestionId,
        transaction.id,
        payload.categoryId,
        payload.confidence,
        payload.tier,
        payload.catalogVersion,
        payload.transactionRevision,
        now,
        now,
      ),
    )
    return applied(command, payload.suggestionId, 1)
  }

  private fun resolvePossibleMatch(
    database: SQLiteDatabase,
    command: Command.ResolvePossibleMatch,
  ): CommandResult {
    val match = possibleMatch(database, command.payload.possibleMatchId)
      ?: throw RowNotFoundError(command.payload.possibleMatchId)
    assertExpectedRevision(match.id, command.expectedRevision, match.revision)
    if (match.resolved) return noop(command, match.id, match.revision, "already_resolved")
    database.execSQL(
      """UPDATE possible_matches
         SET resolved = 1, resolution = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ?""",
      arrayOf(command.payload.resolution.wireValue, System.currentTimeMillis(), match.id, match.revision),
    )
    return applied(command, match.id, match.revision + 1)
  }

  private fun processedResult(database: SQLiteDatabase, commandId: String): CommandResult? =
    querySingle(database, "SELECT result_json FROM processed_commands WHERE command_id = ?", arrayOf(commandId)) {
      CommandResult.fromJsonString(it.getString(0))
    }

  private fun metadata(database: SQLiteDatabase, key: String): String? =
    querySingle(database, "SELECT value FROM sync_metadata WHERE key = ?", arrayOf(key)) {
      it.getString(0)
    }

  private fun transaction(database: SQLiteDatabase, id: String): TransactionRow =
    querySingle(
      database,
      "SELECT id, amount_minor, counterparty_key, revision FROM transactions WHERE id = ?",
      arrayOf(id),
    ) {
      TransactionRow(it.getString(0), it.getLong(1), it.stringOrNull(2), it.getInt(3))
    } ?: throw RowNotFoundError(id)

  private fun suggestion(database: SQLiteDatabase, id: String): SuggestionRow? =
    querySingle(
      database,
      """SELECT id, transaction_id, category_id, transaction_revision, accepted_at, revision
         FROM suggestions WHERE id = ?""",
      arrayOf(id),
    ) {
      SuggestionRow(
        id = it.getString(0),
        transactionId = it.getString(1),
        categoryId = it.getString(2),
        transactionRevision = it.getInt(3),
        acceptedAt = if (it.isNull(4)) null else it.getLong(4),
        revision = it.getInt(5),
      )
    }

  private fun possibleMatch(database: SQLiteDatabase, id: String): PossibleMatchRow? =
    querySingle(
      database,
      "SELECT id, resolved, revision FROM possible_matches WHERE id = ?",
      arrayOf(id),
    ) { PossibleMatchRow(it.getString(0), it.getInt(1) == 1, it.getInt(2)) }

  private fun categoryRevision(database: SQLiteDatabase, id: String): Int =
    scalarInt(database, "SELECT revision FROM categories WHERE id = ?", arrayOf(id))
      ?: throw RowNotFoundError(id)

  private fun hasManualAllocation(database: SQLiteDatabase, transactionId: String): Boolean =
    scalarInt(
      database,
      """SELECT 1 FROM transaction_allocations
         WHERE transaction_id = ? AND source = 'manual' LIMIT 1""",
      arrayOf(transactionId),
    ) != null

  private fun replaceWithFullAllocation(
    database: SQLiteDatabase,
    allocationId: String,
    transaction: TransactionRow,
    categoryId: String,
    source: AllocationSource,
    confidence: Double?,
    now: Long,
  ) {
    database.execSQL(
      "DELETE FROM transaction_allocations WHERE transaction_id = ?",
      arrayOf(transaction.id),
    )
    insertFullAllocation(
      database,
      allocationId,
      transaction.id,
      categoryId,
      transaction.amountMinor,
      source,
      confidence,
      now,
    )
  }

  private fun insertFullAllocation(
    database: SQLiteDatabase,
    allocationId: String,
    transactionId: String,
    categoryId: String?,
    amountMinor: Long,
    source: AllocationSource,
    confidence: Double?,
    now: Long,
  ) {
    database.execSQL(
      """INSERT INTO transaction_allocations (
           id, transaction_id, category_id, amount_minor, source, confidence, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)""",
      arrayOf(allocationId, transactionId, categoryId, amountMinor, source.wireValue, confidence, now),
    )
  }

  private fun bumpTransaction(database: SQLiteDatabase, id: String, revision: Int, now: Long) {
    val changed = executeUpdateDelete(
      database,
      """UPDATE transactions SET revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ?""",
      arrayOf(now, id, revision),
    )
    if (changed != 1) throw ConflictError(id, revision, transaction(database, id).revision)
  }

  private fun assertAllocationInvariant(database: SQLiteDatabase, transactionId: String) {
    val transaction = transaction(database, transactionId)
    val total = querySingle(
      database,
      "SELECT sum(amount_minor) FROM transaction_allocations WHERE transaction_id = ?",
      arrayOf(transactionId),
    ) { if (it.isNull(0)) 0L else it.getLong(0) } ?: 0L
    if (total != transaction.amountMinor) {
      throw AllocationInvariantError(transactionId, transaction.amountMinor, total)
    }
  }

  private fun rememberCategory(
    database: SQLiteDatabase,
    transactionId: String,
    counterpartyKey: String?,
    categoryId: String,
    now: Long,
  ) {
    if (counterpartyKey == null || classifierCascade.isLowSpecificityKey(counterpartyKey)) return
    val revision = scalarInt(
      database,
      "SELECT revision FROM category_memory WHERE counterparty_key = ? AND category_id = ?",
      arrayOf(counterpartyKey, categoryId),
    )
    if (revision == null) {
      database.execSQL(
        """INSERT INTO category_memory (
             id, counterparty_key, category_id, observation_count,
             last_observed_at, provisional, updated_at
           ) VALUES (?, ?, ?, 1, ?, 0, ?)""",
        arrayOf("memory:$transactionId:$categoryId", counterpartyKey, categoryId, now, now),
      )
    } else {
      database.execSQL(
        """UPDATE category_memory
           SET observation_count = observation_count + 1,
               last_observed_at = ?, provisional = 0, updated_at = ?, revision = revision + 1
           WHERE counterparty_key = ? AND category_id = ? AND revision = ?""",
        arrayOf(now, now, counterpartyKey, categoryId, revision),
      )
    }
  }

  private fun insertClassifierSuggestion(
    database: SQLiteDatabase,
    transactionId: String,
    candidate: ClassificationCandidate,
    now: Long,
  ) {
    database.execSQL(
      """INSERT INTO suggestions (
           id, transaction_id, category_id, confidence, tier, catalog_version,
           transaction_revision, created_at, revision, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, 1, ?)""",
      arrayOf(
        "suggestion:$transactionId:${candidate.tier.wireValue}:${candidate.categoryId}",
        transactionId,
        candidate.categoryId,
        candidate.confidence,
        candidate.tier.wireValue,
        candidate.catalogVersion,
        now,
        now,
      ),
    )
  }

  private fun monthRevision(database: SQLiteDatabase, monthKey: String): Int =
    scalarInt(
      database,
      "SELECT revision FROM budget_month_revisions WHERE month_key = ?",
      arrayOf(monthKey),
    ) ?: 0

  private fun bumpMonth(database: SQLiteDatabase, monthKey: String, revision: Int, now: Long): Int {
    if (revision == 0) {
      database.execSQL(
        "INSERT INTO budget_month_revisions (month_key, revision, updated_at) VALUES (?, 1, ?)",
        arrayOf(monthKey, now),
      )
      return 1
    }
    val changed = executeUpdateDelete(
      database,
      """UPDATE budget_month_revisions SET revision = revision + 1, updated_at = ?
         WHERE month_key = ? AND revision = ?""",
      arrayOf(now, monthKey, revision),
    )
    if (changed != 1) {
      throw ConflictError("budget-month:$monthKey", revision, monthRevision(database, monthKey))
    }
    return revision + 1
  }

  private fun insertOutbox(database: SQLiteDatabase, command: Command) {
    val target = outboxTarget(command)
    database.execSQL(
      """INSERT INTO outbox (
           id, device_id, op, table_name, row_id, payload, created_at
         ) VALUES (?, 'local', ?, ?, ?, ?, ?)""",
      arrayOf(
        command.commandId,
        command.kind,
        target.first,
        target.second,
        command.toJson().toString(),
        System.currentTimeMillis(),
      ),
    )
  }

  private fun outboxTarget(command: Command): Pair<String, String> = when (command) {
    is Command.CreateTransactionFromAlert -> "transactions" to command.payload.transaction.id
    is Command.RecordSourceAlert -> "source_alerts" to command.payload.id
    is Command.UpdateAlertParseStatus -> "source_alerts" to command.payload.alertId
    is Command.AssignCategory -> "transactions" to command.payload.transactionId
    is Command.SplitTransaction -> "transactions" to command.payload.transactionId
    is Command.AcceptSuggestion -> "transactions" to command.payload.transactionId
    is Command.IgnoreTransaction -> "transactions" to command.payload.transactionId
    is Command.SetPlanType -> "transactions" to command.payload.transactionId
    is Command.LinkRefund -> "transactions" to command.payload.refundTransactionId
    is Command.SetBudgetAmount -> "budgets" to "${command.payload.monthKey}:${command.payload.categoryId}"
    is Command.ClearMonthBudget -> "budgets" to command.payload.monthKey
    is Command.CreateCategory -> "categories" to command.payload.categoryId
    is Command.RenameCategory -> "categories" to command.payload.categoryId
    is Command.ArchiveCategory -> "categories" to command.payload.categoryId
    is Command.RecordSuggestion -> "suggestions" to command.payload.suggestionId
    is Command.ResolvePossibleMatch -> "possible_matches" to command.payload.possibleMatchId
  }

  private fun applied(command: Command, entityId: String, revision: Int) =
    CommandResult.Applied(command.commandId, command.kind, entityId, revision)

  private fun noop(command: Command, entityId: String, revision: Int, reason: String) =
    CommandResult.Noop(command.commandId, command.kind, entityId, revision, reason)

  private fun assertExpectedRevision(entityId: String, expected: Int, actual: Int) {
    // SKIP_REVISION_CHECK marks a server-authoritative pulled op, which cannot
    // know this device's local revision. Everything originating on-device still
    // carries a real expectation and is checked normally.
    if (expected == SKIP_REVISION_CHECK) return
    if (expected != actual) throw ConflictError(entityId, expected, actual)
  }

  private fun scalarInt(
    database: SQLiteDatabase,
    sql: String,
    args: Array<String>,
  ): Int? = querySingle(database, sql, args) { if (it.isNull(0)) null else it.getInt(0) }

  private fun <T> querySingle(
    database: SQLiteDatabase,
    sql: String,
    args: Array<String>,
    mapper: (Cursor) -> T,
  ): T? = database.rawQuery(sql, args).use { cursor ->
    if (cursor.moveToFirst()) mapper(cursor) else null
  }

  private fun executeUpdateDelete(
    database: SQLiteDatabase,
    sql: String,
    args: Array<Any?>,
  ): Int = database.compileStatement(sql).use { statement ->
    statement.bindAll(args)
    statement.executeUpdateDelete()
  }

  private fun requireReadOnlyStatement(sql: String): String {
    val statements = SqlScript.statements(sql)
    require(statements.size == 1) { "query() accepts exactly one read-only SQL statement" }
    val statement = statements.single()
    if (NativeReadOnlySql.isRead(statement)) return statement

    val pragma = Regex("(?is)^PRAGMA\\s+([a-z_]+)(?:\\s*\\([^)]*\\))?\\s*$").matchEntire(statement)
    val readOnlyPragmas = setOf(
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
    )
    require(pragma != null && pragma.groupValues[1].lowercase() in readOnlyPragmas) {
      "query() only permits SELECT and read-only introspection PRAGMAs"
    }
    return statement
  }

  companion object {
    private const val OWNER_KEY = "owner_id"
    private const val CURSOR_KEY = "pull_cursor"
    @Volatile
    private var instance: SpendCoordinator? = null

    fun getInstance(context: Context): SpendCoordinator =
      instance ?: synchronized(this) {
        instance ?: SpendCoordinator(SpendDatabase.getInstance(context)).also { instance = it }
      }
  }

}

private data class TransactionRow(
  val id: String,
  val amountMinor: Long,
  val counterpartyKey: String?,
  val revision: Int,
)

private data class SuggestionRow(
  val id: String,
  val transactionId: String,
  val categoryId: String,
  val transactionRevision: Int,
  val acceptedAt: Long?,
  val revision: Int,
)

private data class PossibleMatchRow(val id: String, val resolved: Boolean, val revision: Int)

private fun ClassificationCandidate.allocationSource(): AllocationSource = when (tier) {
  ClassificationTier.MEMORY -> AllocationSource.LEARNED
  ClassificationTier.RULES -> AllocationSource.RULE
  ClassificationTier.SIMILARITY -> AllocationSource.SIMILARITY
}

private fun Boolean.asSqlInt(): Int = if (this) 1 else 0

private fun Cursor.stringOrNull(column: Int): String? = if (isNull(column)) null else getString(column)

private fun Cursor.toMap(): Map<String, Any?> = buildMap {
  for (column in 0 until columnCount) {
    val value = when (getType(column)) {
      Cursor.FIELD_TYPE_NULL -> null
      Cursor.FIELD_TYPE_INTEGER -> getLong(column)
      Cursor.FIELD_TYPE_FLOAT -> getDouble(column)
      Cursor.FIELD_TYPE_BLOB -> getBlob(column)
      else -> getString(column)
    }
    put(getColumnName(column), value)
  }
}

private fun SQLiteStatement.bindAll(args: Array<Any?>) {
  args.forEachIndexed { index, value ->
    val position = index + 1
    when (value) {
      null -> bindNull(position)
      is ByteArray -> bindBlob(position, value)
      is Float -> bindDouble(position, value.toDouble())
      is Double -> bindDouble(position, value)
      is Number -> bindLong(position, value.toLong())
      is Boolean -> bindLong(position, if (value) 1 else 0)
      else -> bindString(position, value.toString())
    }
  }
}
