package com.lym.spend.widget

import android.content.Context
import android.content.Intent
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import com.lym.spend.R

class SpendWidgetCategoriesService : RemoteViewsService() {

    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory =
        ContentFactory(applicationContext)

    private class ContentFactory(private val context: Context) : RemoteViewsFactory {

        private data class HeroRow(val totalText: String)
        private data class BudgetRow(val line: String, val pct: Int)
        private data class PillRow(val label: String)

        private var rows: List<Any> = emptyList()

        override fun onCreate() { rebuild() }
        override fun onDataSetChanged() { rebuild() }
        override fun onDestroy() { rows = emptyList() }

        private fun rebuild() {
            val s = SpendWidgetStorage.readSnapshot(context)
            val out = mutableListOf<Any>()
            out.add(HeroRow(extractAmount(s.todayFormatted)))

            val budget = s.monthBudgetMinor
            if (budget != null && budget > 0) {
                val pct = ((s.monthSpentMinor.toDouble() / budget.toDouble())
                    .coerceIn(0.0, 1.0) * 100).toInt()
                out.add(BudgetRow(
                    line = "${formatRupees(s.monthSpentMinor)} of ${formatRupees(budget)} · ${s.daysRemainingInMonth} days left",
                    pct = pct,
                ))
            } else {
                val monthName = s.monthLabel.split(" ").firstOrNull() ?: "this month"
                out.add(PillRow(label = "Set $monthName budget →"))
            }

            // Today's spends, not the month's category totals: the widget answers
            // "what have I spent today", which is the question a home screen is for.
            out.addAll(s.todaySpends)
            rows = out
        }

        override fun getCount(): Int = rows.size

        override fun getViewAt(position: Int): RemoteViews {
            val fillIntent = Intent()
            return when (val row = rows.getOrNull(position)) {
                is HeroRow -> {
                    val v = RemoteViews(context.packageName, R.layout.spend_widget_hero_item)
                    v.setTextViewText(R.id.hero_item_total, row.totalText)
                    v.setOnClickFillInIntent(R.id.hero_item_root, fillIntent)
                    v
                }
                is BudgetRow -> {
                    val v = RemoteViews(context.packageName, R.layout.spend_widget_budget_item)
                    v.setTextViewText(R.id.budget_item_text, row.line)
                    v.setProgressBar(R.id.budget_item_bar, 100, row.pct, false)
                    v.setOnClickFillInIntent(R.id.budget_item_root, fillIntent)
                    v
                }
                is PillRow -> {
                    val v = RemoteViews(context.packageName, R.layout.spend_widget_pill_item)
                    v.setTextViewText(R.id.pill_item_text, row.label)
                    v.setOnClickFillInIntent(R.id.pill_item_root, fillIntent)
                    v
                }
                is SpendWidgetStorage.CategoryRow -> {
                    val v = RemoteViews(context.packageName, R.layout.spend_widget_category_item)
                    v.setTextViewText(R.id.widget_category_item_label, row.label)
                    v.setTextViewText(R.id.widget_category_item_amount, row.amountLabel)
                    v.setOnClickFillInIntent(R.id.widget_category_item_root, fillIntent)
                    v
                }
                else -> RemoteViews(context.packageName, R.layout.spend_widget_category_item)
            }
        }

        override fun getLoadingView(): RemoteViews? = null
        override fun getViewTypeCount(): Int = 4
        override fun getItemId(position: Int): Long = position.toLong()
        override fun hasStableIds(): Boolean = false

        private fun extractAmount(formatted: String) =
            formatted.replace("Rs", "", ignoreCase = true).replace("₹", "").trim().ifEmpty { "0" }

        private fun formatRupees(amountMinor: Int) =
            "₹" + String.format("%,d", amountMinor / 100)
    }
}
