CREATE TABLE sync_rejected (
  command_id TEXT PRIMARY KEY,
  command_json TEXT NOT NULL,
  error TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
