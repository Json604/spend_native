package com.lym.spend.sms

import android.content.Context
import com.lym.spend.db.Command
import com.lym.spend.db.CreateTransactionFromAlertPayload
import com.lym.spend.db.NewAlertPayload
import com.lym.spend.db.NewTransactionPayload
import com.lym.spend.db.SpendCoordinator
import com.lym.spend.db.TransactionDirection
import com.lym.spend.db.UpdateAlertParseStatusPayload
import com.lym.spend.widget.SpendWidgetProvider
import com.lym.spend.widget.SpendWidgetStorage
import java.nio.charset.StandardCharsets
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

data class SmsIngestInput(
  val sender: String?,
  val body: String,
  val timestamp: Long,
  val subscriptionId: Int? = null,
  val providerMessageId: String? = null,
)

data class SmsIngestResult(
  val alert: NewAlertPayload,
  val parseResult: SmsParseResult,
)

/** The single native ingest path shared by real and debug SMS receivers. */
object SpendSmsIngestor {
  fun ingest(
    context: Context,
    coordinator: SpendCoordinator,
    input: SmsIngestInput,
  ): SmsIngestResult {
    val providerMessageId = input.providerMessageId ?: providerMessageId(input)
    val alert = createAlert(input, providerMessageId)

    // Commit the raw alert before parsing so abstained messages are retained for
    // later reprocessing and parser improvements.
    coordinator.execute(Command.RecordSourceAlert("sms-record:${alert.id}", alert))
    val parsed = SpendSmsAutoParser.parse(input.sender, input.body, input.timestamp)
    if (parsed.transaction != null) {
      coordinator.execute(createTransactionCommand(alert, input.timestamp, parsed.transaction))
      SpendWidgetStorage.refreshFromDatabase(context.applicationContext, coordinator)
      SpendWidgetProvider.refreshAllWidgets(context.applicationContext)
    } else {
      coordinator.execute(
        Command.UpdateAlertParseStatus(
          commandId = "sms-status:${alert.id}:${parsed.parseStatus}",
          payload = UpdateAlertParseStatusPayload(alert.id, parsed.parseStatus),
        ),
      )
    }

    return SmsIngestResult(alert, parsed)
  }

  private fun createTransactionCommand(
    alert: NewAlertPayload,
    timestamp: Long,
    parsed: ParsedIncomingSmsTransaction,
  ): Command.CreateTransactionFromAlert {
    val transactionId = stableUuid("sms-transaction:${alert.id}").toString()
    return Command.CreateTransactionFromAlert(
      commandId = "sms-transaction:${alert.id}",
      payload = CreateTransactionFromAlertPayload(
        alert = alert.copy(parseStatus = "parsed"),
        transaction = NewTransactionPayload(
          id = transactionId,
          occurredAt = parsed.occurredAtMillis,
          receivedAt = timestamp,
          accountingMonthKey = monthFormat.get().format(Date(parsed.occurredAtMillis)),
          amountMinor = parsed.amountMinor,
          direction = TransactionDirection.DEBIT,
          counterpartyKey = alert.rawSender?.trim()?.lowercase(Locale.ROOT)?.takeIf(String::isNotEmpty),
          channel = "sms",
        ),
      ),
    )
  }

  private fun createAlert(input: SmsIngestInput, providerMessageId: String): NewAlertPayload {
    val alertId = stableUuid("sms-alert:$providerMessageId:${input.subscriptionId ?: ""}").toString()
    return NewAlertPayload(
      id = alertId,
      rawSender = input.sender,
      rawBody = input.body,
      receivedAt = input.timestamp,
      providerMessageId = providerMessageId,
      subscriptionId = input.subscriptionId,
      parseStatus = "received",
    )
  }

  private fun providerMessageId(input: SmsIngestInput): String {
    val fingerprint = stableUuid(
      "${input.sender.orEmpty()}\u0000${input.body}\u0000${input.timestamp}",
    )
    return "sms:$fingerprint"
  }

  private fun stableUuid(value: String): UUID =
    UUID.nameUUIDFromBytes(value.toByteArray(StandardCharsets.UTF_8))

  private val monthFormat = ThreadLocal.withInitial {
    SimpleDateFormat("yyyy-MM", Locale.ROOT)
  }
}
