CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  google_sub text NOT NULL UNIQUE,
  email text,
  name text,
  picture text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  name text,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, device_id)
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  parent_id uuid REFERENCES refresh_tokens(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx ON refresh_tokens(family_id);

CREATE TABLE IF NOT EXISTS transactions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  field_clocks jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  server_seq bigint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS transaction_allocations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transaction_id uuid,
  source text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  field_clocks jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  server_seq bigint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS categories (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  field_clocks jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  server_seq bigint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS category_memory (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  field_clocks jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  server_seq bigint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS budgets (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  field_clocks jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  server_seq bigint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS source_alerts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  field_clocks jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  server_seq bigint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS suggestions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  field_clocks jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  server_seq bigint NOT NULL DEFAULT 0
);

CREATE SEQUENCE IF NOT EXISTS sync_sequence AS bigint;
CREATE TABLE IF NOT EXISTS sync_ops (
  op_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('upsert', 'delete')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome jsonb NOT NULL DEFAULT '{}'::jsonb,
  server_seq bigint NOT NULL DEFAULT nextval('sync_sequence'),
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sync_ops_user_seq_idx ON sync_ops(user_id, server_seq);
