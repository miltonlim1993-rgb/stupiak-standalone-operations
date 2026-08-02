PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspace_records (
  entity TEXT NOT NULL,
  record_id TEXT NOT NULL,
  outlet_id TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT '',
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'd1',
  PRIMARY KEY (entity, record_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_records_entity_outlet_updated
  ON workspace_records (entity, outlet_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_records_outlet_updated
  ON workspace_records (outlet_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_records_status
  ON workspace_records (entity, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS mutation_idempotency (
  mutation_id TEXT PRIMARY KEY,
  entity TEXT NOT NULL,
  record_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mutation_idempotency_expires
  ON mutation_idempotency (expires_at);

CREATE TABLE IF NOT EXISTS sheet_sync_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mutation_id TEXT NOT NULL UNIQUE,
  entity TEXT NOT NULL,
  record_id TEXT NOT NULL,
  outlet_id TEXT NOT NULL DEFAULT '',
  operation TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  synced_at TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_sheet_sync_outbox_pending
  ON sheet_sync_outbox (status, next_attempt_at, id);

CREATE INDEX IF NOT EXISTS idx_sheet_sync_outbox_record
  ON sheet_sync_outbox (entity, record_id, id DESC);

CREATE TABLE IF NOT EXISTS sync_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,
  record_id TEXT NOT NULL,
  outlet_id TEXT NOT NULL DEFAULT '',
  d1_version INTEGER NOT NULL DEFAULT 0,
  sheet_version INTEGER NOT NULL DEFAULT 0,
  d1_payload_json TEXT NOT NULL,
  sheet_payload_json TEXT NOT NULL,
  resolution TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  resolved_at TEXT NOT NULL DEFAULT '',
  resolved_by TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_sync_conflicts_pending
  ON sync_conflicts (resolution, created_at DESC);
