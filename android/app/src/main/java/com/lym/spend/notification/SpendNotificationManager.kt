package com.lym.spend.notification

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import androidx.core.content.ContextCompat
import com.lym.spend.MainActivity
import com.lym.spend.classify.ClassifierThresholds
import com.lym.spend.db.SpendCoordinator
import java.text.NumberFormat
import java.util.Locale

/** Posts one grouped, actionable card per uncategorised SMS transaction. */
object SpendNotificationManager {
  const val CHANNEL_ID = "spend-categorisation"
  const val GROUP_KEY = "spend-categorisation-group"
  const val NOTIFICATION_ID = 4101
  const val GROUP_SUMMARY_ID = 4102
  const val GROUP_SUMMARY_TAG = "spend-categorisation-summary"
  const val REVIEW_COUNT_PREFS = "spend-notifications"
  const val REVIEW_COUNT_KEY = "review_count"
  const val PERMISSION_PROMPTED_KEY = "permission_prompted"

  fun publishForTransaction(context: Context, coordinator: SpendCoordinator, transactionId: String) {
    val row = coordinator.query(
      """SELECT t.id, t.merchant_raw, t.amount_minor, a.category_id, a.source
         FROM transactions t
         LEFT JOIN transaction_allocations a ON a.transaction_id = t.id
         WHERE t.id = ? AND t.deleted_at IS NULL""",
      arrayOf(transactionId),
    ).firstOrNull() ?: return

    // A non-null allocation is the classifier's auto-apply output (or an
    // already-manual allocation). Either way, there is no interruption to show.
    if (row["category_id"] != null) return

    val suggestions = coordinator.query(
      """SELECT s.category_id, c.label, s.confidence
         FROM suggestions s
         JOIN categories c ON c.id = s.category_id AND c.deleted_at IS NULL
         WHERE s.transaction_id = ?
         ORDER BY s.confidence DESC, c.label
         LIMIT ?""",
      arrayOf(transactionId, ClassifierThresholds.NOTIFICATION_SUGGESTION_LIMIT.toString()),
    ).mapNotNull { suggestion ->
      val categoryId = suggestion["category_id"]?.toString() ?: return@mapNotNull null
      val label = suggestion["label"]?.toString() ?: return@mapNotNull null
      val confidence = (suggestion["confidence"] as? Number)?.toDouble() ?: 0.0
      Suggestion(categoryId, label, confidence)
    }

    val fallbackCategories = coordinator.query(
      """SELECT id, label
         FROM categories
         WHERE deleted_at IS NULL AND id NOT IN ('uncategorized', 'needs-review')
         ORDER BY label
         LIMIT ?""",
      arrayOf(ClassifierThresholds.NOTIFICATION_SUGGESTION_LIMIT.toString()),
    ).mapNotNull { category ->
      val id = category["id"]?.toString() ?: return@mapNotNull null
      val label = category["label"]?.toString() ?: return@mapNotNull null
      Suggestion(id, label, 0.0)
    }
    val choices = (suggestions + fallbackCategories).distinctBy { it.categoryId }
      .take(ClassifierThresholds.NOTIFICATION_SUGGESTION_LIMIT)

    val manager = context.getSystemService(NotificationManager::class.java)
    ensureChannel(manager)
    if (!canPost(context)) {
      recordReviewNeeded(context)
      return
    }

    val notification = notificationBuilder(context, row, choices)
    try {
      manager.notify(transactionId, NOTIFICATION_ID, notification.build())
      manager.notify(GROUP_SUMMARY_TAG, GROUP_SUMMARY_ID, summaryNotification(context))
    } catch (_: SecurityException) {
      // Permission can be revoked between the check and notify(). Keep the
      // durable review count rather than pretending the row was surfaced.
      recordReviewNeeded(context)
    }
  }

  fun cancel(context: Context, transactionId: String) {
    context.getSystemService(NotificationManager::class.java)
      .cancel(transactionId, NOTIFICATION_ID)
  }

  fun notificationReviewCount(context: Context): Int = context
    .getSharedPreferences(REVIEW_COUNT_PREFS, Context.MODE_PRIVATE)
    .getInt(REVIEW_COUNT_KEY, 0)

  fun clearNotificationReviewCount(context: Context) {
    context.getSharedPreferences(REVIEW_COUNT_PREFS, Context.MODE_PRIVATE)
      .edit()
      .putInt(REVIEW_COUNT_KEY, 0)
      .apply()
  }

  fun markPermissionPrompted(context: Context) {
    context.getSharedPreferences(REVIEW_COUNT_PREFS, Context.MODE_PRIVATE)
      .edit()
      .putBoolean(PERMISSION_PROMPTED_KEY, true)
      .apply()
  }

  fun permissionPrompted(context: Context): Boolean = context
    .getSharedPreferences(REVIEW_COUNT_PREFS, Context.MODE_PRIVATE)
    .getBoolean(PERMISSION_PROMPTED_KEY, false)

  private fun recordReviewNeeded(context: Context) {
    val prefs = context.getSharedPreferences(REVIEW_COUNT_PREFS, Context.MODE_PRIVATE)
    prefs.edit().putInt(REVIEW_COUNT_KEY, prefs.getInt(REVIEW_COUNT_KEY, 0) + 1).apply()
  }

  private fun canPost(context: Context): Boolean = Build.VERSION.SDK_INT < 33 ||
    ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
    PackageManager.PERMISSION_GRANTED

  private fun ensureChannel(manager: NotificationManager) {
    if (Build.VERSION.SDK_INT < 26) return
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "Spend categorisation", NotificationManager.IMPORTANCE_DEFAULT).apply {
        description = "Choose a category for new spending"
        enableLights(true)
        lightColor = Color.YELLOW
      },
    )
  }

  private fun notificationBuilder(
    context: Context,
    row: Map<String, Any?>,
    choices: List<Suggestion>,
  ): Notification.Builder {
    val merchant = row["merchant_raw"]?.toString()?.takeIf(String::isNotBlank) ?: "New spend"
    val amount = (row["amount_minor"] as? Number)?.toLong() ?: 0L
    val title = "Categorise ${formatAmount(amount)}"
    val midConfidence = choices.firstOrNull()?.confidence ?: 0.0
    val prompt = if (midConfidence >= ClassifierThresholds.NOTIFICATION_MID_CONFIDENCE) {
      "Likely ${choices.first().label} · $merchant"
    } else {
      "Choose a category · $merchant"
    }
    val builder = baseBuilder(context)
      .setContentTitle(title)
      .setContentText(prompt)
      .setGroup(GROUP_KEY)
      .setAutoCancel(true)
      .setOnlyAlertOnce(true)
      .setContentIntent(morePendingIntent(context, row["id"].toString()))

    // Android allows three actions, but More… is deliberately reserved so
    // there are always two direct guesses and one escape hatch.
    choices.take(2).forEach { choice ->
      builder.addAction(
        Notification.Action.Builder(
          Icon.createWithResource(context, android.R.drawable.ic_menu_add),
          choice.label,
          SpendNotificationActions.assignPendingIntent(context, row["id"].toString(), choice.categoryId),
        ).build(),
      )
    }
    builder.addAction(
      Notification.Action.Builder(
        Icon.createWithResource(context, android.R.drawable.ic_menu_edit),
        "More…",
        morePendingIntent(context, row["id"].toString()),
      ).build(),
    )
    return builder
  }

  private fun summaryNotification(context: Context): Notification = baseBuilder(context)
    .setContentTitle("Spend categorisation")
    .setContentText("Choose categories for recent spending")
    .setGroup(GROUP_KEY)
    .setGroupSummary(true)
    .setOnlyAlertOnce(true)
    .build()

  private fun baseBuilder(context: Context): Notification.Builder = if (Build.VERSION.SDK_INT >= 26) {
    Notification.Builder(context, CHANNEL_ID).setSmallIcon(android.R.drawable.ic_menu_info_details)
  } else {
    Notification.Builder(context).setSmallIcon(android.R.drawable.ic_menu_info_details)
  }

  private fun morePendingIntent(context: Context, transactionId: String): PendingIntent =
    PendingIntent.getActivity(
      context,
      0,
      Intent(context, MainActivity::class.java).apply {
        action = Intent.ACTION_VIEW
        data = Uri.parse("spend://categorise/${Uri.encode(transactionId)}")
      },
      PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_IMMUTABLE,
    )

  private fun formatAmount(amountMinor: Long): String = NumberFormat.getCurrencyInstance(Locale("en", "IN"))
    .format(amountMinor / 100.0)

  private data class Suggestion(val categoryId: String, val label: String, val confidence: Double)
}
