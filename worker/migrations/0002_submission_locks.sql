CREATE TABLE IF NOT EXISTS ops_submission_locks (
  scope_key TEXT PRIMARY KEY,
  outlet_id TEXT NOT NULL DEFAULT '',
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL DEFAULT '',
  owner_token TEXT NOT NULL,
  owner_client_id TEXT NOT NULL DEFAULT '',
  owner_email TEXT NOT NULL DEFAULT '',
  owner_name TEXT NOT NULL DEFAULT '',
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ops_submission_locks_outlet
  ON ops_submission_locks (outlet_id, resource_type, expires_at);
