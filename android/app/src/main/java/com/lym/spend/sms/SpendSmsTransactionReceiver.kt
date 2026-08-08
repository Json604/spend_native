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
import com.lym.spend.db.SpendCoordinator
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
    val pendingResult = goAsync()
    ingestionExecutor.execute {
      try {
        val coordinator = SpendCoordinator.getInstance(context.applicationContext)
        SpendSmsIngestor.ingest(
          context.applicationContext,
          coordinator,
          SmsIngestInput(sender, body, timestamp, subscriptionId),
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
  }
}
