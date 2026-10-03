-- The agency's eighteen email categories (src/config/categories.js).
--
-- Kept in its own table rather than as a column on messages: message rows are
-- source records and are never updated, while a category is a judgement that
-- changes when the rules or the extraction change. One row per message, the
-- latest judgement, with what produced it.
CREATE TABLE message_categories (
  message_id   TEXT PRIMARY KEY REFERENCES messages(id),
  category     TEXT,                 -- null means nothing fitted; a person sorts it
  category_n   INTEGER,
  source       TEXT NOT NULL CHECK (source IN ('suspicious','event_kind','keywords','noise_route','none')),
  suspicious   INTEGER NOT NULL DEFAULT 0,
  reason       TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_message_categories_category ON message_categories(category);

ALTER TABLE learned_patterns ADD COLUMN category TEXT;
