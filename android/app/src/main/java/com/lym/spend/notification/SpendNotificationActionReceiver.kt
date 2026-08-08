package com.lym.spend.notification

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import com.lym.spend.db.AllocationSource
import com.lym.spend.db.AssignCategoryPayload
import com.lym.spend.db.Command
import com.lym.spend.db.SpendCoordinator
import java.util.concurrent.Executors

/** The only exported surface for notification category writes is this private receiver. */
class SpendNotificationActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != SpendNotificationActions.ACTION_ASSIGN) return
    val pendingResult = goAsync()
    executor.execute {
      try {
        handle(context.applicationContext, SpendCoordinator.getInstance(context.applicationContext), intent)
      } catch (error: Throwable) {
        Log.e(LOG_TAG, "Could not handle spend notification action", error)
      } finally {
        pendingResult.finish()
      }
    }
  }

  internal fun handle(context: Context, coordinator: SpendCoordinator, intent: Intent) {
    val target = parseTarget(intent.data) ?: return
    try {
      val transaction = coordinator.query(
        "SELECT id, revision FROM transactions WHERE id = ? AND deleted_at IS NULL",
        arrayOf(target.transactionId),
      ).firstOrNull() ?: return
      val categoryExists = coordinator.query(
        "SELECT id FROM categories WHERE id = ? AND deleted_at IS NULL",
        arrayOf(target.categoryId),
      ).isNotEmpty()
      if (!categoryExists) return

      val revision = (transaction["revision"] as? Number)?.toInt() ?: return
      coordinator.execute(
        Command.AssignCategory(
          commandId = "notification:assign:${target.transactionId}:${target.categoryId}",
          expectedRevision = revision,
          payload = AssignCategoryPayload(
            transactionId = target.transactionId,
            categoryId = target.categoryId,
            source = AllocationSource.MANUAL,
          ),
        ),
      )
    } catch (_: Exception) {
      // Deleted rows, stale revisions, and concurrent in-app edits are all
      // safe stale-notification outcomes. Never resurrect or crash for them.
    } finally {
      SpendNotificationManager.cancel(context, target.transactionId)
    }
  }

  private fun parseTarget(data: Uri?): Target? {
    if (data?.scheme != "spend" || data.host != "categorise") return null
    val segments = data.pathSegments
    if (segments.size != 2 || segments.any(String::isBlank)) return null
    return Target(Uri.decode(segments[0]), Uri.decode(segments[1]))
  }

  private data class Target(val transactionId: String, val categoryId: String)

  companion object {
    private const val LOG_TAG = "SpendNotificationAction"
    private val executor = Executors.newSingleThreadExecutor()
  }
}
