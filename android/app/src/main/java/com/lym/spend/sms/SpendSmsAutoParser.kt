package com.lym.spend.sms

/** Minimal native counterpart to src/parser: classify first, then role every amount. */
data class ParsedIncomingSmsTransaction(
  val amountMinor: Long,
  val categoryLabel: String?,
  val occurredAtMillis: Long,
  val merchantRaw: String?,
  val counterpartyKey: String?,
  val channel: String,
)

enum class SmsMessageClassification {
  POSTED_DEBIT, POSTED_CREDIT, PENDING, REVERSAL, MANDATE_SETUP,
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

  // This ordered list mirrors the TypeScript classifier's safety-first intent.
  private val classifiers = listOf(
    SmsMessageClassification.SECURITY to """\botp\b|\bone[ -]?time password\b|\blog[ -]?in\b|\bpassword\b|\bkyc\b""",
    SmsMessageClassification.MARKETING to """\bpre[ -]?approved\b|\blifetime free\b|\bget\s+up\s*to\b|\bapply\s+now\b|\blimited\s+period\b""",
    SmsMessageClassification.REVERSAL to """\bfailed\b|\bdeclined\b|\bunsuccessful\b|\breversed\b|\bcould not be processed\b""",
    SmsMessageClassification.MANDATE_SETUP to """\be[ -]?mandate\b|\bmandate\b|\bwill be debited\b|\bscheduled\b|\bcollect request\b""",
    SmsMessageClassification.PENDING to """\bpending\b|\bawaiting\b|\bprocessing\b|\binitiated\b""",
    SmsMessageClassification.POSTED_CREDIT to """\bcredited\s+(?:to|by)\b|\breceived\b[\s\S]{0,100}\bin your\b|\brefund(?:ed)?\s+(?:of|to)\b""",
    SmsMessageClassification.POSTED_DEBIT to """\bdebited\b|\bdebit\s+of\b|\bsent\s+(?=(?:rs\.?|inr|₹)\s*\d)|\bspent\b|\bpaid\b|\bwithdrawn\b|\bcharged\b|\bpurchased?\b""",
    SmsMessageClassification.BALANCE_ONLY to """\bavl\.?\s*bal\b|\bavailable\s+balance\b|\b(?:a/c|account)\s+balance\b|\bbalance\s+(?:is|as of)\b""",
  ).map { (classification, pattern) -> classification to Regex(pattern, RegexOption.IGNORE_CASE) }

  fun parse(sender: String?, body: String?, timestamp: Long): SmsParseResult {
    val text = body?.replace(Regex("\\s+"), " ")?.trim().orEmpty()
    if (text.isBlank()) return SmsParseResult(SmsMessageClassification.UNKNOWN, null, "empty")

    // Deliberately before amount extraction: intent decides whether amounts matter.
    val classification = classifiers.firstOrNull { it.second.containsMatchIn(text) }?.first
      ?: SmsMessageClassification.UNKNOWN
    val spans = amountRegex.findAll(text).map { match ->
      MonetarySpan(parseAmountMinor(match.groupValues[1], match.groupValues[2]), roleFor(text, match.range.first, match.range.last + 1))
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

  private fun roleFor(text: String, start: Int, end: Int): SmsMonetaryRole {
    val before = text.substring(maxOf(0, start - 80), start)
    val after = text.substring(end, minOf(text.length, end + 80))
    val context = "$before<AMOUNT>$after"
    val roles = listOf(
      SmsMonetaryRole.AVAILABLE_BALANCE to """(?:avl\.?\s*bal(?:ance)?|avail(?:able)?\s+bal(?:ance)?|bal(?:ance)?\.?).{0,24}<AMOUNT>|<AMOUNT>.{0,30}available\s+balance""",
      SmsMonetaryRole.CREDIT_LIMIT to """(?:credit\s+limit|\blimit|eligibility).{0,24}<AMOUNT>|<AMOUNT>.{0,36}credit\s+limit""",
      SmsMonetaryRole.MINIMUM_DUE to """minimum\s+(?:amount\s+)?due.{0,24}<AMOUNT>|<AMOUNT>.{0,32}minimum\s+(?:amount\s+)?due""",
      SmsMonetaryRole.EMI_AMOUNT to """(?:emi|instalment|installment).{0,24}<AMOUNT>|<AMOUNT>.{0,24}(?:emi|instalment|installment)""",
      SmsMonetaryRole.BILL_AMOUNT to """(?:bill(?:\s+(?:payment|amount))?|amount\s+due).{0,24}<AMOUNT>|<AMOUNT>.{0,32}(?:bill\s+amount|amount\s+due)""",
      SmsMonetaryRole.PROMISED_CASHBACK to """cashback.{0,24}<AMOUNT>|<AMOUNT>.{0,24}cashback""",
      SmsMonetaryRole.TRANSACTION_AMOUNT to """(?:debited(?:\s+by)?|sent|spent|paid|payment\s+of|debit\s+of|withdrawn|charged|received|credited\s+by|refund\s+of|refunded|transferred|recharge\s+of|transaction\s+for)\s*<AMOUNT>|<AMOUNT>\s*(?:was\s+|is\s+|has\s+been\s+)?(?:debited|spent|paid|withdrawn|charged|credited|received|refunded|transferred)""",
    )
    return roles.firstOrNull { Regex(it.second, RegexOption.IGNORE_CASE).containsMatchIn(context) }?.first
      ?: SmsMonetaryRole.UNKNOWN
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
