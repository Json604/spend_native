package com.lym.spend.db

import android.content.Context
import android.content.ContextWrapper
import android.database.sqlite.SQLiteDatabase
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.lang.reflect.InvocationTargetException
import java.util.UUID
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SpendDatabaseModuleTest {
  @Test
  fun readOnlyGuardAcceptsOnlyReadStatements() {
    listOf(
      "SELECT * FROM transactions",
      "  select 1 ",
      "WITH x AS (SELECT 1) SELECT * FROM x",
    ).forEach { sql ->
      assertEquals(sql.trim(), NativeReadOnlySql.requireSingleRead(sql))
    }
  }

  @Test
  fun readOnlyGuardRejectsWritesAndMalformedReads() {
    listOf(
      "DELETE FROM transactions",
      "UPDATE transactions SET amount_minor = 0",
      "INSERT INTO categories (id) VALUES (1)",
      "DROP TABLE categories",
      "SELECT 1; DROP TABLE categories",
      "WITH x AS (DELETE FROM transactions RETURNING id) SELECT * FROM x",
      "",
      "   ",
      "PRAGMA user_version = 99",
    ).forEach(::assertReadOnlyViolation)
  }

  @Test
  fun errorCodeMappingCoversKnownErrorsAndUsesFallbackForUnknownErrors() {
    assertEquals("CONFLICT", errorCodeFor(ConflictError("category", 1, 2)))
    assertEquals(
      "ALLOCATION_INVARIANT",
      errorCodeFor(AllocationInvariantError("transaction", 100, 90)),
    )
    assertEquals("ROW_NOT_FOUND", errorCodeFor(RowNotFoundError("missing")))
    assertEquals("READ_ONLY_VIOLATION", errorCodeFor(ReadOnlyViolation("write")))
    assertEquals("EXECUTE_FAILED", errorCodeFor(IllegalStateException("unknown")))
  }

  @Test
  fun serializedCreateCategoryCommandParsesAndExecutes() = withFreshDatabase { coordinator ->
    val command = createCategoryCommand()
    val parsed = Command.fromJsonString(command.toJson().toString())

    assertEquals(command, parsed)
    val result = coordinator.execute(parsed)
    assertTrue(result is CommandResult.Applied)
    assertEquals(command.payload.categoryId, result.entityId)
  }

  @Test
  fun replayingSerializedCreateCategoryCommandWritesExactlyOnce() = withFreshDatabase { coordinator ->
    val command = createCategoryCommand()
    val commandJson = command.toJson().toString()

    val firstResult = coordinator.execute(Command.fromJsonString(commandJson))
    val replayResult = coordinator.execute(Command.fromJsonString(commandJson))
    val counts = coordinator.query(
      """SELECT
           (SELECT count(*) FROM categories WHERE id = ?) categories,
           (SELECT count(*) FROM outbox WHERE id = ?) outbox,
           (SELECT count(*) FROM processed_commands WHERE command_id = ?) processed""",
      arrayOf(command.payload.categoryId, command.commandId, command.commandId),
    ).single()

    assertEquals(firstResult, replayResult)
    assertEquals(1L, counts["categories"])
    assertEquals(1L, counts["outbox"])
    assertEquals(1L, counts["processed"])
  }

  @Test
  fun serializedCommandWithStaleExpectedRevisionProducesConflict() = withFreshDatabase { coordinator ->
    val categoryId = UUID.randomUUID().toString()
    coordinator.execute(
      Command.CreateCategory(
        UUID.randomUUID().toString(),
        CreateCategoryPayload(categoryId, "Food"),
      ),
    )
    val staleCommand = Command.RenameCategory(
      commandId = UUID.randomUUID().toString(),
      expectedRevision = 0,
      payload = RenameCategoryPayload(categoryId, "Meals"),
    )

    try {
      coordinator.execute(Command.fromJsonString(staleCommand.toJson().toString()))
      fail("Expected a revision conflict")
    } catch (error: ConflictError) {
      assertEquals("CONFLICT", errorCodeFor(error))
      assertEquals(categoryId, error.entityId)
      assertEquals(0, error.expectedRevision)
      assertEquals(1, error.actualRevision)
    }
  }

  private fun assertReadOnlyViolation(sql: String) {
    try {
      NativeReadOnlySql.requireSingleRead(sql)
      fail("Expected ReadOnlyViolation for SQL: $sql")
    } catch (_: ReadOnlyViolation) {
      // Expected.
    }
  }

  private fun createCategoryCommand(): Command.CreateCategory {
    return Command.CreateCategory(
      commandId = UUID.randomUUID().toString(),
      payload = CreateCategoryPayload(
        categoryId = UUID.randomUUID().toString(),
        label = "Module test category",
      ),
    )
  }

  private fun testContext(): Context = InstrumentationRegistry.getInstrumentation().targetContext

  private fun <T> withFreshDatabase(block: (SpendCoordinator) -> T): T {
    val file = freshDatabaseFile()
    val context = TemporaryDatabaseContext(testContext(), file)
    val database = newSpendDatabase(context)
    val coordinator = newSpendCoordinator(database)
    return try {
      block(coordinator)
    } finally {
      closeSpendDatabase(database)
      deleteDatabaseFiles(file)
    }
  }

  private fun freshDatabaseFile(): File {
    val directory = File(testContext().cacheDir, "spend-instrumented-databases")
    check(directory.exists() || directory.mkdirs())
    return File(directory, "spend-${UUID.randomUUID()}.sqlite")
  }

  private fun newSpendDatabase(context: Context): SpendDatabase = try {
    SpendDatabase::class.java.getDeclaredConstructor(Context::class.java).apply {
      isAccessible = true
    }.newInstance(context)
  } catch (error: InvocationTargetException) {
    throw (error.cause ?: error)
  }

  private fun newSpendCoordinator(database: SpendDatabase): SpendCoordinator =
    SpendCoordinator::class.java.getDeclaredConstructor(SpendDatabase::class.java).apply {
      isAccessible = true
    }.newInstance(database)

  private fun closeSpendDatabase(database: SpendDatabase) {
    SpendDatabase::class.java.getDeclaredField("database").apply {
      isAccessible = true
    }.get(database).let { (it as SQLiteDatabase).close() }
  }

  private fun deleteDatabaseFiles(file: File) {
    file.delete()
    File(file.path + "-wal").delete()
    File(file.path + "-shm").delete()
  }

  private class TemporaryDatabaseContext(
    base: Context,
    private val databaseFile: File,
  ) : ContextWrapper(base) {
    override fun getApplicationContext(): Context = this

    override fun getDatabasePath(name: String): File = databaseFile
  }
}
