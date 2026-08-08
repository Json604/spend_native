package com.lym.spend.sms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.provider.Telephony
import android.telephony.SubscriptionManager
import android.util.Log
import com.facebook.react.ReactApplication
import com.facebook.react.modules.core.DeviceEventManagerModule
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
import java.util.concurrent.Executors

class SpendSmsTransactionReceiver : BroadcastReceiver() {

  override fun onReceive(context: Context, intent: Intent) {
    if (Telephony.Sms.Intents.SMS_RECEIVED_ACTION != intent.action) {
      return
    }

    val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent)
    if (messages.isEmpty()) {
      return
    }

    val sender = messages.firstOrNull()?.originatingAddress
    val body = messages.joinToString(separator = "") { it.messageBody.orEmpty() }
    val timestamp = messages.firstOrNull()?.timestampMillis ?: System.currentTimeMillis()
    val subscriptionId = intent.getIntExtra(SubscriptionManager.EXTRA_SUBSCRIPTION_INDEX, -1)
    val providerMessageId = providerMessageId(sender, body, timestamp)
    val pendingResult = goAsync()
    ingestionExecutor.execute {
      try {
        val coordinator = SpendCoordinator.getInstance(context.applicationContext)
        val alert = createAlert(sender, body, timestamp, providerMessageId, subscriptionId)
        // This is intentionally committed before parsing so no SMS is lost when
        // native rules abstain or are improved in a future release.
        coordinator.execute(Command.RecordSourceAlert("sms-record:${alert.id}", alert))
        val parsed = SpendSmsAutoParser.parse(sender, body, timestamp)
        if (parsed.transaction != null) {
          coordinator.execute(createCommand(alert, timestamp, parsed.transaction))
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
        // Keep the live-React refresh signal, but native persistence above is
        // authoritative and succeeds even when there is no React context.
        mainHandler.post { emitReactEventIfPossible(context) }
      } catch (error: Throwable) {
        Log.e(LOG_TAG, "Could not persist incoming transaction SMS", error)
      } finally {
        pendingResult.finish()
      }
    }
  }

  private fun createCommand(
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
          accountingMonthKey = requireNotNull(monthFormat.get()).format(Date(parsed.occurredAtMillis)),
          amountMinor = parsed.amountMinor.toLong(),
          direction = TransactionDirection.DEBIT,
          counterpartyKey = alert.rawSender?.trim()?.lowercase(Locale.ROOT)?.takeIf(String::isNotEmpty),
          channel = "sms",
        ),
      ),
    )
  }

  private fun createAlert(
    sender: String?, body: String, timestamp: Long, providerMessageId: String, subscriptionId: Int,
  ): NewAlertPayload {
    val alertId = stableUuid("sms-alert:$providerMessageId:$subscriptionId").toString()
    return NewAlertPayload(
      id = alertId,
      rawSender = sender,
      rawBody = body,
      receivedAt = timestamp,
      providerMessageId = providerMessageId,
      subscriptionId = subscriptionId,
      parseStatus = "received",
    )
  }

  private fun providerMessageId(sender: String?, body: String, timestamp: Long): String {
    val fingerprint = stableUuid("${sender.orEmpty()}\u0000$body\u0000$timestamp")
    return "sms:$fingerprint"
  }

  private fun stableUuid(value: String): UUID =
    UUID.nameUUIDFromBytes(value.toByteArray(StandardCharsets.UTF_8))

  private fun emitReactEventIfPossible(context: Context) {
    val reactApplication = context.applicationContext as? ReactApplication ?: return
    val reactContext = reactApplication.reactNativeHost.reactInstanceManager.currentReactContext ?: return

    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("spendSmsTransactionReceived", null)
  }

  companion object {
    private const val LOG_TAG = "SpendSmsReceiver"
    private val ingestionExecutor = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())
    private val monthFormat = ThreadLocal.withInitial {
      SimpleDateFormat("yyyy-MM", Locale.ROOT)
    }
  }
}
