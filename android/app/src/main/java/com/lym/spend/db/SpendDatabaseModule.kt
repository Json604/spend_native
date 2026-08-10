package com.lym.spend.db

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** The only JavaScript door to the native SpendCoordinator. */
class SpendDatabaseModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private val executor: ExecutorService = Executors.newSingleThreadExecutor()

  override fun getName(): String = MODULE_NAME

  @ReactMethod
  fun execute(commandJson: String, promise: Promise) {
    executor.execute {
      try {
        val command = Command.fromJsonString(commandJson)
        val result = SpendCoordinator.getInstance(reactApplicationContext).execute(command)
        promise.resolve(result.toJsonString())
      } catch (error: Throwable) {
        rejectCommandError(promise, error)
      }
    }
  }

  @ReactMethod
  fun query(sql: String, paramsJson: String, promise: Promise) {
    executor.execute {
      try {
        val statement = NativeReadOnlySql.requireSingleRead(sql)
        val params = parseSelectionArgs(paramsJson)
        val rows = SpendCoordinator.getInstance(reactApplicationContext)
          .query(statement, params)
        promise.resolve(rowsToJson(rows))
      } catch (error: ReadOnlyViolation) {
        promise.reject(errorCodeFor(error), error.message)
      } catch (error: Throwable) {
        promise.reject(QUERY_FAILED, error.message, error)
      }
    }
  }

  @ReactMethod
  fun claimLocalData(userId: String, deviceId: String, promise: Promise) {
    executor.execute {
      try {
        promise.resolve(
          SpendCoordinator.getInstance(reactApplicationContext).claimLocalData(userId, deviceId),
        )
      } catch (error: Throwable) {
        rejectCommandError(promise, error)
      }
    }
  }

  @ReactMethod
  fun acknowledgeOutbox(idsJson: String, promise: Promise) {
    executor.execute {
      try {
        promise.resolve(SpendCoordinator.getInstance(reactApplicationContext).acknowledgeOutbox(idsJson))
      } catch (error: Throwable) {
        rejectCommandError(promise, error)
      }
    }
  }

  @ReactMethod
  fun recordOutboxFailure(id: String, errorMessage: String, maxAttempts: Int, promise: Promise) {
    executor.execute {
      try {
        promise.resolve(
          SpendCoordinator.getInstance(reactApplicationContext)
            .recordOutboxFailure(id, errorMessage, maxAttempts),
        )
      } catch (error: Throwable) {
        rejectCommandError(promise, error)
      }
    }
  }

  @ReactMethod
  fun recoverDeadLettersOnce(migrationKey: String, promise: Promise) {
    executor.execute {
      try {
        promise.resolve(
          SpendCoordinator.getInstance(reactApplicationContext).recoverDeadLettersOnce(migrationKey),
        )
      } catch (error: Throwable) {
        rejectCommandError(promise, error)
      }
    }
  }

  @ReactMethod
  fun applyPulledOps(commandsJson: String, cursor: String, userId: String, promise: Promise) {
    executor.execute {
      try {
        promise.resolve(
          SpendCoordinator.getInstance(reactApplicationContext)
            .applyPulledOps(commandsJson, cursor, userId),
        )
      } catch (error: Throwable) {
        rejectCommandError(promise, error)
      }
    }
  }

  @ReactMethod
  fun getDeadLetterCount(promise: Promise) {
    executor.execute {
      try {
        promise.resolve(SpendCoordinator.getInstance(reactApplicationContext).deadLetterCount())
      } catch (error: Throwable) {
        rejectCommandError(promise, error)
      }
    }
  }

  private fun parseSelectionArgs(paramsJson: String): Array<String> {
    val params = JSONArray(paramsJson)
    return Array(params.length()) { index ->
      if (params.isNull(index)) "null" else params.get(index).toString()
    }
  }

  private fun rowsToJson(rows: List<Map<String, Any?>>): String {
    val json = JSONArray()
    rows.forEach { row ->
      val item = JSONObject()
      row.forEach { (column, value) -> item.put(column, jsonValue(value)) }
      json.put(item)
    }
    return json.toString()
  }

  private fun jsonValue(value: Any?): Any = when (value) {
    null -> JSONObject.NULL
    is ByteArray -> value.joinToString(separator = ",", prefix = "[", postfix = "]")
    else -> value
  }

  private fun rejectCommandError(promise: Promise, error: Throwable) {
    val code = errorCodeFor(error)
    when (error) {
      is ConflictError -> promise.reject(
        code,
        error.message,
        Arguments.createMap().apply {
          putString("entityId", error.entityId)
          putInt("expectedRevision", error.expectedRevision)
          putInt("actualRevision", error.actualRevision)
        },
      )
      is AllocationInvariantError -> promise.reject(
        code,
        error.message,
        Arguments.createMap().apply {
          putString("transactionId", error.transactionId)
          putDouble("transactionAmountMinor", error.transactionAmountMinor.toDouble())
          putDouble("allocationAmountMinor", error.allocationAmountMinor.toDouble())
        },
      )
      is RowNotFoundError -> promise.reject(
        code,
        error.message,
        Arguments.createMap().apply { putString("entityId", error.entityId) },
      )
      is SyncOwnershipError -> promise.reject(
        SYNC_OWNERSHIP,
        error.message,
        Arguments.createMap().apply {
          putString("ownerId", error.ownerId)
          putString("requestedUserId", error.requestedUserId)
        },
      )
      else -> promise.reject(code, error.message, error)
    }
  }

  companion object {
    const val MODULE_NAME = "SpendDatabase"
    const val CONFLICT = "CONFLICT"
    const val ALLOCATION_INVARIANT = "ALLOCATION_INVARIANT"
    const val ROW_NOT_FOUND = "ROW_NOT_FOUND"
    const val SYNC_OWNERSHIP = "SYNC_OWNERSHIP"
    const val READ_ONLY_VIOLATION = "READ_ONLY_VIOLATION"
    internal const val EXECUTE_FAILED = "EXECUTE_FAILED"
    private const val QUERY_FAILED = "QUERY_FAILED"
  }
}

internal class ReadOnlyViolation(message: String) : IllegalArgumentException(message)

internal fun errorCodeFor(error: Throwable): String = when (error) {
  is ConflictError -> SpendDatabaseModule.CONFLICT
  is AllocationInvariantError -> SpendDatabaseModule.ALLOCATION_INVARIANT
  is RowNotFoundError -> SpendDatabaseModule.ROW_NOT_FOUND
  is SyncOwnershipError -> SpendDatabaseModule.SYNC_OWNERSHIP
  is ReadOnlyViolation -> SpendDatabaseModule.READ_ONLY_VIOLATION
  else -> SpendDatabaseModule.EXECUTE_FAILED
}

/** Shared validator for the stricter JavaScript-facing query contract. */
internal object NativeReadOnlySql {
  fun requireSingleRead(sql: String): String {
    val statements = try {
      SqlScript.statements(sql.trim())
    } catch (error: IllegalStateException) {
      throw ReadOnlyViolation(error.message ?: "Invalid SQL")
    }
    if (statements.size != 1) {
      throw ReadOnlyViolation("query() accepts exactly one read-only SQL statement")
    }

    val statement = statements.single()
    if (isRead(statement)) return statement
    throw ReadOnlyViolation("query() only permits a single SELECT or read-only WITH statement")
  }

  fun isRead(statement: String): Boolean {
    if (statement.matches(Regex("(?is)^SELECT\\b.*"))) return true
    if (!statement.matches(Regex("(?is)^WITH\\b.*"))) return false

    val words = sqlWords(statement)
    return words.contains("SELECT") &&
      words.none { it in setOf("INSERT", "UPDATE", "DELETE", "REPLACE") }
  }

  private fun sqlWords(sql: String): List<String> {
    val words = mutableListOf<String>()
    var index = 0
    var quote: Char? = null
    var bracketQuote = false
    var lineComment = false
    var blockComment = false
    while (index < sql.length) {
      val char = sql[index]
      val next = sql.getOrNull(index + 1)
      when {
        lineComment -> if (char == '\n') lineComment = false
        blockComment -> if (char == '*' && next == '/') {
          blockComment = false
          index++
        }
        bracketQuote -> if (char == ']') bracketQuote = false
        quote != null -> if (char == quote) {
          if (next == quote) index++ else quote = null
        }
        char == '-' && next == '-' -> {
          lineComment = true
          index++
        }
        char == '/' && next == '*' -> {
          blockComment = true
          index++
        }
        char == '\'' || char == '"' || char == '`' -> quote = char
        char == '[' -> bracketQuote = true
        char.isLetter() || char == '_' -> {
          val start = index
          while (index + 1 < sql.length &&
            (sql[index + 1].isLetterOrDigit() || sql[index + 1] == '_')) index++
          words += sql.substring(start, index + 1).uppercase()
        }
      }
      index++
    }
    return words
  }
}
