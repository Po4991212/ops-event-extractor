PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS messages (
  id                TEXT PRIMARY KEY,
  thread_id         TEXT NOT NULL,
  history_id        TEXT,
  internal_date     INTEGER NOT NULL,
  from_addr         TEXT NOT NULL,
  from_domain       TEXT NOT NULL,
  to_addrs          TEXT,
  cc_addrs          TEXT,
  subject           TEXT,
  label_ids         TEXT,
  body_text         TEXT,
  body_full         TEXT,
  attachment_names  TEXT,
  content_hash      TEXT NOT NULL,
  source            TEXT NOT NULL DEFAULT 'gmail',
  fetched_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_hash   ON messages(content_hash);
CREATE INDEX IF NOT EXISTS idx_msg_from   ON messages(from_domain);
CREATE INDEX IF NOT EXISTS idx_msg_date   ON messages(internal_date);

CREATE TABLE IF NOT EXISTS events (
  event_key         TEXT PRIMARY KEY,
  source_msg_id     TEXT NOT NULL REFERENCES messages(id),
  source_thread_id  TEXT NOT NULL,
  kind              TEXT NOT NULL,
  obligation        TEXT NOT NULL,
  due_date          TEXT,
  due_date_basis    TEXT NOT NULL,
  account_name_raw  TEXT,
  account_id        TEXT,
  owner             TEXT,
  carrier           TEXT,
  policy_no         TEXT,
  amount_cents      INTEGER,
  extractor         TEXT NOT NULL,
  extractor_ref     TEXT NOT NULL,
  confidence        REAL NOT NULL,
  confidence_parts  TEXT,
  confidence_gate   TEXT,
  raw_span          TEXT,
  status            TEXT NOT NULL DEFAULT 'new',
  superseded_by     TEXT,
  extracted_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ev_status  ON events(status);
CREATE INDEX IF NOT EXISTS idx_ev_due     ON events(due_date);
CREATE INDEX IF NOT EXISTS idx_ev_account ON events(account_id);

CREATE TABLE IF NOT EXISTS tasks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key         TEXT NOT NULL REFERENCES events(event_key),
  title             TEXT NOT NULL,
  due_date          TEXT,
  sla_first_action  TEXT,
  sla_escalate      TEXT,
  sla_critical      TEXT,
  owner             TEXT,
  state             TEXT NOT NULL DEFAULT 'open',
  qq_note_id        TEXT,
  created_at        INTEGER NOT NULL,
  UNIQUE(event_key)
);

CREATE TABLE IF NOT EXISTS event_sources (
  event_key         TEXT NOT NULL REFERENCES events(event_key),
  source_msg_id     TEXT NOT NULL REFERENCES messages(id),
  first_seen_at     INTEGER NOT NULL,
  PRIMARY KEY(event_key, source_msg_id)
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version           INTEGER PRIMARY KEY,
  name              TEXT NOT NULL,
  applied_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS review_queue (
  event_key         TEXT PRIMARY KEY REFERENCES events(event_key),
  reason            TEXT NOT NULL,
  candidates        TEXT,
  resolved_at       INTEGER,
  resolution        TEXT
);

CREATE TABLE IF NOT EXISTS ground_truth (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  source_msg_id     TEXT NOT NULL,
  source_line       TEXT NOT NULL,
  account_name_raw  TEXT,
  kind              TEXT,
  obligation        TEXT,
  due_date          TEXT,
  observed_on       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_calls (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  msg_id            TEXT,
  purpose           TEXT NOT NULL,
  model             TEXT NOT NULL,
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  cost_cents        REAL,
  latency_ms        INTEGER,
  ok                INTEGER,
  error             TEXT,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
  key               TEXT PRIMARY KEY,
  value             TEXT
);

CREATE TABLE IF NOT EXISTS routing_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  msg_id            TEXT NOT NULL,
  handler           TEXT NOT NULL,
  parser_name       TEXT,
  created_at        INTEGER NOT NULL
);
