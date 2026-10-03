'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { load } = require('../src/config');
const { open, migrate } = require('../src/db/db');
const { FixedClock } = require('../src/core/clock');
const corpus = require('../src/eval/corpus');
const { processAll, processMessage } = require('../src/extract/pipeline');
const { makeExtractor } = require('../src/extract/model/extractor');

function freshDb(name = 'ops') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  const cfg = load({ dbPath: path.join(dir, 'ops.sqlite'), rawStore: path.join(dir, 'raw') });
  const db = open(cfg.dbPath);
  migrate(db);
  return { db, cfg, dir };
}

/** Seeds and processes the whole corpus at a fixed moment. */
async function processedCorpus({ at = '2026-05-01T14:00:00Z', only = null } = {}) {
  const { db, cfg, dir } = freshDb();
  const clock = new FixedClock(cfg.timezone, at);
  corpus.seedReferenceData(db, clock);
  corpus.seedMessages(db, cfg, clock, { only });
  const summary = await processAll(db, cfg, clock, { modelExtractor: makeExtractor(db, cfg, clock) });
  return { db, cfg, clock, dir, summary, keys: corpus.keyToMessageId() };
}

/** Seeds everything but processes only the named keys, in the given order. */
async function processInOrder(keys, { at = '2026-05-01T14:00:00Z' } = {}) {
  const { db, cfg, dir } = freshDb();
  const clock = new FixedClock(cfg.timezone, at);
  corpus.seedReferenceData(db, clock);
  corpus.seedMessages(db, cfg, clock, { only: keys });
  const map = corpus.keyToMessageId();
  const extractor = makeExtractor(db, cfg, clock);
  for (const k of keys) await processMessage(db, cfg, clock, map[k], { modelExtractor: extractor });
  return { db, cfg, clock, dir, keys: map };
}

function obligationsFor(db, messageId) {
  return db.prepare(`SELECT o.*, sl.link_reason FROM source_links sl JOIN obligations o ON o.id = sl.obligation_id
    WHERE sl.message_id = ?`).all(messageId);
}

function taskFor(db, obligationId) {
  return db.prepare('SELECT * FROM tasks WHERE obligation_id = ?').get(obligationId);
}

function payloadOf(db, obligation) {
  const v = db.prepare('SELECT payload_json FROM event_versions WHERE id = ?').get(obligation.current_version_id);
  return v ? JSON.parse(v.payload_json) : {};
}

function evidenceOf(db, obligation) {
  return db.prepare('SELECT * FROM evidence WHERE event_version_id = ?').all(obligation.current_version_id);
}

function sourceCount(db, obligationId) {
  return db.prepare('SELECT COUNT(*) c FROM source_links WHERE obligation_id = ?').get(obligationId).c;
}

function heldFor(db, messageId) {
  return db.prepare('SELECT * FROM quarantine WHERE message_id = ?').all(messageId);
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

module.exports = { freshDb, processedCorpus, processInOrder, obligationsFor, taskFor, payloadOf,
  evidenceOf, sourceCount, heldFor, cleanup, corpus };
