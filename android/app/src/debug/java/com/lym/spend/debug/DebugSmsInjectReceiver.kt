package com.lym.spend.debug

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.lym.spend.db.SpendCoordinator
import com.lym.spend.sms.SmsIngestInput
import com.lym.spend.sms.SpendSmsIngestor
import java.util.concurrent.Executors

/** Debug-only bridge for feeding synthetic SMS into the production ingest path. */
class DebugSmsInjectReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION_INJECT_SMS) return

    val sender = intent.getStringExtra(EXTRA_SENDER) ?: return
    val body = intent.getStringExtra(EXTRA_BODY) ?: return
    val timestamp = intent.getLongExtra(EXTRA_TIMESTAMP, System.currentTimeMillis())
    val subscriptionId = if (intent.hasExtra(EXTRA_SUBSCRIPTION_ID)) {
      intent.getIntExtra(EXTRA_SUBSCRIPTION_ID, 0)
    } else {
      null
    }
    val pendingResult = goAsync()
    executor.execute {
      try {
        val appContext = context.applicationContext
        SpendSmsIngestor.ingest(
          appContext,
          SpendCoordinator.getInstance(appContext),
          SmsIngestInput(sender, body, timestamp, subscriptionId),
        )
      } catch (error: Throwable) {
        Log.e(LOG_TAG, "Could not persist injected SMS", error)
      } finally {
        pendingResult.finish()
      }
    }
  }

  companion object {
    const val ACTION_INJECT_SMS = "com.lym.spend.debug.INJECT_SMS"
    const val EXTRA_SENDER = "sender"
    const val EXTRA_BODY = "body"
    const val EXTRA_TIMESTAMP = "timestamp"
    const val EXTRA_SUBSCRIPTION_ID = "subscription_id"

    private const val LOG_TAG = "DebugSmsInjectReceiver"
    private val executor = Executors.newSingleThreadExecutor()
  }
}
