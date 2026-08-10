package com.lym.spend.classify

import com.lym.spend.auth.SecureTokenStoreModule
import com.lym.spend.db.Command
import com.lym.spend.db.RecordSuggestionPayload
import com.lym.spend.db.SpendCoordinator
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

object GroqTransactionClassifier {
  private const val ENDPOINT = "https://api.groq.com/openai/v1/chat/completions"
  private const val MODEL = "openai/gpt-oss-20b"

  data class Suggestion(val categoryId: String, val label: String, val confidence: Double)

  fun suggest(
    context: android.content.Context,
    coordinator: SpendCoordinator,
    transactionId: String,
    messageBody: String,
  ): Suggestion? {
    val apiKey = SecureTokenStoreModule.readGroqApiKey(context) ?: return null
    val transaction = coordinator.query(
      """SELECT t.merchant_raw, t.amount_minor, t.channel, t.accounting_month_key,
                t.revision, a.category_id
         FROM transactions t
         LEFT JOIN transaction_allocations a ON a.transaction_id = t.id
         WHERE t.id = ? AND t.deleted_at IS NULL""",
      arrayOf(transactionId),
    ).firstOrNull() ?: return null
    if (transaction["category_id"] != null) return null
    val monthKey = transaction["accounting_month_key"]?.toString() ?: return null
    val categories = coordinator.query(
      """SELECT c.id, c.label, parent.label AS parent_label
         FROM budgets b
         JOIN categories c ON c.id = b.category_id AND c.deleted_at IS NULL
         LEFT JOIN categories parent ON parent.id = c.parent_id AND parent.deleted_at IS NULL
         WHERE b.month_key = ? AND b.amount_minor > 0
           AND c.id NOT IN ('uncategorized', 'needs-review')
         ORDER BY lower(COALESCE(parent.label || ' / ', '') || c.label)""",
      arrayOf(monthKey),
    ).mapNotNull { row ->
      val id = row["id"]?.toString() ?: return@mapNotNull null
      val label = row["label"]?.toString() ?: return@mapNotNull null
      val parent = row["parent_label"]?.toString()?.takeIf(String::isNotBlank)
      Category(id, if (parent == null) label else "$parent / $label")
    }
    if (categories.isEmpty()) return null

    val result = request(apiKey, transaction, messageBody, categories) ?: return null
    val matched = categories.firstOrNull { it.id == result.first } ?: return null
    val revision = (transaction["revision"] as? Number)?.toInt() ?: return null
    val suggestionId = stableUuid("groq:$transactionId:${matched.id}").toString()
    coordinator.execute(
      Command.RecordSuggestion(
        commandId = "groq-suggestion:$suggestionId",
        payload = RecordSuggestionPayload(
          suggestionId = suggestionId,
          transactionId = transactionId,
          categoryId = matched.id,
          confidence = result.second.coerceIn(0.0, 1.0),
          tier = "llm",
          catalogVersion = 1,
          transactionRevision = revision,
        ),
      ),
    )
    return Suggestion(matched.id, matched.label, result.second.coerceIn(0.0, 1.0))
  }

  private fun request(
    apiKey: String,
    transaction: Map<String, Any?>,
    messageBody: String,
    categories: List<Category>,
  ): Pair<String, Double>? {
    val categoryJson = JSONArray().also { array ->
      categories.forEach { category ->
        array.put(JSONObject().put("id", category.id).put("label", category.label))
      }
    }
    val transactionJson = JSONObject()
      .put("merchant", transaction["merchant_raw"]?.toString().orEmpty())
      .put("amount_minor", (transaction["amount_minor"] as? Number)?.toLong() ?: 0L)
      .put("channel", transaction["channel"]?.toString().orEmpty())
      .put("message", messageBody.take(2_000))
    val userContent = JSONObject()
      .put("transaction", transactionJson)
      .put("allowed_categories", categoryJson)
      .toString()
    val categoryIds = JSONArray().also { array -> categories.forEach { array.put(it.id) } }
    val schema = JSONObject()
      .put("type", "object")
      .put("additionalProperties", false)
      .put("required", JSONArray(listOf("category_id", "confidence")))
      .put("properties", JSONObject()
        .put("category_id", JSONObject().put("type", "string").put("enum", categoryIds))
        .put("confidence", JSONObject().put("type", "number").put("minimum", 0).put("maximum", 1)))
    val payload = JSONObject()
      .put("model", MODEL)
      .put("temperature", 0)
      .put("max_completion_tokens", 120)
      .put("messages", JSONArray()
        .put(JSONObject().put("role", "system").put("content", "Classify the transaction into exactly one allowed monthly budget category. Use merchant, payment channel, and message context. Never invent a category."))
        .put(JSONObject().put("role", "user").put("content", userContent)))
      .put("response_format", JSONObject()
        .put("type", "json_schema")
        .put("json_schema", JSONObject()
          .put("name", "transaction_category")
          .put("strict", true)
          .put("schema", schema)))

    val connection = URL(ENDPOINT).openConnection() as HttpURLConnection
    return try {
      connection.requestMethod = "POST"
      connection.connectTimeout = 3_000
      connection.readTimeout = 4_000
      connection.doOutput = true
      connection.setRequestProperty("Authorization", "Bearer $apiKey")
      connection.setRequestProperty("Content-Type", "application/json")
      connection.outputStream.use { it.write(payload.toString().toByteArray(StandardCharsets.UTF_8)) }
      if (connection.responseCode !in 200..299) return null
      val response = connection.inputStream.bufferedReader().use { it.readText() }
      val content = JSONObject(response)
        .getJSONArray("choices").getJSONObject(0)
        .getJSONObject("message").getString("content")
      val parsed = JSONObject(content)
      parsed.getString("category_id") to parsed.getDouble("confidence")
    } catch (_: Throwable) {
      null
    } finally {
      connection.disconnect()
    }
  }

  private fun stableUuid(value: String): UUID =
    UUID.nameUUIDFromBytes(value.toByteArray(StandardCharsets.UTF_8))

  private data class Category(val id: String, val label: String)
}
