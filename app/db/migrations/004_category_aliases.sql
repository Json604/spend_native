CREATE TABLE IF NOT EXISTS category_aliases (
  remote_id TEXT PRIMARY KEY,
  local_id TEXT NOT NULL REFERENCES categories(id)
);
