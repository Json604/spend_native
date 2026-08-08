package com.lym.spend.db

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.os.Build
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Process-wide owner of the local SQLite handle and its only native write lock.
 *
 * JS must open this exact same context.getDatabasePath("spend.sqlite") path; a
 * relative or library-default path would create a different database file.
 */
class SpendDatabase private constructor(context: Context) {
  private val writerLock = ReentrantLock(true)
  private val database: SQLiteDatabase

  init {
    val appContext = context.applicationContext
    val databasePath = appContext.getDatabasePath(DATABASE_NAME)
    check(databasePath.parentFile?.let { it.exists() || it.mkdirs() } == true) {
      "Could not create database directory for ${databasePath.absolutePath}"
    }

    database = SQLiteDatabase.openDatabase(
      databasePath.absolutePath,
      null,
      SQLiteDatabase.OPEN_READWRITE or
        SQLiteDatabase.CREATE_IF_NECESSARY or
        SQLiteDatabase.NO_LOCALIZED_COLLATORS,
    )

    try {
      writerLock.withLock {
        check(database.enableWriteAheadLogging()) { "Could not enable WAL for ${databasePath.absolutePath}" }
        database.setForeignKeyConstraintsEnabled(true)
        setBusyTimeoutOnEveryConnection(database)
        Migrations.apply(appContext, database)
      }
    } catch (error: Throwable) {
      database.close()
      throw error
    }
  }

  internal fun <T> writeTransaction(block: (SQLiteDatabase) -> T): T = writerLock.withLock {
    database.beginTransaction()
    try {
      val result = block(database)
      database.setTransactionSuccessful()
      result
    } finally {
      database.endTransaction()
    }
  }

  internal fun <T> read(block: (SQLiteDatabase) -> T): T = block(database)

  private fun setBusyTimeoutOnEveryConnection(database: SQLiteDatabase) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      database.execPerConnectionSQL("PRAGMA busy_timeout = $BUSY_TIMEOUT_MS", null)
    } else {
      // API 24-29 do not expose execPerConnectionSQL. WAL has one primary write
      // connection, and all native writes use that connection via writerLock.
      database.execSQL("PRAGMA busy_timeout = $BUSY_TIMEOUT_MS")
    }
  }

  companion object {
    const val DATABASE_NAME = "spend.sqlite"
    private const val BUSY_TIMEOUT_MS = 5_000

    @Volatile
    private var instance: SpendDatabase? = null

    fun getInstance(context: Context): SpendDatabase =
      instance ?: synchronized(this) {
        instance ?: SpendDatabase(context).also { instance = it }
      }
  }
}
