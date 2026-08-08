package com.lym.spend.sms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.provider.Telephony
import android.util.Log
import com.facebook.react.ReactApplication
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.lym.spend.db.Command
import com.lym.spend.db.CreateTransactionFromAlertPayload
import com.lym.spend.db.NewAlertPayload
import com.lym.spend.db.NewTransactionPayload
import com.lym.spend.db.SpendCoordinator
import com.lym.spend.db.TransactionDirection
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
    val parsed = SpendSmsAutoParser.parse(sender, body, timestamp) ?: return
    val pendingResult = goAsync()
    ingestionExecutor.execute {
      try {
        SpendCoordinator.getInstance(context).execute(
          createCommand(sender, body, timestamp, parsed),
        )
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
    sender: String?,
    body: String,
    timestamp: Long,
    parsed: ParsedIncomingSmsTransaction,
  ): Command.CreateTransactionFromAlert {
    val fingerprint = stableUuid("${sender.orEmpty()}\u0000$body\u0000$timestamp")
    val transactionId = stableUuid("sms-transaction:$fingerprint").toString()
    val alertId = stableUuid("sms-alert:$fingerprint").toString()
    return Command.CreateTransactionFromAlert(
      commandId = stableUuid("sms-command:$fingerprint").toString(),
      payload = CreateTransactionFromAlertPayload(
        alert = NewAlertPayload(
          id = alertId,
          rawSender = sender,
          rawBody = body,
          receivedAt = timestamp,
          providerMessageId = "sms:$fingerprint",
        ),
        transaction = NewTransactionPayload(
          id = transactionId,
          occurredAt = parsed.occurredAtMillis,
          receivedAt = timestamp,
          accountingMonthKey = requireNotNull(monthFormat.get()).format(Date(parsed.occurredAtMillis)),
          amountMinor = parsed.amountMinor.toLong(),
          direction = TransactionDirection.DEBIT,
          counterpartyKey = sender?.trim()?.lowercase(Locale.ROOT)?.takeIf(String::isNotEmpty),
          channel = "sms",
        ),
      ),
    )
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
