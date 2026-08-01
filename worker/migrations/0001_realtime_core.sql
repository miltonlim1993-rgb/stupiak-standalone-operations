PRAGMA foreign_keys = ON;

-- Canonical operational records. Google Sheets is a downstream mirror only.
CREATE TABLE IF NOT EXISTS ops_records (
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  outlet_id TEXT NOT NULL,
  business_date TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (entity, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_ops_records_outlet_entity_updated
  ON ops_records (outlet_id, entity, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_ops_records_outlet_business_date
  ON ops_records (outlet_id, business_date DESC);

CREATE INDEX IF NOT EXISTS idx_ops_records_status
  ON ops_records (entity, status, updated_at DESC);

-- One row per client mutation makes offline retries safe and idempotent.
CREATE TABLE IF NOT EXISTS ops_mutations (
  mutation_id TEXT PRIMARY KEY,
  outlet_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  actor_name TEXT NOT NULL DEFAULT '',
  requested_at TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  result_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ops_mutations_outlet_committed
  ON ops_mutations (outlet_id, committed_at DESC);

-- Durable outbox for Google Sheets mirroring. Queue delivery can be retried
-- independently without ever rolling back a successful mobile submission.
CREATE TABLE IF NOT EXISTS sheet_sync_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mutation_id TEXT NOT NULL UNIQUE,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  outlet_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  queued_at TEXT NOT NULL DEFAULT '',
  last_attempt_at TEXT NOT NULL DEFAULT '',
  synced_at TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (mutation_id) REFERENCES ops_mutations(mutation_id)
);

CREATE INDEX IF NOT EXISTS idx_sheet_sync_outbox_pending
  ON sheet_sync_outbox (status, next_attempt_at, id);
