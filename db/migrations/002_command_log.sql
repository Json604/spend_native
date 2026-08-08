CREATE TABLE processed_commands (
  command_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- These columns make optimistic concurrency available to every mutable row
-- introduced by 001 without rewriting that already-shipped migration.
ALTER TABLE categories ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE budgets ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE source_alerts ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE source_alerts ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transaction_allocations ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE category_memory ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE possible_matches ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE possible_matches ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE possible_matches ADD COLUMN resolution TEXT NULL
  CHECK(resolution IS NULL OR resolution IN ('duplicate', 'distinct'));
ALTER TABLE suggestions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE suggestions ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;

-- A month is the concurrency boundary for set/clear budget commands.  Keeping
-- that revision separately lets clearMonthBudget protect a whole collection.
CREATE TABLE budget_month_revisions (
  month_key TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO budget_month_revisions (month_key, revision, updated_at)
SELECT month_key, 1, max(updated_at)
FROM budgets
GROUP BY month_key;
