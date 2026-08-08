package com.lym.spend.sms

import android.Manifest
import android.content.pm.PackageManager
import android.provider.Telephony
import androidx.core.content.ContextCompat
import com.lym.spend.notification.SpendNotificationManager
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class SpendSmsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = MODULE_NAME

  @ReactMethod
  fun getCapabilities(promise: Promise) {
    val payload = Arguments.createMap().apply {
      putBoolean("isAndroid", true)
      putBoolean("canReadInbox", hasReadSmsPermission())
      putBoolean("supportsInboxQueries", true)
      putString("moduleName", MODULE_NAME)
    }

    promise.resolve(payload)
  }

  @ReactMethod
  fun getNotificationReviewCount(promise: Promise) {
    promise.resolve(SpendNotificationManager.notificationReviewCount(reactApplicationContext))
  }

  @ReactMethod
  fun clearNotificationReviewCount(promise: Promise) {
    SpendNotificationManager.clearNotificationReviewCount(reactApplicationContext)
    promise.resolve(null)
  }

  @ReactMethod
  fun listInboxMessages(limit: Int, promise: Promise) {
    listInboxMessagesInternal(limit, 0.0, promise)
  }

  @ReactMethod
  fun listInboxMessagesSince(sinceTimestamp: Double, promise: Promise) {
    listInboxMessagesInternal(0, sinceTimestamp, promise)
  }

  private fun listInboxMessagesInternal(limit: Int, sinceTimestamp: Double, promise: Promise) {
    if (!hasReadSmsPermission()) {
      promise.reject("E_SMS_PERMISSION", "READ_SMS permission is not granted.")
      return
    }

    val resolver = reactApplicationContext.contentResolver
    val messages = Arguments.createArray()
    val sortOrder =
        if (limit > 0) {
          "${Telephony.Sms.DEFAULT_SORT_ORDER} LIMIT ${limit.coerceAtMost(5000)}"
        } else {
          Telephony.Sms.DEFAULT_SORT_ORDER
        }

    try {
      // Filter hard at the source: returning thousands of full SMS bodies to JS can stall the bridge.
      // This keeps the scan fast and focuses on transaction-like messages (Kotak/banks/UPI/card/txn keywords).
      val selectionTokens = listOf(
          "kotak",
          "upi",
          "card",
          "debited",
          "debit",
          "spent",
          "paid",
          "purchase",
          "txn",
          "transaction",
          "imps",
          "neft",
          "rtgs",
          "pos",
          "autopay",
          "mandate",
          "credited",
          "credit",
          "received",
          "transfer",
          "bank",
      )
      val selectionParts = ArrayList<String>()
      val selectionArgs = ArrayList<String>()

      selectionTokens.forEach { token ->
        selectionParts.add("lower(${Telephony.Sms.ADDRESS}) LIKE ?")
        selectionArgs.add("%$token%")
        selectionParts.add("lower(${Telephony.Sms.BODY}) LIKE ?")
        selectionArgs.add("%$token%")
      }

      val keywordSelection =
          if (selectionParts.isEmpty()) null else "(${selectionParts.joinToString(" OR ")})"
      val selection = if (sinceTimestamp > 0.0) {
        val sinceClause = "${Telephony.Sms.DATE} >= ?"
        selectionArgs.add(sinceTimestamp.toLong().toString())
        if (keywordSelection != null) "$keywordSelection AND $sinceClause" else sinceClause
      } else {
        keywordSelection
      }

      val cursor =
          resolver.query(
              Telephony.Sms.Inbox.CONTENT_URI,
              arrayOf(
                  Telephony.Sms._ID,
                  Telephony.Sms.ADDRESS,
                  Telephony.Sms.BODY,
                  Telephony.Sms.DATE,
                  Telephony.Sms.TYPE,
                  Telephony.Sms.THREAD_ID,
                  Telephony.Sms.READ,
              ),
              selection,
              if (selectionArgs.isEmpty()) null else selectionArgs.toTypedArray(),
              sortOrder,
          )

      cursor?.use {
        val idIndex = it.getColumnIndex(Telephony.Sms._ID)
        val addressIndex = it.getColumnIndex(Telephony.Sms.ADDRESS)
        val bodyIndex = it.getColumnIndex(Telephony.Sms.BODY)
        val dateIndex = it.getColumnIndex(Telephony.Sms.DATE)
        val typeIndex = it.getColumnIndex(Telephony.Sms.TYPE)
        val threadIdIndex = it.getColumnIndex(Telephony.Sms.THREAD_ID)
        val readIndex = it.getColumnIndex(Telephony.Sms.READ)

        while (it.moveToNext()) {
          val item = Arguments.createMap().apply {
            if (idIndex >= 0) {
              putString("id", it.getString(idIndex))
            }
            putString("address", if (addressIndex >= 0) it.getString(addressIndex) else null)
            putString("body", if (bodyIndex >= 0) it.getString(bodyIndex) else null)
            putDouble("timestamp", if (dateIndex >= 0) it.getLong(dateIndex).toDouble() else 0.0)
            putInt("type", if (typeIndex >= 0) it.getInt(typeIndex) else 0)
            putString(
                "threadId",
                if (threadIdIndex >= 0) it.getString(threadIdIndex) else null,
            )
            putBoolean("read", readIndex >= 0 && it.getInt(readIndex) == 1)
          }

          messages.pushMap(item)
        }
      }

      promise.resolve(messages)
    } catch (error: Exception) {
      promise.reject("E_SMS_QUERY_FAILED", error.message, error)
    }
  }

  // Deliberately a no-op: there is no native pending-refresh storage. The
  // BroadcastReceiver emits a JS event directly and SpendProvider refreshes
  // from that signal plus AppState.
  @ReactMethod
  fun consumePendingRefreshFlag(promise: Promise) {
    promise.resolve(false)
  }

  // Deliberately no-ops: ignore-tracking lives in the JS repository
  // (externalFingerprint dedupe) rather than native SharedPreferences.
  @ReactMethod
  fun markIgnored(
    dedupeKey: String,
    amountMinor: Int,
    occurredAtMillis: Double,
    categoryLabel: String?,
    promise: Promise,
  ) {
    promise.resolve(null)
  }

  @ReactMethod
  fun unmarkIgnored(dedupeKey: String, promise: Promise) {
    promise.resolve(null)
  }

  private fun hasReadSmsPermission(): Boolean {
    return ContextCompat.checkSelfPermission(
        reactApplicationContext,
        Manifest.permission.READ_SMS,
    ) == PackageManager.PERMISSION_GRANTED
  }

  companion object {
    const val MODULE_NAME = "SpendSmsModule"
  }
}
