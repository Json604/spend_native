package com.lym.spend.notification

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import com.lym.spend.MainActivity

object SpendNotificationActions {
  const val ACTION_ASSIGN = "com.lym.spend.action.ASSIGN_CATEGORY"
  const val ACTION_REJECT = "com.lym.spend.action.REJECT_CATEGORY"

  /** Data URI is part of PendingIntent identity; extras are intentionally unused. */
  fun assignPendingIntent(context: Context, transactionId: String, categoryId: String): PendingIntent =
    PendingIntent.getBroadcast(
      context,
      0,
      assignIntent(context, transactionId, categoryId),
      PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_IMMUTABLE,
    )

  fun assignIntent(context: Context, transactionId: String, categoryId: String): Intent =
    Intent(context, SpendNotificationActionReceiver::class.java).apply {
      action = ACTION_ASSIGN
      data = Uri.parse(
        "spend://categorise/${Uri.encode(transactionId)}/${Uri.encode(categoryId)}",
      )
    }

  fun rejectPendingIntent(context: Context, transactionId: String): PendingIntent =
    PendingIntent.getBroadcast(
      context,
      0,
      Intent(context, SpendNotificationActionReceiver::class.java).apply {
        action = ACTION_REJECT
        data = Uri.parse("spend://categorise-reject/${Uri.encode(transactionId)}")
      },
      PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_IMMUTABLE,
    )

  fun splitPendingIntent(context: Context, transactionId: String): PendingIntent =
    PendingIntent.getActivity(
      context,
      transactionId.hashCode(),
      Intent(Intent.ACTION_VIEW, Uri.parse("lym://spend/split/${Uri.encode(transactionId)}")).apply {
        setClass(context, MainActivity::class.java)
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
      },
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
}
