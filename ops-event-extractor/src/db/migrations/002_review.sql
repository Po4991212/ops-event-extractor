-- Confidence and band live on the obligation because the review queue selects
-- on them; deriving them at query time would mean re-deriving the thresholds in
-- a second place. version/updated_at support the console's optimistic check.
ALTER TABLE obligations ADD COLUMN confidence REAL;
ALTER TABLE obligations ADD COLUMN band TEXT;
ALTER TABLE obligations ADD COLUMN account_name TEXT;
ALTER TABLE obligations ADD COLUMN stated_deadline TEXT;
ALTER TABLE obligations ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE obligations ADD COLUMN updated_at TEXT;
ALTER TABLE quarantine ADD COLUMN resolution TEXT;
CREATE INDEX IF NOT EXISTS idx_obligations_band ON obligations(band);
