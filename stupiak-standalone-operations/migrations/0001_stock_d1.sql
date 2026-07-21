CREATE TABLE IF NOT EXISTS stock_snapshots (
  outlet_id TEXT NOT NULL,
  month_key TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'd1',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (outlet_id, month_key)
);

CREATE TABLE IF NOT EXISTS stock_submissions (
  submission_id TEXT PRIMARY KEY,
  outlet_id TEXT NOT NULL,
  month_key TEXT NOT NULL,
  section_name TEXT NOT NULL,
  counted_by TEXT,
  session_note TEXT,
  saved_at INTEGER NOT NULL,
  gas_sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS stock_values (
  outlet_id TEXT NOT NULL,
  month_key TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  week_index INTEGER NOT NULL DEFAULT 0,
  source_row INTEGER NOT NULL,
  business_date TEXT,
  primary_qty REAL,
  secondary_qty REAL,
  quantity REAL,
  counted_by TEXT,
  submission_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (outlet_id, month_key, sheet_name, week_index, source_row)
);

CREATE TABLE IF NOT EXISTS stock_sync_queue (
  submission_id TEXT PRIMARY KEY,
  outlet_id TEXT NOT NULL,
  month_key TEXT NOT NULL,
  section_name TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stock_values_lookup
  ON stock_values(outlet_id, month_key, sheet_name, week_index);

CREATE INDEX IF NOT EXISTS idx_stock_sync_pending
  ON stock_sync_queue(status, updated_at);
