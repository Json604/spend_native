package com.lym.spend.db

import org.json.JSONObject

enum class TransactionDirection(val wireValue: String) {
  DEBIT("debit"),
  CREDIT("credit"),
  TRANSFER("transfer"),
}

enum class TransactionStatus(val wireValue: String) {
  PENDING("pending"),
  POSTED("posted"),
  FAILED("failed"),
  REVERSED("reversed"),
  IGNORED("ignored"),
}

enum class PlanType(val wireValue: String) {
  PLANNED("planned"),
  UNPLANNED("unplanned"),
}

enum class AllocationSource(val wireValue: String) {
  MANUAL("manual"),
  LEARNED("learned"),
  RULE("rule"),
  SIMILARITY("similarity"),
  LLM("llm"),
  MIGRATED("migrated"),
}

enum class PossibleMatchResolution(val wireValue: String) {
  DUPLICATE("duplicate"),
  DISTINCT("distinct"),
}

data class NewTransactionPayload(
  val id: String,
  val occurredAt: Long,
  val receivedAt: Long,
  val accountingMonthKey: String,
  val amountMinor: Long,
  val direction: TransactionDirection,
  val currencyCode: String = "INR",
  val merchantRaw: String? = null,
  val counterpartyKey: String? = null,
  val channel: String? = null,
  val status: TransactionStatus = TransactionStatus.POSTED,
  val planType: PlanType = PlanType.PLANNED,
)

data class NewAlertPayload(
  val id: String,
  val rawSender: String? = null,
  val rawBody: String? = null,
  val receivedAt: Long,
  val providerMessageId: String? = null,
  val subscriptionId: Int? = null,
  val bankReference: String? = null,
  val parseStatus: String = "parsed",
)

data class UpdateAlertParseStatusPayload(
  val alertId: String,
  val parseStatus: String,
)

data class InitialAllocationPayload(
  val id: String? = null,
  val categoryId: String?,
  val source: AllocationSource,
  val confidence: Double? = null,
)

data class CreateTransactionFromAlertPayload(
  val alert: NewAlertPayload,
  val transaction: NewTransactionPayload,
  val allocation: InitialAllocationPayload? = null,
)

data class AssignCategoryPayload(
  val transactionId: String,
  val categoryId: String,
  val source: AllocationSource,
  val confidence: Double? = null,
  val allocationId: String? = null,
)

data class AcceptSuggestionPayload(
  val transactionId: String,
  val suggestionId: String,
  val allocationId: String? = null,
)

data class SetBudgetAmountPayload(
  val monthKey: String,
  val categoryId: String,
  val amountMinor: Long,
  val recurring: Boolean = false,
)

data class ClearMonthBudgetPayload(val monthKey: String)

data class CreateCategoryPayload(
  val categoryId: String,
  val label: String,
  val tint: String? = null,
  val parentId: String? = null,
  val isSystem: Boolean = false,
  val catalogVersion: Int = 1,
)

data class RenameCategoryPayload(val categoryId: String, val label: String)

data class ArchiveCategoryPayload(val categoryId: String)

data class IgnoreTransactionPayload(val transactionId: String)

data class SetPlanTypePayload(val transactionId: String, val planType: PlanType)

data class LinkRefundPayload(
  val refundTransactionId: String,
  val originalTransactionId: String,
)

data class RecordSuggestionPayload(
  val suggestionId: String,
  val transactionId: String,
  val categoryId: String,
  val confidence: Double,
  val tier: String,
  val catalogVersion: Int,
  val transactionRevision: Int,
)

data class ResolvePossibleMatchPayload(
  val possibleMatchId: String,
  val resolution: PossibleMatchResolution,
)

/** Data-only mirror of the closed TypeScript Command union. */
sealed class Command(open val commandId: String, val kind: String) {
  data class CreateTransactionFromAlert(
    override val commandId: String,
    val payload: CreateTransactionFromAlertPayload,
  ) : Command(commandId, KIND) {
    companion object { const val KIND = "createTransactionFromAlert" }
  }

  /** Stores an incoming provider alert before any parsing decision is made. */
  data class RecordSourceAlert(
    override val commandId: String,
    val payload: NewAlertPayload,
  ) : Command(commandId, KIND) {
    companion object { const val KIND = "recordSourceAlert" }
  }

  data class UpdateAlertParseStatus(
    override val commandId: String,
    val payload: UpdateAlertParseStatusPayload,
  ) : Command(commandId, KIND) {
    companion object { const val KIND = "updateAlertParseStatus" }
  }

  data class AssignCategory(
    override val commandId: String,
    val expectedRevision: Int,
    val payload: AssignCategoryPayload,
  ) : Command(commandId, KIND) {
    init {
      require(payload.source != AllocationSource.MIGRATED) {
        "migrated is not an assignable allocation source"
      }
    }
    companion object { const val KIND = "assignCategory" }
  }

  data class AcceptSuggestion(
    override val commandId: String,
    val expectedRevision: Int,
    val payload: AcceptSuggestionPayload,
  ) : Command(commandId, KIND) {
    companion object { const val KIND = "acceptSuggestion" }
  }

  data class SetBudgetAmount(
    override val commandId: String,
    val expectedRevision: Int,
    val payload: SetBudgetAmountPayload,
  ) : Command(commandId, KIND) {
    companion object { const val KIND = "setBudgetAmount" }
  }

  data class ClearMonthBudget(
    override val commandId: String,
    val expectedRevision: Int,
    val payload: ClearMonthBudgetPayload,
  ) : Command(commandId, KIND) {
    companion object { const val KIND = "clearMonthBudget" }
  }

  data class CreateCategory(
    override val commandId: String,
    val payload: CreateCategoryPayload,
  ) : Command(commandId, KIND) {
    companion object { const val KIND = "createCategory" }
  }

  data class RenameCategory(
    override val commandId: String,
    val expectedRevision: Int,
    val payload: RenameCategoryPayload,
  ) : Command(commandId, KIND) {
    companion object { const val KIND = "renameCategory" }
  }

  data class ArchiveCategory(
    override val commandId: String,
    val expectedRevision: Int,
    val payload: ArchiveCategoryPayload,
  ) : Command(commandId, KIND) {
    companion object { const val KIND = "archiveCategory" }
  }

  data class IgnoreTransaction(
    override val commandId: String,
    val expectedRevision: Int,
    val payload: IgnoreTransactionPayload,
  ) : Command(commandId, KIND) {
    companion object { const val KIND = "ignoreTransaction" }
  }

  data class SetPlanType(
    override val commandId: String,
    val expectedRevision: Int,
    val payload: SetPlanTypePayload,
  ) : Command(commandId, KIND) {
    companion object { const val KIND = "setPlanType" }
  }

  data class LinkRefund(
    override val commandId: String,
    val expectedRevision: Int,
    val payload: LinkRefundPayload,
  ) : Command(commandId, KIND) {
    companion object { const val KIND = "linkRefund" }
  }

  data class RecordSuggestion(
    override val commandId: String,
    val payload: RecordSuggestionPayload,
  ) : Command(commandId, KIND) {
    companion object { const val KIND = "recordSuggestion" }
  }

  data class ResolvePossibleMatch(
    override val commandId: String,
    val expectedRevision: Int,
    val payload: ResolvePossibleMatchPayload,
  ) : Command(commandId, KIND) {
    companion object { const val KIND = "resolvePossibleMatch" }
  }

  internal fun toJson(): JSONObject {
    val json = JSONObject()
      .put("commandId", commandId)
      .put("kind", kind)

    when (this) {
      is CreateTransactionFromAlert -> json.put("payload", payload.toJson())
      is RecordSourceAlert -> json.put("payload", payload.toJson())
      is UpdateAlertParseStatus -> json.put("payload", payload.toJson())
      is AssignCategory -> json.put("expectedRevision", expectedRevision).put("payload", payload.toJson())
      is AcceptSuggestion -> json.put("expectedRevision", expectedRevision).put("payload", payload.toJson())
      is SetBudgetAmount -> json.put("expectedRevision", expectedRevision).put("payload", payload.toJson())
      is ClearMonthBudget -> json.put("expectedRevision", expectedRevision).put("payload", payload.toJson())
      is CreateCategory -> json.put("payload", payload.toJson())
      is RenameCategory -> json.put("expectedRevision", expectedRevision).put("payload", payload.toJson())
      is ArchiveCategory -> json.put("expectedRevision", expectedRevision).put("payload", payload.toJson())
      is IgnoreTransaction -> json.put("expectedRevision", expectedRevision).put("payload", payload.toJson())
      is SetPlanType -> json.put("expectedRevision", expectedRevision).put("payload", payload.toJson())
      is LinkRefund -> json.put("expectedRevision", expectedRevision).put("payload", payload.toJson())
      is RecordSuggestion -> json.put("payload", payload.toJson())
      is ResolvePossibleMatch -> json.put("expectedRevision", expectedRevision).put("payload", payload.toJson())
    }
    return json
  }
}

sealed class CommandResult {
  abstract val commandId: String
  abstract val kind: String
  abstract val entityId: String
  abstract val revision: Int
  abstract val status: String

  data class Applied(
    override val commandId: String,
    override val kind: String,
    override val entityId: String,
    override val revision: Int,
  ) : CommandResult() {
    override val status: String = "applied"
  }

  data class Noop(
    override val commandId: String,
    override val kind: String,
    override val entityId: String,
    override val revision: Int,
    val reason: String,
  ) : CommandResult() {
    override val status: String = "noop"
  }

  internal fun toJsonString(): String {
    val json = JSONObject()
      .put("commandId", commandId)
      .put("kind", kind)
      .put("status", status)
      .put("entityId", entityId)
      .put("revision", revision)
    if (this is Noop) json.put("reason", reason)
    return json.toString()
  }

  companion object {
    internal fun fromJsonString(value: String): CommandResult {
      val json = JSONObject(value)
      val common = arrayOf(
        json.getString("commandId"),
        json.getString("kind"),
        json.getString("entityId"),
      )
      val revision = json.getInt("revision")
      return when (json.getString("status")) {
        "applied" -> Applied(common[0], common[1], common[2], revision)
        "noop" -> Noop(common[0], common[1], common[2], revision, json.getString("reason"))
        else -> error("Unknown command result status: ${json.getString("status")}")
      }
    }
  }
}

private fun JSONObject.putOptional(name: String, value: Any?): JSONObject {
  if (value != null) put(name, value)
  return this
}

private fun NewTransactionPayload.toJson() = JSONObject()
  .put("id", id)
  .put("occurredAt", occurredAt)
  .put("receivedAt", receivedAt)
  .put("accountingMonthKey", accountingMonthKey)
  .put("amountMinor", amountMinor)
  .put("direction", direction.wireValue)
  .put("currencyCode", currencyCode)
  .putOptional("merchantRaw", merchantRaw)
  .putOptional("counterpartyKey", counterpartyKey)
  .putOptional("channel", channel)
  .put("status", status.wireValue)
  .put("planType", planType.wireValue)

private fun NewAlertPayload.toJson() = JSONObject()
  .put("id", id)
  .putOptional("rawSender", rawSender)
  .putOptional("rawBody", rawBody)
  .put("receivedAt", receivedAt)
  .putOptional("providerMessageId", providerMessageId)
  .putOptional("subscriptionId", subscriptionId)
  .putOptional("bankReference", bankReference)
  .put("parseStatus", parseStatus)

private fun InitialAllocationPayload.toJson() = JSONObject()
  .putOptional("id", id)
  .put("categoryId", categoryId ?: JSONObject.NULL)
  .put("source", source.wireValue)
  .putOptional("confidence", confidence)

private fun CreateTransactionFromAlertPayload.toJson() = JSONObject()
  .put("alert", alert.toJson())
  .put("transaction", transaction.toJson())
  .also { if (allocation != null) it.put("allocation", allocation.toJson()) }

private fun UpdateAlertParseStatusPayload.toJson() = JSONObject()
  .put("alertId", alertId)
  .put("parseStatus", parseStatus)

private fun AssignCategoryPayload.toJson() = JSONObject()
  .put("transactionId", transactionId)
  .put("categoryId", categoryId)
  .put("source", source.wireValue)
  .putOptional("confidence", confidence)
  .putOptional("allocationId", allocationId)

private fun AcceptSuggestionPayload.toJson() = JSONObject()
  .put("transactionId", transactionId)
  .put("suggestionId", suggestionId)
  .putOptional("allocationId", allocationId)

private fun SetBudgetAmountPayload.toJson() = JSONObject()
  .put("monthKey", monthKey)
  .put("categoryId", categoryId)
  .put("amountMinor", amountMinor)
  .put("recurring", recurring)

private fun ClearMonthBudgetPayload.toJson() = JSONObject().put("monthKey", monthKey)

private fun CreateCategoryPayload.toJson() = JSONObject()
  .put("categoryId", categoryId)
  .put("label", label)
  .putOptional("tint", tint)
  .putOptional("parentId", parentId)
  .put("isSystem", isSystem)
  .put("catalogVersion", catalogVersion)

private fun RenameCategoryPayload.toJson() = JSONObject().put("categoryId", categoryId).put("label", label)
private fun ArchiveCategoryPayload.toJson() = JSONObject().put("categoryId", categoryId)
private fun IgnoreTransactionPayload.toJson() = JSONObject().put("transactionId", transactionId)
private fun SetPlanTypePayload.toJson() = JSONObject().put("transactionId", transactionId).put("planType", planType.wireValue)
private fun LinkRefundPayload.toJson() = JSONObject().put("refundTransactionId", refundTransactionId).put("originalTransactionId", originalTransactionId)
private fun RecordSuggestionPayload.toJson() = JSONObject()
  .put("suggestionId", suggestionId)
  .put("transactionId", transactionId)
  .put("categoryId", categoryId)
  .put("confidence", confidence)
  .put("tier", tier)
  .put("catalogVersion", catalogVersion)
  .put("transactionRevision", transactionRevision)
private fun ResolvePossibleMatchPayload.toJson() = JSONObject()
  .put("possibleMatchId", possibleMatchId)
  .put("resolution", resolution.wireValue)
