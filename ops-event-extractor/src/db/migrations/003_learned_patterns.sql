-- Learned patterns: reading rules induced from accepted model extractions so a
-- recurring email template stops costing a model call.
--
-- A pattern is data, never code. It holds a trigger phrase and, per field, the
-- words that precede the value. It cannot run anything and it cannot widen what
-- the gates accept: its events go through the same evidence gates as the model.
--
-- Lifecycle: shadow -> ready -> approved, with suspended/retired as exits.
--   shadow     runs next to the model on matching mail; never decides anything
--   ready      agreed with the model often enough; waiting for a person
--   approved   a person said yes; replaces the model call when it matches
--   suspended  disagreed with the model (in shadow or in a spot check)
--   retired    a person switched it off
-- Nothing reaches approved without a named person.
CREATE TABLE learned_patterns (
  id                      TEXT PRIMARY KEY,
  sender                  TEXT NOT NULL,          -- exact lowercased From address
  kind                    TEXT NOT NULL,
  responsible_party       TEXT NOT NULL,
  rules_json              TEXT NOT NULL,
  status                  TEXT NOT NULL CHECK (status IN ('shadow','ready','approved','suspended','retired')),
  status_reason           TEXT,
  learned_from_message_id TEXT REFERENCES messages(id),
  agreements              INTEGER NOT NULL DEFAULT 0,
  disagreements           INTEGER NOT NULL DEFAULT 0,
  no_matches              INTEGER NOT NULL DEFAULT 0,
  uses                    INTEGER NOT NULL DEFAULT 0,  -- model calls avoided
  approved_by             TEXT,
  approved_at             TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
CREATE INDEX idx_learned_patterns_sender ON learned_patterns(sender, status);

-- One row per (pattern, message) comparison. Keyed by content so replaying the
-- same mailbox cannot count the same agreement twice.
CREATE TABLE learned_pattern_trials (
  id          TEXT PRIMARY KEY,
  pattern_id  TEXT NOT NULL REFERENCES learned_patterns(id),
  message_id  TEXT NOT NULL REFERENCES messages(id),
  mode        TEXT NOT NULL CHECK (mode IN ('shadow','spot_check')),
  outcome     TEXT NOT NULL CHECK (outcome IN ('agree','disagree','no_match')),
  detail_json TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_learned_trials_pattern ON learned_pattern_trials(pattern_id);
