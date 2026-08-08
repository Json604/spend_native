package com.lym.spend.db

import org.junit.Assert.assertEquals
import org.junit.Test

class SqlScriptTest {
  @Test
  fun `splitter preserves semicolons inside quoted values and removes comments`() {
    val statements = SqlScript.statements(
      """
      -- first statement
      INSERT INTO sample (value) VALUES ('one;two');
      /* second statement */
      PRAGMA user_version = 2;
      """.trimIndent(),
    )

    assertEquals(
      listOf(
        "INSERT INTO sample (value) VALUES ('one;two')",
        "PRAGMA user_version = 2",
      ),
      statements,
    )
  }
}
