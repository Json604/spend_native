package com.lym.spend.classify

import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import kotlin.math.abs
import kotlin.math.min

enum class ClassificationTier(val wireValue: String, val allocationSource: String) {
  MEMORY("memory", "learned"),
  RULES("rules", "rule"),
  SIMILARITY("similarity", "similarity"),
}

data class ClassifierTransactionInput(
  val transactionId: String,
  val amountMinor: Long,
  val merchantRaw: String?,
  val counterpartyKey: String?,
  val channel: String?,
  val rawMessage: String?,
)

data class ClassificationCandidate(
  val categoryId: String,
  val confidence: Double,
  val tier: ClassificationTier,
  val catalogVersion: Int,
)

data class CascadeResult(
  val autoApply: ClassificationCandidate?,
  val suggestions: List<ClassificationCandidate>,
)

private data class MemoryObservation(
  val categoryId: String,
  val observationCount: Int,
  val provisional: Boolean,
)

private data class RuleDefinition(
  val categoryLabel: String,
  val confidence: Double,
  val merchantTokens: List<Regex>,
  val vpaDomains: Set<String>,
  val channels: Set<String>,
)

private data class CounterpartyConfig(
  val aggregatorPatterns: List<Regex>,
  val aggregatorDomains: Set<String>,
  val genericBankVpaDomains: Set<String>,
  val genericLocalPart: Regex,
)

private data class RulePack(
  val categoryRules: List<RuleDefinition>,
  val counterparty: CounterpartyConfig,
) {
  companion object {
    fun load(context: Context): RulePack {
      val json = context.assets.open("rules/default.json")
        .bufferedReader(Charsets.UTF_8)
        .use { JSONObject(it.readText()) }
      val rules = json.optJSONArray("categoryRules")?.objects().orEmpty().map { rule ->
        RuleDefinition(
          categoryLabel = rule.getString("categoryLabel"),
          confidence = rule.getDouble("confidence"),
          merchantTokens = rule.optStringArray("merchantTokens")
            .map { Regex(it, RegexOption.IGNORE_CASE) },
          vpaDomains = rule.optStringArray("vpaDomains")
            .map(String::lowercase)
            .toSet(),
          channels = rule.optStringArray("channels")
            .map { it.lowercase(Locale.ROOT) }
            .toSet(),
        )
      }
      val counterparty = json.getJSONObject("counterparty")
      return RulePack(
        categoryRules = rules,
        counterparty = CounterpartyConfig(
          aggregatorPatterns = counterparty.getStringArray("aggregatorPatterns")
            .map { Regex(it, RegexOption.IGNORE_CASE) },
          aggregatorDomains = counterparty.getStringArray("aggregatorDomains")
            .map(String::lowercase)
            .toSet(),
          genericBankVpaDomains = counterparty.getStringArray("genericBankVpaDomains")
            .map(String::lowercase)
            .toSet(),
          genericLocalPart = Regex(
            counterparty.getString("genericLocalPartPattern"),
            RegexOption.IGNORE_CASE,
          ),
        ),
      )
    }
  }
}

/** The offline, cheapest-first classifier cascade. */
class ClassifierCascade(context: Context) {
  private val rulePack = RulePack.load(context.applicationContext)

  fun classify(database: SQLiteDatabase, input: ClassifierTransactionInput): CascadeResult {
    val memory = memoryResult(database, input)
    memory.autoApply?.let { return CascadeResult(it, emptyList()) }
    if (memory.conflict) return CascadeResult(null, memory.suggestions)

    val rules = ruleResult(database, input)
    rules.autoApply?.let { return CascadeResult(it, emptyList()) }
    if (rules.suggestions.isNotEmpty()) return CascadeResult(null, rules.suggestions)

    val similarity = similarityResult(database, input)
    similarity.autoApply?.let { return CascadeResult(it, emptyList()) }
    if (similarity.suggestions.isNotEmpty()) return CascadeResult(null, similarity.suggestions)

    return CascadeResult(null, fallbackSuggestions(database).ifEmpty { memory.suggestions })
  }

  /** Shared with manual learning so unsafe aggregator keys are never learned. */
  fun isLowSpecificityKey(key: String?): Boolean {
    if (key == null || !key.lowercase(Locale.ROOT).startsWith("vpa:")) return false
    val handle = key.substringAfter(':').lowercase(Locale.ROOT)
    val separator = handle.lastIndexOf('@')
    if (separator <= 0) return true
    val localPart = handle.substring(0, separator)
    val domain = handle.substring(separator + 1)
    if (rulePack.counterparty.aggregatorPatterns.any { it.containsMatchIn(localPart) || it.containsMatchIn(domain) }) {
      return true
    }
    if (domain in rulePack.counterparty.aggregatorDomains) return true
    return domain in rulePack.counterparty.genericBankVpaDomains &&
      rulePack.counterparty.genericLocalPart.matches(localPart)
  }

  private fun memoryResult(
    database: SQLiteDatabase,
    input: ClassifierTransactionInput,
  ): MemoryResult {
    val key = input.counterpartyKey ?: return MemoryResult(null, false, emptyList())
    val observations = database.rawQuery(
      """SELECT category_id, observation_count, provisional
         FROM category_memory WHERE counterparty_key = ?
         ORDER BY observation_count DESC, category_id""",
      arrayOf(key),
    ).use { cursor ->
      buildList {
        while (cursor.moveToNext()) {
          add(MemoryObservation(cursor.getString(0), cursor.getInt(1), cursor.getInt(2) == 1))
        }
      }
    }
    if (observations.isEmpty()) return MemoryResult(null, false, emptyList())

    val total = observations.sumOf { it.observationCount }
    val top = observations.first()
    val dominance = top.observationCount.toDouble() / total.toDouble()
    val confidence = confidenceFor(dominance, total)
    val candidate = candidate(database, top.categoryId, confidence, ClassificationTier.MEMORY)
    val suggestions = observations.take(ClassifierThresholds.NOTIFICATION_SUGGESTION_LIMIT).mapNotNull { observation ->
      val observedConfidence = confidenceFor(
        observation.observationCount.toDouble() / total.toDouble(),
        total,
      )
      candidate(database, observation.categoryId,
        if (observation.provisional) min(observedConfidence, ClassifierThresholds.MEMORY_PROVISIONAL_CONFIDENCE_CAP)
        else observedConfidence,
        ClassificationTier.MEMORY)
    }
    val canAutoApply = top.observationCount >= ClassifierThresholds.MEMORY_MIN_OBSERVATIONS &&
      dominance >= ClassifierThresholds.MEMORY_DOMINANCE_RATIO &&
      !top.provisional &&
      confidence >= ClassifierThresholds.MEMORY_AUTO_APPLY_CONFIDENCE
    return MemoryResult(
      autoApply = if (canAutoApply) candidate else null,
      conflict = observations.size > 1 && dominance < ClassifierThresholds.MEMORY_DOMINANCE_RATIO,
      suggestions = if (canAutoApply) emptyList() else suggestions,
    )
  }

  private fun ruleResult(
    database: SQLiteDatabase,
    input: ClassifierTransactionInput,
  ): TierResult {
    val haystack = listOfNotNull(input.merchantRaw, input.counterpartyKey, input.rawMessage)
      .joinToString(" ")
    val vpaDomain = input.counterpartyKey
      ?.takeIf { it.startsWith("vpa:", ignoreCase = true) }
      ?.substringAfterLast('@')
      ?.lowercase(Locale.ROOT)
    val matches = rulePack.categoryRules.mapNotNull { rule ->
      val merchantMatch = rule.merchantTokens.any { it.containsMatchIn(haystack) }
      val vpaMatch = vpaDomain != null && rule.vpaDomains.any { vpaDomain == it || vpaDomain.endsWith(".$it") }
      val channelMatch = input.channel?.lowercase(Locale.ROOT)?.let { it in rule.channels } == true
      if (!merchantMatch && !vpaMatch && !channelMatch) return@mapNotNull null
      category(database, rule.categoryLabel)?.let { (id, version) ->
        ClassificationCandidate(id, rule.confidence.coerceIn(0.0, 1.0), ClassificationTier.RULES, version)
      }
    }.distinctBy { it.categoryId }.sortedByDescending { it.confidence }
    return if (matches.size == 1 && matches.single().confidence >= ClassifierThresholds.RULE_AUTO_APPLY_CONFIDENCE) {
      TierResult(matches.single(), emptyList())
    } else {
      TierResult(null, matches.take(ClassifierThresholds.NOTIFICATION_SUGGESTION_LIMIT))
    }
  }

  private fun similarityResult(
    database: SQLiteDatabase,
    input: ClassifierTransactionInput,
  ): TierResult {
    val inputTokens = tokens(input.merchantRaw ?: input.counterpartyKey)
    if (inputTokens.isEmpty()) return TierResult(null, emptyList())
    val neighbours = database.rawQuery(
      """SELECT DISTINCT t.amount_minor, t.merchant_raw, t.counterparty_key,
                a.category_id
         FROM transactions t
         JOIN transaction_allocations a ON a.transaction_id = t.id
         WHERE t.id != ? AND a.category_id IS NOT NULL
           AND (t.merchant_raw IS NOT NULL OR t.counterparty_key IS NOT NULL)""",
      arrayOf(input.transactionId),
    ).use { cursor ->
      buildList {
        while (cursor.moveToNext()) {
          val merchant = cursor.stringOrNull(1) ?: cursor.stringOrNull(2)
          val overlap = tokenOverlap(inputTokens, tokens(merchant))
          if (overlap >= ClassifierThresholds.SIMILARITY_MIN_TOKEN_OVERLAP) {
            val amount = cursor.getLong(0)
            val amountProximity = 1.0 - min(
              abs(amount - input.amountMinor).toDouble() / maxOf(amount, input.amountMinor, 1L).toDouble(),
              1.0,
            )
            add(Neighbour(cursor.getString(3), overlap, amountProximity))
          }
        }
      }
    }
    if (neighbours.isEmpty()) return TierResult(null, emptyList())

    val grouped = neighbours.groupBy { it.categoryId }
      .mapNotNull { (categoryId, rows) ->
        if (rows.size < ClassifierThresholds.SIMILARITY_MIN_SUPPORT) return@mapNotNull null
        val bestScore = rows.maxOf { score(it) }
        SimilarityCandidate(categoryId, rows.size, bestScore)
      }
      .sortedWith(compareByDescending<SimilarityCandidate> { it.support }.thenByDescending { it.score })
    if (grouped.isEmpty()) return TierResult(null, emptyList())
    val totalSupport = grouped.sumOf { it.support }
    val top = grouped.first()
    val dominance = top.support.toDouble() / totalSupport.toDouble()
    val confidence = top.score * (top.support.toDouble() / (top.support + ClassifierThresholds.SIMILARITY_SUPPORT_PRIOR)) * dominance
    val topCandidate = candidate(database, top.categoryId, confidence.coerceIn(0.0, 1.0), ClassificationTier.SIMILARITY)
    val suggestions = grouped.take(ClassifierThresholds.NOTIFICATION_SUGGESTION_LIMIT).mapNotNull { item ->
      val itemConfidence = item.score *
        (item.support.toDouble() / (item.support + ClassifierThresholds.SIMILARITY_SUPPORT_PRIOR)) *
        (item.support.toDouble() / totalSupport.toDouble())
      candidate(database, item.categoryId, itemConfidence.coerceIn(0.0, 1.0), ClassificationTier.SIMILARITY)
    }
    val canAutoApply = top.support >= ClassifierThresholds.SIMILARITY_MIN_SUPPORT &&
      dominance >= ClassifierThresholds.SIMILARITY_DOMINANCE_RATIO &&
      confidence >= ClassifierThresholds.SIMILARITY_AUTO_APPLY_CONFIDENCE
    return TierResult(if (canAutoApply) topCandidate else null, if (canAutoApply) emptyList() else suggestions)
  }

  private fun candidate(
    database: SQLiteDatabase,
    categoryId: String,
    confidence: Double,
    tier: ClassificationTier,
  ): ClassificationCandidate? = categoryById(database, categoryId)?.let { version ->
    ClassificationCandidate(categoryId, confidence.coerceIn(0.0, 1.0), tier, version)
  }

  private fun category(database: SQLiteDatabase, label: String): Pair<String, Int>? = querySingle(
    database,
    "SELECT id, catalog_version FROM categories WHERE lower(label) = lower(?) AND deleted_at IS NULL",
    arrayOf(label),
  ) { it.getString(0) to it.getInt(1) }

  private fun categoryById(database: SQLiteDatabase, id: String): Int? = querySingle(
    database,
    "SELECT catalog_version FROM categories WHERE id = ? AND deleted_at IS NULL",
    arrayOf(id),
  ) { it.getInt(0) }

  /**
   * A genuine abstention still needs useful lock-screen choices. Rank active
   * user categories by prior manual use, then by total use, without inventing
   * a confidence score that could be mistaken for a classifier match.
   */
  private fun fallbackSuggestions(database: SQLiteDatabase): List<ClassificationCandidate> =
    database.rawQuery(
      """SELECT c.id, c.catalog_version
         FROM categories c
         LEFT JOIN transaction_allocations a ON a.category_id = c.id
         WHERE c.deleted_at IS NULL AND c.id NOT IN ('uncategorized', 'needs-review')
         GROUP BY c.id, c.catalog_version, c.label
         ORDER BY SUM(CASE WHEN a.source = 'manual' THEN 1 ELSE 0 END) DESC,
                  COUNT(a.id) DESC, c.label
         LIMIT ?""",
      arrayOf(ClassifierThresholds.NOTIFICATION_SUGGESTION_LIMIT.toString()),
    ).use { cursor ->
      buildList {
        while (cursor.moveToNext()) {
          add(ClassificationCandidate(cursor.getString(0), 0.0, ClassificationTier.MEMORY, cursor.getInt(1)))
        }
      }
    }

  private fun confidenceFor(dominance: Double, observations: Int): Double =
    (dominance * observations.toDouble() /
      (observations + ClassifierThresholds.MEMORY_OBSERVATION_PRIOR)).coerceIn(0.0, 1.0)

  private fun tokens(value: String?): Set<String> = value.orEmpty()
    .lowercase(Locale.ROOT)
    .split(Regex("[^a-z0-9]+"))
    .filter { it.length >= 2 }
    .toSet()

  private fun tokenOverlap(left: Set<String>, right: Set<String>): Double {
    if (left.isEmpty() || right.isEmpty()) return 0.0
    return left.intersect(right).size.toDouble() / left.union(right).size.toDouble()
  }

  private fun score(neighbour: Neighbour): Double =
    neighbour.overlap * ClassifierThresholds.SIMILARITY_TOKEN_WEIGHT +
      neighbour.amountProximity * ClassifierThresholds.SIMILARITY_AMOUNT_WEIGHT

  private data class MemoryResult(
    val autoApply: ClassificationCandidate?,
    val conflict: Boolean,
    val suggestions: List<ClassificationCandidate>,
  )

  private data class TierResult(
    val autoApply: ClassificationCandidate?,
    val suggestions: List<ClassificationCandidate>,
  )

  private data class Neighbour(
    val categoryId: String,
    val overlap: Double,
    val amountProximity: Double,
  )

  private data class SimilarityCandidate(
    val categoryId: String,
    val support: Int,
    val score: Double,
  )
}

private fun JSONObject.optStringArray(name: String): List<String> =
  optJSONArray(name)?.strings().orEmpty()

private fun JSONObject.getStringArray(name: String): List<String> =
  getJSONArray(name).strings()

private fun JSONArray.objects(): List<JSONObject> = buildList {
  for (index in 0 until length()) add(getJSONObject(index))
}

private fun JSONArray.strings(): List<String> = buildList {
  for (index in 0 until length()) add(getString(index))
}

private fun Cursor.stringOrNull(column: Int): String? = if (isNull(column)) null else getString(column)

private fun <T> querySingle(
  database: SQLiteDatabase,
  sql: String,
  args: Array<String>,
  mapper: (Cursor) -> T,
): T? = database.rawQuery(sql, args).use { cursor ->
  if (cursor.moveToFirst()) mapper(cursor) else null
}
