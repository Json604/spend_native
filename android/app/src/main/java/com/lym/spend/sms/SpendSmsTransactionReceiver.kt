package com.lym.spend.sms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import com.facebook.react.ReactApplication
import com.facebook.react.modules.core.DeviceEventManagerModule

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
    // Parse here only to short-circuit the JS event when the SMS clearly isn't
    // a debit alert. The real ingestion path is JS-side: SpendProvider re-scans
    // today's inbox on the event, builds transactions, and persists to Supabase
    // + AsyncStorage + the widget snapshot.
    SpendSmsAutoParser.parse(sender, body, timestamp) ?: return

    emitReactEventIfPossible(context)
  }

  private fun emitReactEventIfPossible(context: Context) {
    val reactApplication = context.applicationContext as? ReactApplication ?: return
    val reactContext = reactApplication.reactNativeHost.reactInstanceManager.currentReactContext ?: return

    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("spendSmsTransactionReceived", null)
  }
}
