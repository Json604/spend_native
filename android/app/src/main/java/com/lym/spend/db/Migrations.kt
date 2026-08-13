package com.lym.spend.db

import android.content.Context
import android.database.sqlite.SQLiteDatabase

internal data class Migration(val version: Int, val assetName: String)

object Migrations {
  private val migrationName = Regex("^(\\d{3})_.+\\.sql$")

  internal fun apply(context: Context, database: SQLiteDatabase) {
    val migrations = loadMigrationChain(context)
    val newestVersion = migrations.last().version
    var currentVersion = database.version

    check(currentVersion <= newestVersion) {
      "Database user_version $currentVersion is newer than supported version $newestVersion"
    }

    for (migration in migrations) {
      if (migration.version <= currentVersion) continue
      check(migration.version == currentVersion + 1) {
        "Cannot migrate database from $currentVersion to ${migration.version}; migrations must be N->N+1"
      }

      val script = context.assets.open("migrations/${migration.assetName}")
        .bufferedReader(Charsets.UTF_8)
        .use { it.readText() }

      database.beginTransaction()
      try {
        SqlScript.statements(script).forEach(database::execSQL)
        // Keep the version change atomic with the schema. This is required for
        // sideloaded APKs that skip one or more released app versions.
        database.execSQL("PRAGMA user_version = ${migration.version}")
        database.setTransactionSuccessful()
      } finally {
        database.endTransaction()
      }
      currentVersion = migration.version
    }
    ensureSyncSchema(database)
  }

  private fun ensureSyncSchema(database: SQLiteDatabase) {
    database.execSQL(
      """CREATE TABLE IF NOT EXISTS sync_metadata (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL
         )""",
    )
    val hasRetryColumn = database.rawQuery("PRAGMA table_info(outbox)", emptyArray()).use { cursor ->
      val nameIndex = cursor.getColumnIndex("name")
      var found = false
      while (cursor.moveToNext()) {
        if (cursor.getString(nameIndex) == "next_attempt_at") found = true
      }
      found
    }
    if (!hasRetryColumn) {
      database.execSQL("ALTER TABLE outbox ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0")
    }
    database.execSQL(
      """CREATE INDEX IF NOT EXISTS outbox_ready_created_at_idx
         ON outbox (dead_lettered, next_attempt_at, created_at)""",
    )
    database.execSQL(
      """CREATE TABLE IF NOT EXISTS sync_rejected (
           command_id TEXT PRIMARY KEY,
           command_json TEXT NOT NULL,
           error TEXT NOT NULL,
           attempt_count INTEGER NOT NULL DEFAULT 1,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         )""",
    )
    database.execSQL(
      """CREATE TABLE IF NOT EXISTS category_aliases (
           remote_id TEXT PRIMARY KEY,
           local_id TEXT NOT NULL REFERENCES categories(id)
         )""",
    )
  }

  internal fun loadMigrationChain(context: Context): List<Migration> {
    val migrations = context.assets.list("migrations")
      .orEmpty()
      .mapNotNull { name ->
        migrationName.matchEntire(name)?.let { match ->
          Migration(match.groupValues[1].toInt(), name)
        }
      }
      .sortedBy(Migration::version)

    check(migrations.isNotEmpty()) { "No database migrations were found" }
    migrations.forEachIndexed { index, migration ->
      val expected = index + 1
      check(migration.version == expected) {
        "Migration chain is not replayable: expected version $expected, found ${migration.version}"
      }
    }
    return migrations
  }
}

/** Splits SQLite scripts without treating semicolons in strings/comments as boundaries. */
internal object SqlScript {
  fun statements(script: String): List<String> {
    val statements = mutableListOf<String>()
    val current = StringBuilder()
    var index = 0
    var quote: Char? = null
    var bracketQuote = false
    var lineComment = false
    var blockComment = false

    fun finishStatement() {
      current.toString().trim().takeIf(String::isNotEmpty)?.let(statements::add)
      current.setLength(0)
    }

    while (index < script.length) {
      val char = script[index]
      val next = script.getOrNull(index + 1)

      when {
        lineComment -> {
          if (char == '\n') {
            lineComment = false
            current.append(char)
          }
        }
        blockComment -> {
          if (char == '*' && next == '/') {
            blockComment = false
            index++
          }
        }
        quote != null -> {
          current.append(char)
          if (char == quote) {
            if (next == quote) {
              current.append(next)
              index++
            } else {
              quote = null
            }
          }
        }
        bracketQuote -> {
          current.append(char)
          if (char == ']') bracketQuote = false
        }
        char == '-' && next == '-' -> {
          lineComment = true
          index++
        }
        char == '/' && next == '*' -> {
          blockComment = true
          index++
        }
        char == '\'' || char == '"' || char == '`' -> {
          quote = char
          current.append(char)
        }
        char == '[' -> {
          bracketQuote = true
          current.append(char)
        }
        char == ';' -> finishStatement()
        else -> current.append(char)
      }
      index++
    }

    check(quote == null && !bracketQuote && !blockComment) {
      "Unterminated quoted value or block comment in migration"
    }
    finishStatement()
    return statements
  }
}
