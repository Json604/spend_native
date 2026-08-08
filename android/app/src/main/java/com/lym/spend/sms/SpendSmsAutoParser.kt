package com.lym.spend.sms

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

/** Native counterpart to src/parser: classify first, then role every amount. */
data class ParsedIncomingSmsTransaction(
  val amountMinor: Long,
  val categoryLabel: String?,
  val occurredAtMillis: Long,
  val merchantRaw: String?,
  val counterpartyKey: String?,
  val channel: String,
)

enum class SmsMessageClassification {
  POSTED_DEBIT, POSTED_CREDIT, PENDING, REVERSAL, MANDATE_SETUP, PAYMENT_REQUEST,
  BALANCE_ONLY, MARKETING, SECURITY, UNKNOWN,
}

enum class SmsMonetaryRole {
  TRANSACTION_AMOUNT, AVAILABLE_BALANCE, CREDIT_LIMIT, PROMISED_CASHBACK,
  BILL_AMOUNT, MINIMUM_DUE, EMI_AMOUNT, UNKNOWN,
}

data class SmsParseResult(
  val classification: SmsMessageClassification,
  val transaction: ParsedIncomingSmsTransaction?,
  val parseStatus: String,
)

private data class MonetarySpan(val amountMinor: Long, val role: SmsMonetaryRole)

/** The JSON rule pack is shared with TypeScript and copied into Android at build time. */
private data class RulePack(
  val classifierOrder: List<Pair<SmsMessageClassification, String>>,
  val classifiers: Map<String, List<Regex>>,
  val monetaryRoleOrder: List<SmsMonetaryRole>,
  val monetaryRoles: Map<SmsMonetaryRole, List<Regex>>,
) {
  companion object {
    fun load(context: Context): RulePack {
      val json = context.assets.open("rules/default.json")
        .bufferedReader(Charsets.UTF_8)
        .use { JSONObject(it.readText()) }
      val classifierJson = json.getJSONObject("classifiers")
      val classifiers = buildMap {
        val keys = classifierJson.keys()
        while (keys.hasNext()) {
          val group = keys.next()
          put(group, classifierJson.getJSONArray(group).strings().map { Regex(it, RegexOption.IGNORE_CASE) })
        }
      }
      val classifierOrder = json.getJSONArray("classifierOrder").objects().map { rule ->
        classificationForWire(rule.getString("classification")) to rule.getString("group")
      }
      val monetaryJson = json.getJSONObject("monetaryRoles")
      val monetaryRoles = buildMap {
        val keys = monetaryJson.keys()
        while (keys.hasNext()) {
          val role = keys.next()
          put(monetaryRoleForWire(role), monetaryJson.getJSONArray(role).strings().map { pattern ->
            Regex(pattern, RegexOption.IGNORE_CASE)
          })
        }
      }
      val monetaryRoleOrder = json.getJSONArray("monetaryRoleOrder").strings().map(::monetaryRoleForWire)
      return RulePack(classifierOrder, classifiers, monetaryRoleOrder, monetaryRoles)
    }

    private fun classificationForWire(value: String): SmsMessageClassification =
      SmsMessageClassification.values().firstOrNull {
        it.name.lowercase(Locale.ROOT) == value.lowercase(Locale.ROOT)
      } ?: error("Unsupported classification $value")

    private fun monetaryRoleForWire(value: String): SmsMonetaryRole =
      SmsMonetaryRole.values().firstOrNull {
        it.name.lowercase(Locale.ROOT) == value.lowercase(Locale.ROOT)
      } ?: error("Unsupported monetary role $value")
  }
}

object SpendSmsAutoParser {
  private val VPA_PATTERN = Regex("\\b[a-z0-9][a-z0-9._-]{1,50}@[a-z0-9][a-z0-9.-]{1,30}\\b", RegexOption.IGNORE_CASE)
  private val UPI_PATTERN = Regex("\\bupi\\b|\\bqr\\b", RegexOption.IGNORE_CASE)
  private val MERCHANT_PATTERN = Regex(
    """\b(?:at|to)\s+([A-Za-z][A-Za-z0-9 &'./-]{1,60}?)(?=\s+(?:using|via|on|for|upi|ref|from)\b|[.,]|$)""",
    RegexOption.IGNORE_CASE,
  )
  private val amountRegex = Regex(
    """(?:₹|(?:rs|inr|mrp|amt|amount)\.?)\s*[:\-]?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)(?:\s*(lakh|lac|crore|k))?""",
    RegexOption.IGNORE_CASE,
  )

  @Volatile private var cachedRulePack: RulePack? = null

  fun parse(context: Context, sender: String?, body: String?, timestamp: Long): SmsParseResult {
    val text = body?.replace(Regex("\\s+"), " ")?.trim().orEmpty()
    if (text.isBlank()) return SmsParseResult(SmsMessageClassification.UNKNOWN, null, "empty")

    val rulePack = rulePack(context)
    // Deliberately before amount extraction: intent decides whether amounts matter.
    val classification = rulePack.classifierOrder.firstOrNull { (candidate, group) ->
      rulePack.classifiers[group].orEmpty().any { it.containsMatchIn(text) }
    }?.first ?: SmsMessageClassification.UNKNOWN
    val spans = amountRegex.findAll(text).map { match ->
      MonetarySpan(
        parseAmountMinor(match.groupValues[1], match.groupValues[2]),
        roleFor(rulePack, text, match.range.first, match.range.last + 1),
      )
    }.filter { it.amountMinor > 0 }.toMutableList()

    var transactionSpan = spans.firstOrNull { it.role == SmsMonetaryRole.TRANSACTION_AMOUNT }
    if (transactionSpan == null && classification == SmsMessageClassification.POSTED_DEBIT) {
      val unknown = spans.filter { it.role == SmsMonetaryRole.UNKNOWN }
      if (unknown.size == 1) transactionSpan = unknown.single()
    }
    if (classification == SmsMessageClassification.POSTED_DEBIT && transactionSpan != null) {
      return SmsParseResult(
        classification,
        ParsedIncomingSmsTransaction(
          amountMinor = transactionSpan.amountMinor,
          categoryLabel = null,
          occurredAtMillis = timestamp,
          merchantRaw = extractMerchant(text),
          counterpartyKey = extractCounterpartyKey(text),
          channel = if (VPA_PATTERN.containsMatchIn(text) || UPI_PATTERN.containsMatchIn(text)) "upi" else "sms",
        ),
        "parsed",
      )
    }
    val status = when (classification) {
      SmsMessageClassification.UNKNOWN -> "unknown_classification"
      SmsMessageClassification.POSTED_DEBIT -> "missing_transaction_amount"
      else -> "non_transaction_${classification.name.lowercase()}"
    }
    return SmsParseResult(classification, null, status)
  }

  private fun rulePack(context: Context): RulePack =
    cachedRulePack ?: synchronized(this) {
      cachedRulePack ?: RulePack.load(context.applicationContext).also { cachedRulePack = it }
    }

  private fun roleFor(rulePack: RulePack, text: String, start: Int, end: Int): SmsMonetaryRole {
    val before = text.substring(maxOf(0, start - 80), start)
    val after = text.substring(end, minOf(text.length, end + 80))
    val context = "$before<AMOUNT>$after"
    return rulePack.monetaryRoleOrder.firstOrNull { role ->
      rulePack.monetaryRoles[role].orEmpty().any { it.containsMatchIn(context) }
    } ?: SmsMonetaryRole.UNKNOWN
  }

  private fun parseAmountMinor(number: String, magnitude: String): Long {
    val value = number.replace(",", "").toBigDecimalOrNull() ?: return 0
    val multiplier = when (magnitude.lowercase()) {
      "crore" -> 10_000_000L; "lakh", "lac" -> 100_000L; "k" -> 1_000L; else -> 1L
    }
    return try { value.movePointRight(2).multiply(multiplier.toBigDecimal()).longValueExact() } catch (_: ArithmeticException) { 0 }
  }

  private fun extractCounterpartyKey(text: String): String? {
    val vpa = VPA_PATTERN.find(text)?.value?.lowercase()?.takeIf(String::isNotBlank)
    if (vpa != null) return "vpa:$vpa"
    return extractMerchant(text)?.let { "merchant:${normalize(it)}" }
  }

  private fun extractMerchant(text: String): String? {
    val match = MERCHANT_PATTERN.find(text) ?: return null
    return match.groupValues[1].trim().takeIf { it.isNotBlank() }
  }

  private fun normalize(value: String): String = value
    .lowercase()
    .replace(Regex("[^a-z0-9&.'/-]+"), " ")
    .replace(Regex("\\s+"), " ")
    .trim()
}

private fun JSONArray.objects(): List<JSONObject> = buildList {
  for (index in 0 until length()) add(getJSONObject(index))
}

private fun JSONArray.strings(): List<String> = buildList {
  for (index in 0 until length()) add(getString(index))
}
