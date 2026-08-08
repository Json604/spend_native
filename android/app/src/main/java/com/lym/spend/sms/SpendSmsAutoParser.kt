package com.lym.spend.sms

data class ParsedIncomingSmsTransaction(
  val amountMinor: Int,
  val categoryLabel: String?,
  val dedupeKey: String,
  val occurredAtMillis: Long,
)

object SpendSmsAutoParser {
  private val amountRegex =
    Regex("""(?:rs\.?|inr|₹|amt\.?|amount)\s*[:\-]?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)""", RegexOption.IGNORE_CASE)
  private val debitPatterns = listOf(
    Regex("""\bdebited\b""", RegexOption.IGNORE_CASE),
    Regex("""\bspent\b""", RegexOption.IGNORE_CASE),
    Regex("""\bpaid\b""", RegexOption.IGNORE_CASE),
    Regex("""\bpurchase\b""", RegexOption.IGNORE_CASE),
    Regex("""\bsent\b""", RegexOption.IGNORE_CASE),
    Regex("""\btransaction\b""", RegexOption.IGNORE_CASE),
    Regex("""\btxn\b""", RegexOption.IGNORE_CASE),
    Regex("""\bupi\b""", RegexOption.IGNORE_CASE),
    Regex("""\bcard\b""", RegexOption.IGNORE_CASE),
    Regex("""\bdr\b""", RegexOption.IGNORE_CASE),
    Regex("""\bdebit\b""", RegexOption.IGNORE_CASE),
    Regex("""\bwithdrawn\b""", RegexOption.IGNORE_CASE),
    Regex("""\bcharged\b""", RegexOption.IGNORE_CASE),
    Regex("""\bimps\b""", RegexOption.IGNORE_CASE),
    Regex("""\bneft\b""", RegexOption.IGNORE_CASE),
    Regex("""\brtgs\b""", RegexOption.IGNORE_CASE),
    Regex("""\bautopay\b""", RegexOption.IGNORE_CASE),
  )
  private val creditPatterns = listOf(
    Regex("""\bcredited\b""", RegexOption.IGNORE_CASE),
    Regex("""\breceived\b""", RegexOption.IGNORE_CASE),
    Regex("""\brefund(?:ed)?\b""", RegexOption.IGNORE_CASE),
    Regex("""\bdeposit(?:ed)?\b""", RegexOption.IGNORE_CASE),
    Regex("""\bcredit\b""", RegexOption.IGNORE_CASE),
    Regex("""\bcr\b""", RegexOption.IGNORE_CASE),
  )
  private val transactionSenderPatterns = listOf(
    Regex("""kotak|hdfc|icici|sbi|axis|idfc|yes|indus|federal|canara|pnb|rbl|bob|boi|union|bank|upi|card|paytm|phonepe|gpay|bhim""", RegexOption.IGNORE_CASE),
  )

  fun parse(
    sender: String?,
    body: String?,
    timestamp: Long,
  ): ParsedIncomingSmsTransaction? {
    val rawBody = body?.replace("\\s+".toRegex(), " ")?.trim().orEmpty()
    val rawSender = sender?.replace("\\s+".toRegex(), " ")?.trim().orEmpty()

    if (rawBody.isBlank()) {
      return null
    }

    val amountMatch = amountRegex.find(rawBody) ?: return null
    val hasDebitSignal = debitPatterns.any { it.containsMatchIn(rawBody) }
    val hasCreditSignal = creditPatterns.any { it.containsMatchIn(rawBody) }
    val hasTransactionSender = transactionSenderPatterns.any { it.containsMatchIn(rawSender) }
    val hasTransactionBody =
      hasDebitSignal ||
        hasCreditSignal ||
        Regex("""\bupi\b|\btransaction\b|\btxn\b|\bpayment\b|\baccount\b|\ba/c\b|\bkotak\b|\bbank\b""", RegexOption.IGNORE_CASE)
          .containsMatchIn(rawBody)

    if (!hasTransactionSender && !hasTransactionBody) {
      return null
    }

    if (!hasDebitSignal || hasCreditSignal) {
      return null
    }

    val amountMinor = parseAmountMinor(amountMatch.groupValues.getOrNull(1))

    if (amountMinor <= 0) {
      return null
    }

    return ParsedIncomingSmsTransaction(
      amountMinor = amountMinor,
      categoryLabel = inferCategory(rawBody),
      dedupeKey = buildDedupeKey(rawSender, amountMinor, timestamp),
      occurredAtMillis = timestamp,
    )
  }

  private fun parseAmountMinor(amountText: String?): Int {
    val normalized = amountText?.replace(",", "")?.trim().orEmpty()
    val parsed = normalized.toDoubleOrNull() ?: return 0
    return (parsed * 100).toInt()
  }

  private fun inferCategory(rawBody: String): String? {
    return when {
      Regex("""swiggy|instamart""", RegexOption.IGNORE_CASE).containsMatchIn(rawBody) -> "Swiggy"
      Regex("""zomato|blinkit""", RegexOption.IGNORE_CASE).containsMatchIn(rawBody) -> "Zomato"
      Regex("""zepto""", RegexOption.IGNORE_CASE).containsMatchIn(rawBody) -> "Zepto"
      Regex("""uber\s*eats|faasos|eat\.?sure|domino|pizza|behrouz|box8""", RegexOption.IGNORE_CASE)
        .containsMatchIn(rawBody) -> "Other Food Apps"
      else -> null
    }
  }

  private fun buildDedupeKey(sender: String, amountMinor: Int, timestamp: Long): String {
    val minuteBucket = timestamp / 60000L
    return "${sender.lowercase()}:${amountMinor}:${minuteBucket}"
  }
}
