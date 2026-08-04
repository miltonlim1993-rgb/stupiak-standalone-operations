PRAGMA foreign_keys = ON;

-- Local credentials are deliberately isolated from ops_records and Google Sheet mirrors.
-- Secret material is stored only as PBKDF2-derived hashes with random salts.
CREATE TABLE IF NOT EXISTS local_credentials (
  user_id TEXT PRIMARY KEY,
  login_id TEXT NOT NULL UNIQUE,
  credential_kind TEXT NOT NULL CHECK (credential_kind IN ('pin', 'password')),
  secret_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  iterations INTEGER NOT NULL DEFAULT 210000,
  must_change INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT NOT NULL DEFAULT '',
  session_version INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT NOT NULL DEFAULT '',
  password_changed_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_local_credentials_login_id
  ON local_credentials (login_id);

CREATE INDEX IF NOT EXISTS idx_local_credentials_active
  ON local_credentials (disabled_at, updated_at DESC);

-- Owner-issued, one-time activation codes let approved staff choose their own PIN.
CREATE TABLE IF NOT EXISTS local_auth_activations (
  user_id TEXT PRIMARY KEY,
  login_id TEXT NOT NULL UNIQUE,
  code_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  iterations INTEGER NOT NULL DEFAULT 210000,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  used_at TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_local_auth_activations_expiry
  ON local_auth_activations (expires_at, used_at);

-- Per-login and per-client throttling prevents a six-digit staff PIN from being brute-forced.
CREATE TABLE IF NOT EXISTS local_auth_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  window_started_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_local_auth_rate_limits_lock
  ON local_auth_rate_limits (locked_until, updated_at DESC);

-- Security events are intentionally free of raw login IDs, phone numbers, passwords, PINs or codes.
CREATE TABLE IF NOT EXISTS local_auth_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  login_id_hash TEXT NOT NULL DEFAULT '',
  client_hash TEXT NOT NULL DEFAULT '',
  success INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_local_auth_audit_user_time
  ON local_auth_audit (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_local_auth_audit_event_time
  ON local_auth_audit (event_type, created_at DESC);
