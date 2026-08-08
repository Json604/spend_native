package com.lym.spend.widget

import android.content.Context
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Local SharedPreferences cache for widget data. Source of truth is the JS app,
 * which pushes snapshots in via [SpendWidgetBridgeModule] whenever its state
 * changes. The widget reads from here and never hits Supabase directly.
 */
object SpendWidgetStorage {
    private const val PREFS = "spend_widget_cache"
    private const val KEY_SNAPSHOT = "snapshot_json"

    data class CategoryRow(val label: String, val amountLabel: String)

    data class Snapshot(
        val monthLabel: String,
        val todayFormatted: String,
        val monthSpentMinor: Int,
        val monthBudgetMinor: Int?,
        val daysRemainingInMonth: Int,
        val topCategories: List<CategoryRow>,
    )

    fun readSnapshot(context: Context): Snapshot {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_SNAPSHOT, null) ?: return placeholder()
        return try { parseSnapshot(JSONObject(raw)) } catch (_: Throwable) { placeholder() }
    }

    /** Called from the JS bridge — the JS side has already computed the snapshot. */
    fun writeSnapshotJson(context: Context, snapshotJson: String) {
        // Validate it parses, then store as-is.
        JSONObject(snapshotJson)
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_SNAPSHOT, snapshotJson).apply()
    }

    private fun parseSnapshot(json: JSONObject): Snapshot {
        val cats = mutableListOf<CategoryRow>()
        json.optJSONArray("topCategories")?.let { arr ->
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                cats.add(CategoryRow(o.optString("label"), o.optString("amountLabel")))
            }
        }
        return Snapshot(
            monthLabel = json.optString("monthLabel", "This month"),
            todayFormatted = json.optString("todayFormatted", "₹0"),
            monthSpentMinor = json.optInt("monthSpentMinor", 0),
            monthBudgetMinor = if (json.isNull("monthBudgetMinor")) null else json.optInt("monthBudgetMinor"),
            daysRemainingInMonth = json.optInt("daysRemainingInMonth", 0),
            topCategories = cats,
        )
    }

    private fun placeholder(): Snapshot {
        val monthLabel = SimpleDateFormat("MMMM yyyy", Locale.getDefault()).format(Date())
        return Snapshot(monthLabel, "₹0", 0, null, 0, emptyList())
    }
}
