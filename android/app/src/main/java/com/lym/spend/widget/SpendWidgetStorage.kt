package com.lym.spend.widget

import android.content.Context
import com.lym.spend.db.SpendCoordinator
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
        /** Today's individual spends — what the widget lists. */
        val todaySpends: List<CategoryRow>,
    )

    /**
     * Midnight in the accounting timezone (IST), not UTC. `now - now % 86400000`
     * is UTC midnight, which between 00:00 and 05:30 IST lands on the PREVIOUS
     * day — the widget would show yesterday's spending as today's every night.
     */
    private const val IST_OFFSET_MILLIS = 5L * 60 * 60 * 1000 + 30L * 60 * 1000

    private fun startOfAccountingDay(now: Long): Long {
        val shifted = now + IST_OFFSET_MILLIS
        return shifted - (shifted % (24L * 60 * 60 * 1000)) - IST_OFFSET_MILLIS
    }

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

    /** Native SMS ingestion uses this so the widget does not wait for a JS VM. */
    fun refreshFromDatabase(context: Context, coordinator: SpendCoordinator) {
        val now = System.currentTimeMillis()
        val monthKey = SimpleDateFormat("yyyy-MM", Locale.ROOT).format(Date(now))
        val dayStart = startOfAccountingDay(now)
        val monthStart = SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).parse("$monthKey-01")!!.time
        val previous = readSnapshot(context)
        fun debitTotal(from: Long): Long = coordinator.query(
            """SELECT COALESCE(SUM(amount_minor), 0) AS total FROM transactions
               WHERE direction = 'debit' AND status = 'posted' AND occurred_at >= ?""",
            arrayOf(from.toString()),
        ).firstOrNull()?.get("total") as? Long ?: 0L
        val categories = org.json.JSONArray().also { rows ->
            previous.topCategories.forEach { row ->
                rows.put(JSONObject().put("label", row.label).put("amountLabel", row.amountLabel))
            }
        }
        // Read today's spends straight from the database rather than carrying the
        // previous snapshot forward: this path runs when an SMS arrives with no
        // JS VM alive, which is exactly when a new spend needs to appear.
        val todaySpends = org.json.JSONArray().also { rows ->
            coordinator.query(
                """SELECT merchant_name, amount_minor FROM transactions
                   WHERE direction = 'debit' AND status = 'posted' AND occurred_at >= ?
                   ORDER BY occurred_at DESC LIMIT 8""",
                arrayOf(dayStart.toString()),
            ).forEach { row ->
                val label = (row["merchant_name"] as? String)?.takeIf { it.isNotBlank() } ?: "Unknown payee"
                val minor = (row["amount_minor"] as? Long) ?: 0L
                rows.put(JSONObject().put("label", label).put("amountLabel", "₹${formatAmount(minor)}"))
            }
        }
        val json = JSONObject()
            .put("monthLabel", SimpleDateFormat("MMMM yyyy", Locale.getDefault()).format(Date(now)))
            .put("todayFormatted", "₹${formatAmount(debitTotal(dayStart))}")
            .put("monthSpentMinor", debitTotal(monthStart).coerceAtMost(Int.MAX_VALUE.toLong()).toInt())
            .put("monthBudgetMinor", previous.monthBudgetMinor ?: JSONObject.NULL)
            .put("daysRemainingInMonth", previous.daysRemainingInMonth)
            .put("topCategories", categories)
            .put("todaySpends", todaySpends)
        writeSnapshotJson(context, json.toString())
    }

    private fun formatAmount(minor: Long): String {
        val major = minor / 100
        val paise = (minor % 100).toString().padStart(2, '0')
        return "$major.$paise"
    }

    private fun parseSnapshot(json: JSONObject): Snapshot {
        fun rowsAt(key: String): List<CategoryRow> {
            val out = mutableListOf<CategoryRow>()
            json.optJSONArray(key)?.let { arr ->
                for (i in 0 until arr.length()) {
                    val o = arr.getJSONObject(i)
                    out.add(CategoryRow(o.optString("label"), o.optString("amountLabel")))
                }
            }
            return out
        }
        val cats = rowsAt("topCategories")
        return Snapshot(
            monthLabel = json.optString("monthLabel", "This month"),
            todayFormatted = json.optString("todayFormatted", "₹0"),
            monthSpentMinor = json.optInt("monthSpentMinor", 0),
            monthBudgetMinor = if (json.isNull("monthBudgetMinor")) null else json.optInt("monthBudgetMinor"),
            daysRemainingInMonth = json.optInt("daysRemainingInMonth", 0),
            topCategories = cats,
            todaySpends = rowsAt("todaySpends"),
        )
    }

    private fun placeholder(): Snapshot {
        val monthLabel = SimpleDateFormat("MMMM yyyy", Locale.getDefault()).format(Date())
        return Snapshot(monthLabel, "₹0", 0, null, 0, emptyList(), emptyList())
    }
}
