-- The server is the system of record, so it must enforce its own invariants.
-- Category-label uniqueness was previously enforced ONLY on the device, which
-- means it was not enforced at all: any client bug, any op replay, or simply a
-- second device could — and did — create duplicates here. One user ended up
-- with "Laptop repair" three times and an August budget of Rs1,62,229 against a
-- real Rs76,600, because every duplicate carried its own budget line.
--
-- A constraint belongs at the authority. A client-side check is a convenience
-- for the user, never a guarantee for the data.

CREATE UNIQUE INDEX IF NOT EXISTS categories_user_label_unique
  ON categories (user_id, lower(data->>'label'))
  WHERE deleted_at IS NULL;

-- Budgets are one line per (user, month, category). The same reasoning applies:
-- without this, a replayed op silently doubles a month's budget.
CREATE UNIQUE INDEX IF NOT EXISTS budgets_user_month_category_unique
  ON budgets (user_id, (data->>'monthKey'), (data->>'categoryId'))
  WHERE deleted_at IS NULL;

-- One allocation per transaction per category, for the same reason.
CREATE UNIQUE INDEX IF NOT EXISTS allocations_user_txn_category_unique
  ON transaction_allocations (user_id, transaction_id, (data->>'categoryId'))
  WHERE deleted_at IS NULL;
