-- Ops Event Extractor - initial schema.
-- Invariants worth reading before changing anything here:
--   * source records are immutable; obligations change by adding a revision
--   * evidence is per FIELD, not per event
--   * a task can be superseded but never deleted by reprocessing
--   * one obligation can have many source links (forwards, cross-mailbox copies)

CREATE TABLE mailboxes (
  id                   TEXT PRIMARY KEY,
  address              TEXT NOT NULL UNIQUE,
  label                TEXT,
  configured           INTEGER NOT NULL DEFAULT 0,
  history_anchor       TEXT,              -- opaque string, never a JS number
  checkpoint_history_id TEXT,
  backfill_complete    INTEGER NOT NULL DEFAULT 0,
  last_sync_at         TEXT,
  created_at           TEXT NOT NULL
);

-- Gmail ids are mailbox-scoped, so the primary key carries the mailbox.
CREATE TABLE messages (
  id                 TEXT PRIMARY KEY,           -- mailbox_id + ':' + gmail_message_id
  mailbox_id         TEXT NOT NULL REFERENCES mailboxes(id),
  gmail_message_id   TEXT NOT NULL,
  gmail_thread_id    TEXT,
  rfc822_message_id  TEXT,                       -- corroborating cross-mailbox evidence only
  subject            TEXT,
  from_addr          TEXT,
  to_addrs           TEXT,
  direction          TEXT NOT NULL DEFAULT 'inbound',  -- inbound | outbound
  gmail_labels       TEXT,
  source_ts          TEXT,                       -- Date: header when parseable
  observed_ts        TEXT NOT NULL,              -- when this system first saw it
  raw_hash           TEXT NOT NULL,
  raw_path           TEXT NOT NULL,              -- protected local store, outside the repo
  normalized_hash    TEXT,
  reply_hash         TEXT,
  processing_complete INTEGER NOT NULL DEFAULT 1, -- 0 when an attachment/part could not be read
  incomplete_reason  TEXT,
  created_at         TEXT NOT NULL,
  UNIQUE (mailbox_id, gmail_message_id)
);
CREATE INDEX idx_messages_thread ON messages(mailbox_id, gmail_thread_id);
CREATE INDEX idx_messages_rfc822 ON messages(rfc822_message_id);
CREATE INDEX idx_messages_observed ON messages(observed_ts);

CREATE TABLE message_parts (
  id            TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL REFERENCES messages(id),
  part_index    TEXT NOT NULL,          -- '1', '1.2' etc
  mime_type     TEXT NOT NULL,
  charset       TEXT,
  filename      TEXT,
  size_bytes    INTEGER,
  decoded_ok    INTEGER NOT NULL DEFAULT 1,
  decode_error  TEXT,
  extracted_text TEXT,
  provenance    TEXT,                   -- e.g. 'attachment:page 2'
  UNIQUE (message_id, part_index)
);

-- Normalized, segment-labelled content. Offsets below refer to canonical_text.
CREATE TABLE message_blocks (
  id             TEXT PRIMARY KEY,
  message_id     TEXT NOT NULL REFERENCES messages(id),
  seq            INTEGER NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('reply','quoted','signature','disclaimer','table','attachment')),
  part_id        TEXT REFERENCES message_parts(id),
  text           TEXT NOT NULL,          -- display form (markdown)
  canonical_text TEXT NOT NULL,          -- NFKC + whitespace normalized; evidence offsets index this
  canon_version  TEXT NOT NULL,
  UNIQUE (message_id, seq)
);
CREATE INDEX idx_blocks_message ON message_blocks(message_id);

CREATE TABLE processing_attempts (
  id             TEXT PRIMARY KEY,
  message_id     TEXT NOT NULL REFERENCES messages(id),
  stage          TEXT NOT NULL,          -- route | parse | model | resolve | store
  route_family   TEXT,
  status         TEXT NOT NULL,          -- ok | skipped | refused | invalid_schema | error | budget_exhausted
  detail         TEXT,
  parser_version TEXT,
  prompt_version TEXT,
  schema_version TEXT,
  input_hash     TEXT,
  started_at     TEXT NOT NULL,
  finished_at    TEXT
);
CREATE INDEX idx_attempts_message ON processing_attempts(message_id, stage);

-- Everything the extractors produce lands here first and is gated afterwards.
CREATE TABLE candidate_events (
  id            TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL REFERENCES messages(id),
  source        TEXT NOT NULL,           -- parser | model
  route_family  TEXT,
  kind          TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  confidence    REAL,
  status        TEXT NOT NULL,           -- accepted | quarantined
  reject_reason TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_candidates_message ON candidate_events(message_id);

-- Restricted quarantine. Rejected candidates are preserved, never dropped:
-- an urgent notice that failed grounding still has to be visible to a human.
CREATE TABLE quarantine (
  id            TEXT PRIMARY KEY,
  candidate_id  TEXT NOT NULL REFERENCES candidate_events(id),
  message_id    TEXT NOT NULL REFERENCES messages(id),
  reason        TEXT NOT NULL,
  diagnostic    TEXT NOT NULL,
  urgent        INTEGER NOT NULL DEFAULT 0,
  triaged_at    TEXT,
  triaged_by    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_quarantine_urgent ON quarantine(urgent, triaged_at);

CREATE TABLE obligations (
  id                 TEXT PRIMARY KEY,
  identity_key       TEXT NOT NULL UNIQUE,
  account_id         TEXT,
  policy_ref         TEXT,
  term_ref           TEXT,
  kind               TEXT NOT NULL,
  obligation_subject TEXT NOT NULL,
  object_key         TEXT,               -- vehicle / audit period / installment / document / condition
  status             TEXT NOT NULL,      -- active | superseded | closed
  current_version_id TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_obligations_account ON obligations(account_id, kind);

CREATE TABLE event_versions (
  id             TEXT PRIMARY KEY,
  obligation_id  TEXT NOT NULL REFERENCES obligations(id),
  version        INTEGER NOT NULL,
  payload_json   TEXT NOT NULL,
  supersedes_id  TEXT REFERENCES event_versions(id),
  reason         TEXT NOT NULL,
  created_by     TEXT NOT NULL,          -- parser:<family> | model:<name> | human:<id>
  created_at     TEXT NOT NULL,
  UNIQUE (obligation_id, version)
);

-- One row per extracted or derived FIELD. No field, no claim.
CREATE TABLE evidence (
  id               TEXT PRIMARY KEY,
  event_version_id TEXT NOT NULL REFERENCES event_versions(id),
  field_path       TEXT NOT NULL,
  nature           TEXT NOT NULL CHECK (nature IN ('extracted','derived','generated','human')),
  source_message_id TEXT REFERENCES messages(id),
  block_id         TEXT REFERENCES message_blocks(id),
  part_ref         TEXT,
  quote            TEXT,
  start_offset     INTEGER,
  end_offset       INTEGER,
  canon_version    TEXT,
  derivation_rule  TEXT,
  lookup_provenance TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_evidence_version ON evidence(event_version_id);

CREATE TABLE source_links (
  id            TEXT PRIMARY KEY,
  obligation_id TEXT NOT NULL REFERENCES obligations(id),
  message_id    TEXT NOT NULL REFERENCES messages(id),
  link_reason   TEXT NOT NULL,           -- original | forward | cross_thread | revision | reply
  created_at    TEXT NOT NULL,
  UNIQUE (obligation_id, message_id)
);

CREATE TABLE account_resolutions (
  id              TEXT PRIMARY KEY,
  message_id      TEXT NOT NULL REFERENCES messages(id),
  method          TEXT NOT NULL,         -- policy_exact | name_exact | zip_disambiguated | none
  chosen_account_id TEXT,
  chosen_contact_id TEXT,
  candidates_json TEXT NOT NULL,
  requires_review INTEGER NOT NULL DEFAULT 0,
  reason          TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE TABLE tasks (
  id             TEXT PRIMARY KEY,
  obligation_id  TEXT NOT NULL REFERENCES obligations(id),
  kind           TEXT NOT NULL,
  status         TEXT NOT NULL,          -- open | awaiting_response | escalated | pending_fulfillment_review | completed | superseded | cancelled
  owner          TEXT,
  due_date       TEXT,                   -- the carrier's stated deadline, when confirmed
  first_action_at TEXT,
  escalation_at  TEXT,
  critical_at    TEXT,
  missing_sla    INTEGER NOT NULL DEFAULT 0,
  needs_date_review INTEGER NOT NULL DEFAULT 0,
  urgent         INTEGER NOT NULL DEFAULT 0,
  urgent_reason  TEXT,
  version        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (obligation_id)
);
CREATE INDEX idx_tasks_status ON tasks(status, critical_at);

CREATE TABLE task_escalations (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  level       TEXT NOT NULL,             -- first_action | escalation | critical | silence_1 | silence_2 ...
  fired_at    TEXT NOT NULL,
  sweep_id    TEXT,
  UNIQUE (task_id, level)                -- restart-safe: one row per level, ever
);

CREATE TABLE review_decisions (
  id            TEXT PRIMARY KEY,
  subject_type  TEXT NOT NULL,           -- obligation | task | quarantine
  subject_id    TEXT NOT NULL,
  reviewer      TEXT NOT NULL,
  base_version  INTEGER NOT NULL,        -- optimistic check against stale edits
  patch_json    TEXT NOT NULL,
  reason        TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE fulfillment_links (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  evidence_type TEXT NOT NULL,           -- certificate | endorsement_doc | payment_receipt | activity_note
  qq_activity_id TEXT,
  match_json    TEXT NOT NULL,
  decision      TEXT NOT NULL,           -- auto_close | candidate | rejected | reversal
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_fulfillment_task ON fulfillment_links(task_id);

-- Transactional outbox. Nothing leaves the process except from here.
CREATE TABLE outbox (
  id              TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL,         -- qq_note | qq_document
  task_id         TEXT REFERENCES tasks(id),
  payload_json    TEXT NOT NULL,
  contact_provenance TEXT,
  status          TEXT NOT NULL,         -- pending | dry_run | dispatched | failed | unknown
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_status_code TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  dispatched_at   TEXT
);
CREATE INDEX idx_outbox_status ON outbox(status);

CREATE TABLE model_calls (
  id              TEXT PRIMARY KEY,
  message_id      TEXT REFERENCES messages(id),
  stage           TEXT NOT NULL,         -- classify | extract
  model_requested TEXT NOT NULL,
  model_returned  TEXT,
  snapshot        TEXT,
  reasoning_effort TEXT,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  cost_usd        REAL,
  latency_ms      INTEGER,
  status          TEXT NOT NULL,         -- ok | refusal | invalid_schema | error | stubbed
  prompt_version  TEXT,
  schema_version  TEXT,
  input_hash      TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE sweep_state (
  name        TEXT PRIMARY KEY,
  next_run_at TEXT,
  last_run_at TEXT
);

-- Append-only. Nothing in the application updates or deletes from this table.
CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  actor        TEXT NOT NULL,
  action       TEXT NOT NULL,
  subject_type TEXT,
  subject_id   TEXT,
  detail_json  TEXT
);
CREATE INDEX idx_audit_subject ON audit_log(subject_type, subject_id);

-- Local authorized account index (a cache of QQ data, synthetic in this build).
CREATE TABLE qq_accounts (
  account_id      TEXT PRIMARY KEY,
  contact_id      INTEGER,               -- genuine numeric QQ contact id, or NULL
  legal_name      TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  zip             TEXT,
  aliases_json    TEXT NOT NULL DEFAULT '[]',
  fetched_at      TEXT NOT NULL
);
CREATE INDEX idx_qq_accounts_norm ON qq_accounts(normalized_name);

CREATE TABLE qq_policies (
  policy_number   TEXT NOT NULL,
  account_id      TEXT NOT NULL REFERENCES qq_accounts(account_id),
  carrier         TEXT,
  term_start      TEXT,
  term_end        TEXT,
  PRIMARY KEY (policy_number, account_id)
);

CREATE TABLE qq_activity (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL,
  policy_number TEXT,
  type         TEXT NOT NULL,            -- certificate | endorsement_doc | payment_receipt | activity_note | reversal
  amount       REAL,
  currency     TEXT,
  term_start   TEXT,
  term_end     TEXT,
  object_key   TEXT,
  text         TEXT,
  generated_by TEXT,                     -- 'ops-event-extractor' rows can never self-validate completion
  occurred_at  TEXT NOT NULL
);
CREATE INDEX idx_qq_activity_account ON qq_activity(account_id, occurred_at);

-- Non-obligation observations that change how an obligation is treated
-- (a bind confirmation, a reply that answers a question). They carry evidence
-- like anything else but never become tasks on their own.
CREATE TABLE signals (
  id           TEXT PRIMARY KEY,
  message_id   TEXT NOT NULL REFERENCES messages(id),
  type         TEXT NOT NULL,            -- bind_observed | reply_observed
  policy_ref   TEXT,
  account_hint TEXT,
  detail_json  TEXT,
  occurred_at  TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_signals_type ON signals(type, policy_ref);

-- Evaluation labels imported from staff daily-task emails.
CREATE TABLE labels (
  id                         TEXT PRIMARY KEY,
  split                      TEXT NOT NULL,  -- dev | heldout
  episode_key                TEXT NOT NULL,  -- account+policy episode, for leak-free splitting
  message_id                 TEXT,
  account_id                 TEXT,
  kind                       TEXT,
  obligation_subject         TEXT,
  label_followup_date        TEXT,           -- staff follow-up date: NOT the obligation deadline
  confirmed_obligation_due_date TEXT,
  corrected_from             TEXT,
  version                    INTEGER NOT NULL DEFAULT 1,
  created_at                 TEXT NOT NULL
);
CREATE INDEX idx_labels_split ON labels(split, episode_key);
