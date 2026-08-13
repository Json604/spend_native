package com.lym.spend.sms

import android.Manifest
import android.content.pm.PackageManager
import android.database.Cursor
import android.provider.Telephony
import android.util.Log
import androidx.core.content.ContextCompat
import com.lym.spend.db.SpendCoordinator
import com.lym.spend.notification.SpendNotificationManager
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.concurrent.Executors

class SpendSmsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  private val executor = Executors.newSingleThreadExecutor()

  override fun getName(): String = MODULE_NAME

  @ReactMethod
  fun getCapabilities(promise: Promise) {
    val payload = Arguments.createMap().apply {
      putBoolean("isAndroid", true)
      putBoolean("canReadInbox", hasReadSmsPermission())
      putBoolean("canReceiveMessages", hasReceiveSmsPermission())
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

  @ReactMethod
  fun backfillInboxSince(sinceTimestamp: Double, promise: Promise) {
    if (!hasReadSmsPermission()) {
      promise.reject("E_SMS_PERMISSION", "READ_SMS permission is not granted.")
      return
    }

    executor.execute {
      try {
        val coordinator = SpendCoordinator.getInstance(reactApplicationContext)
        val inputs = readInboxForBackfill(sinceTimestamp)
        var attempted = 0
        var parsed = 0
        for (input in inputs) {
          attempted += 1
          try {
            val result = SpendSmsIngestor.ingest(reactApplicationContext, coordinator, input)
            if (result.parseResult.transaction != null) {
              parsed += 1
            }
          } catch (error: Throwable) {
            Log.e(LOG_TAG, "Could not ingest inbox SMS", error)
          }
        }

        promise.resolve(
            Arguments.createMap().apply {
              putInt("attempted", attempted)
              putInt("parsed", parsed)
            },
        )
      } catch (error: Exception) {
        promise.reject("E_SMS_QUERY_FAILED", error.message, error)
      }
    }
  }

  private fun listInboxMessagesInternal(limit: Int, sinceTimestamp: Double, promise: Promise) {
    if (!hasReadSmsPermission()) {
      promise.reject("E_SMS_PERMISSION", "READ_SMS permission is not granted.")
      return
    }

    val messages = Arguments.createArray()

    try {
      val cursor = queryInboxMessages(sinceTimestamp, limit, LIST_PROJECTION)

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

  private fun readInboxForBackfill(sinceTimestamp: Double): List<SmsIngestInput> {
    return queryInboxMessages(sinceTimestamp, 0, BACKFILL_PROJECTION)?.use { cursor ->
      val addressIndex = cursor.getColumnIndex(Telephony.Sms.ADDRESS)
      val bodyIndex = cursor.getColumnIndex(Telephony.Sms.BODY)
      val dateIndex = cursor.getColumnIndex(Telephony.Sms.DATE)
      val dateSentIndex = cursor.getColumnIndex(Telephony.Sms.DATE_SENT)
      val subscriptionIndex = cursor.getColumnIndex(Telephony.Sms.SUBSCRIPTION_ID)
      buildList {
        while (cursor.moveToNext()) {
          val dateReceived = if (dateIndex >= 0) cursor.getLong(dateIndex) else 0L
          val dateSent =
              if (dateSentIndex >= 0 && !cursor.isNull(dateSentIndex)) {
                cursor.getLong(dateSentIndex)
              } else {
                0L
              }
          add(
              SmsIngestInput(
                  sender = if (addressIndex >= 0) cursor.getString(addressIndex) else null,
                  body = if (bodyIndex >= 0) cursor.getString(bodyIndex).orEmpty() else "",
                  // DATE_SENT is SmsMessage.timestampMillis; DATE is device receive time.
                  timestamp = if (dateSent > 0L) dateSent else dateReceived,
                  subscriptionId =
                      if (subscriptionIndex >= 0 && !cursor.isNull(subscriptionIndex)) {
                        cursor.getInt(subscriptionIndex)
                      } else {
                        null
                      },
                  providerMessageId = null,
              ),
          )
        }
      }
    } ?: emptyList()
  }

  private fun queryInboxMessages(
    sinceTimestamp: Double,
    limit: Int,
    projection: Array<String>,
  ): Cursor? {
    val (selection, selectionArgs) = inboxSelection(sinceTimestamp)
    val sortOrder =
        if (limit > 0) {
          "${Telephony.Sms.DEFAULT_SORT_ORDER} LIMIT ${limit.coerceAtMost(5000)}"
        } else {
          Telephony.Sms.DEFAULT_SORT_ORDER
        }
    return try {
      reactApplicationContext.contentResolver.query(
          Telephony.Sms.Inbox.CONTENT_URI,
          projection,
          selection,
          selectionArgs,
          sortOrder,
      )
    } catch (error: IllegalArgumentException) {
      // OEM providers may reject only one optional column. Retry each drop
      // independently so DATE_SENT is not discarded when SUBSCRIPTION_ID is
      // the only missing column.
      queryInboxDroppingOptionalColumns(projection, selection, selectionArgs, sortOrder, error)
    }
  }

  private fun queryInboxDroppingOptionalColumns(
    projection: Array<String>,
    selection: String?,
    selectionArgs: Array<String>?,
    sortOrder: String,
    firstError: IllegalArgumentException,
  ): Cursor? {
    val singleDrops =
        OPTIONAL_INBOX_COLUMNS.mapNotNull { column ->
          if (column in projection) projection.filter { it != column } else null
        }
    val withoutOptional = projection.filter { it !in OPTIONAL_INBOX_COLUMNS }
    val retries = (singleDrops + listOf(withoutOptional)).distinct()
    var lastError = firstError
    for (candidate in retries) {
      if (candidate.isEmpty() || candidate.toTypedArray().contentEquals(projection)) continue
      try {
        return reactApplicationContext.contentResolver.query(
            Telephony.Sms.Inbox.CONTENT_URI,
            candidate.toTypedArray(),
            selection,
            selectionArgs,
            sortOrder,
        )
      } catch (retry: IllegalArgumentException) {
        lastError = retry
      }
    }
    throw lastError
  }

  private fun inboxSelection(sinceTimestamp: Double): Pair<String?, Array<String>?> {
    val selectionParts = ArrayList<String>()
    val selectionArgs = ArrayList<String>()
    INBOX_KEYWORD_TOKENS.forEach { token ->
      selectionParts.add("lower(${Telephony.Sms.ADDRESS}) LIKE ?")
      selectionArgs.add("%$token%")
      selectionParts.add("lower(${Telephony.Sms.BODY}) LIKE ?")
      selectionArgs.add("%$token%")
    }
    val keywordSelection =
        if (selectionParts.isEmpty()) null else "(${selectionParts.joinToString(" OR ")})"
    val selection =
        if (sinceTimestamp > 0.0) {
          val sinceClause = "${Telephony.Sms.DATE} >= ?"
          selectionArgs.add(sinceTimestamp.toLong().toString())
          if (keywordSelection != null) "$keywordSelection AND $sinceClause" else sinceClause
        } else {
          keywordSelection
        }
    return selection to if (selectionArgs.isEmpty()) null else selectionArgs.toTypedArray()
  }

  private fun hasReadSmsPermission(): Boolean {
    return ContextCompat.checkSelfPermission(
        reactApplicationContext,
        Manifest.permission.READ_SMS,
    ) == PackageManager.PERMISSION_GRANTED
  }

  private fun hasReceiveSmsPermission(): Boolean {
    return ContextCompat.checkSelfPermission(
        reactApplicationContext,
        Manifest.permission.RECEIVE_SMS,
    ) == PackageManager.PERMISSION_GRANTED
  }

  companion object {
    const val MODULE_NAME = "SpendSmsModule"
    private const val LOG_TAG = "SpendSmsModule"
    private val LIST_PROJECTION =
        arrayOf(
            Telephony.Sms._ID,
            Telephony.Sms.ADDRESS,
            Telephony.Sms.BODY,
            Telephony.Sms.DATE,
            Telephony.Sms.TYPE,
            Telephony.Sms.THREAD_ID,
            Telephony.Sms.READ,
        )
    private val BACKFILL_PROJECTION =
        arrayOf(
            Telephony.Sms.ADDRESS,
            Telephony.Sms.BODY,
            Telephony.Sms.DATE,
            Telephony.Sms.DATE_SENT,
            Telephony.Sms.SUBSCRIPTION_ID,
        )
    private val OPTIONAL_INBOX_COLUMNS =
        listOf(Telephony.Sms.DATE_SENT, Telephony.Sms.SUBSCRIPTION_ID)
    private val INBOX_KEYWORD_TOKENS =
        listOf(
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
  }
}
