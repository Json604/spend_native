PRAGMA foreign_keys = ON;

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  occurred_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  accounting_month_key TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('debit','credit','transfer')),
  currency_code TEXT NOT NULL DEFAULT 'INR',
  merchant_raw TEXT,
  counterparty_key TEXT,
  channel TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','posted','failed','reversed','ignored')),
  plan_type TEXT NOT NULL DEFAULT 'planned' CHECK(plan_type IN ('planned','unplanned')),
  reverses_transaction_id TEXT NULL REFERENCES transactions(id),
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER NULL
);

CREATE INDEX transactions_accounting_month_key_idx
  ON transactions (accounting_month_key);
CREATE INDEX transactions_occurred_at_idx
  ON transactions (occurred_at);
CREATE INDEX transactions_counterparty_key_idx
  ON transactions (counterparty_key);

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  tint TEXT,
  parent_id TEXT NULL REFERENCES categories(id),
  is_system INTEGER NOT NULL DEFAULT 0,
  catalog_version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER NULL
);

CREATE UNIQUE INDEX categories_active_label_idx
  ON categories (lower(label))
  WHERE deleted_at IS NULL;

CREATE TABLE transaction_allocations (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  category_id TEXT NULL REFERENCES categories(id) ON DELETE SET NULL,
  amount_minor INTEGER NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('manual','learned','rule','similarity','llm','migrated')),
  confidence REAL NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX transaction_allocations_transaction_id_idx
  ON transaction_allocations (transaction_id);
CREATE INDEX transaction_allocations_category_id_idx
  ON transaction_allocations (category_id);

-- The invariant "sum of active allocations == transaction.amount_minor" cannot
-- be expressed as a SQLite CHECK constraint; the coordinator enforces it.

CREATE TABLE category_memory (
  id TEXT PRIMARY KEY,
  counterparty_key TEXT NOT NULL,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  observation_count INTEGER NOT NULL DEFAULT 1,
  last_observed_at INTEGER NOT NULL,
  provisional INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE(counterparty_key, category_id)
);

CREATE TABLE budgets (
  month_key TEXT NOT NULL,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  amount_minor INTEGER NOT NULL,
  recurring INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(month_key, category_id)
);

-- "recurring" lives here on budgets and never on categories.

CREATE TABLE source_alerts (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NULL REFERENCES transactions(id) ON DELETE SET NULL,
  raw_sender TEXT,
  raw_body TEXT,
  received_at INTEGER NOT NULL,
  provider_message_id TEXT,
  subscription_id INTEGER NULL,
  bank_reference TEXT NULL,
  parse_status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(provider_message_id, subscription_id)
);

-- Provider-message identity deduplicates ingestion only. No payment-field unique
-- constraint is present, so a genuine duplicate payment remains representable.

CREATE TABLE possible_matches (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  reason TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Fuzzy duplicate candidates are reviewable relations, deliberately not constraints.

CREATE TABLE suggestions (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL,
  confidence REAL NOT NULL,
  tier TEXT NOT NULL,
  catalog_version INTEGER NOT NULL,
  transaction_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  accepted_at INTEGER NULL
);

-- Suggestions never write transaction_allocations until the user accepts them.

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  op TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  dead_lettered INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- outbox.id is a UUID idempotency key, never an autoincrementing sequence.
CREATE INDEX outbox_dead_lettered_created_at_idx
  ON outbox (dead_lettered, created_at);

CREATE TABLE migration_origin (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  source_system TEXT NOT NULL,
  legacy_user_id TEXT NOT NULL,
  legacy_table TEXT NOT NULL,
  legacy_pk TEXT NOT NULL,
  imported_at INTEGER NOT NULL,
  UNIQUE(source_system, legacy_user_id, legacy_table, legacy_pk)
);

PRAGMA user_version = 1;
