package com.lym.spend.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.widget.RemoteViews
import com.lym.spend.MainActivity
import com.lym.spend.R

class SpendWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        // Just re-render from the SharedPreferences cache. The JS app is the
        // sole writer of that cache (via SpendWidgetBridgeModule).
        appWidgetIds.forEach { updateWidget(context, appWidgetManager, it) }
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == ACTION_REFRESH) {
            refreshAllWidgets(context)
        }
    }

    companion object {
        const val ACTION_REFRESH = "com.lym.spend.widget.ACTION_REFRESH"

        fun refreshAllWidgets(context: Context) {
            val mgr = AppWidgetManager.getInstance(context)
            val ids = mgr.getAppWidgetIds(ComponentName(context, SpendWidgetProvider::class.java))
            ids.forEach { updateWidget(context, mgr, it) }
        }

        private fun updateWidget(
            context: Context,
            appWidgetManager: AppWidgetManager,
            appWidgetId: Int,
        ) {
            val snapshot = SpendWidgetStorage.readSnapshot(context)
            val isCompact = shouldUseCompactLayout(appWidgetManager, appWidgetId)
            val views = RemoteViews(
                context.packageName,
                if (isCompact) R.layout.spend_widget_small else R.layout.spend_widget,
            )

            // Tap on widget body opens the app
            val launchIntent = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            }
            val launchPending = PendingIntent.getActivity(
                context, appWidgetId, launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            views.setOnClickPendingIntent(R.id.widget_root, launchPending)

            // ↻ refresh button → broadcast back to ourselves
            val refreshIntent = Intent(context, SpendWidgetProvider::class.java).apply {
                action = ACTION_REFRESH
            }
            val refreshPending = PendingIntent.getBroadcast(
                context, appWidgetId, refreshIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            views.setOnClickPendingIntent(R.id.widget_refresh, refreshPending)

            if (!isCompact) {
                // + button → also launch app (no deep link wired in spend-expo yet)
                views.setOnClickPendingIntent(R.id.widget_add, launchPending)

                // Categories ListView remote adapter
                val serviceIntent = Intent(context, SpendWidgetCategoriesService::class.java).apply {
                    putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
                    data = Uri.parse("spend-widget://content/$appWidgetId")
                }
                views.setRemoteAdapter(R.id.widget_categories_list, serviceIntent)

                // Pending intent template so each row falls through to MainActivity
                val template = Intent(context, MainActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                }
                val templatePending = PendingIntent.getActivity(
                    context, appWidgetId * 10 + 3, template,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
                )
                views.setPendingIntentTemplate(R.id.widget_categories_list, templatePending)
            } else {
                val budget = snapshot.monthBudgetMinor
                val caption = if (budget != null && budget > 0) {
                    "${formatRupees(snapshot.monthSpentMinor)} of ${formatRupees(budget)}"
                } else {
                    "Tap + to set budget"
                }
                views.setTextViewText(R.id.widget_budget_text, caption)
                views.setTextViewText(R.id.widget_total, extractAmount(snapshot.todayFormatted))
            }

            appWidgetManager.updateAppWidget(appWidgetId, views)
            if (!isCompact) {
                appWidgetManager.notifyAppWidgetViewDataChanged(
                    appWidgetId, R.id.widget_categories_list,
                )
            }
        }

        private fun extractAmount(formatted: String) =
            formatted.replace("Rs", "", ignoreCase = true).replace("₹", "").trim()

        private fun formatRupees(amountMinor: Int): String {
            val whole = amountMinor / 100
            return "₹" + String.format("%,d", whole)
        }

        private fun shouldUseCompactLayout(mgr: AppWidgetManager, id: Int): Boolean {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.JELLY_BEAN) return false
            val opts = mgr.getAppWidgetOptions(id)
            val w = opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0)
            val h = opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0)
            return w < 220 || h < 140
        }
    }
}
