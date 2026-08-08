package com.lym.spend.notification

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri

object SpendNotificationActions {
  const val ACTION_ASSIGN = "com.lym.spend.action.ASSIGN_CATEGORY"

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
}
