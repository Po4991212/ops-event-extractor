import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb, migrate } from '../src/db/index.js';
import { insertMessage } from '../src/db/queries.js';
import { normalizeBody } from '../src/normalize/text.js';
import { contentHash } from '../src/dedup/hash.js';
import { config } from '../src/config.js';
import { replay } from '../src/eval/replay.js';
import { SLA } from '../src/events/sla.js';

// §7.3: three synthetic analogs of the real documented recoveries (see
// docs/adr/0006-synthetic-data-policy.md for why these are fictional
// rather than the literal accounts named in docs/SPEC.md's narrative).

let database;
let tmpPath;

function seedFixture(m) {
  const { body_full, body_text } = normalizeBody(m.body_raw);
  const fromMatch = /@([^\s>]+)/.exec(m.from_addr || '');
  const record = {
    id: m.id,
    thread_id: m.thread_id,
    history_id: null,
    internal_date: Date.parse(m.internal_date),
    from_addr: m.from_addr,
    from_domain: fromMatch ? fromMatch[1].toLowerCase() : '',
    to_addrs: '[]', cc_addrs: '[]', label_ids: '[]', attachment_names: '[]',
    subject: m.subject,
    body_text, body_full,
    source: 'synthetic',
    fetched_at: Date.now()
  };
  record.content_hash = contentHash(record);
  insertMessage(database, record);
}

beforeAll(() => {
  tmpPath = path.join(os.tmpdir(), `ops-event-extractor-replay-${Date.now()}.db`);
  database = migrate(openDb(tmpPath));
  const file = JSON.parse(fs.readFileSync(path.join(config.syntheticDir, 'messages.json'), 'utf8'));
  for (const m of file.messages) seedFixture(m);
});

afterAll(() => {
  database.close();
  fs.rmSync(tmpPath, { force: true });
  for (const ext of ['-wal', '-shm']) fs.rmSync(`${tmpPath}${ext}`, { force: true });
});

describe('§7.3 replay recovery tests (as-of-mode: each message is processed as of its own date, no lookahead)', () => {
  it('runs the full synthetic corpus without throwing and reports metrics', async () => {
    const result = await replay(database, {});
    expect(result.messageCount).toBeGreaterThan(0);
    expect(result.metrics).toBeTruthy();
  });

  it('recovery 1: flags a renewal 45 days before its due date, not at the deadline', () => {
    const ev = database.prepare("SELECT * FROM events WHERE policy_no = 'FQ-88213401' AND kind = 'renewal_due'").get();
    expect(ev).toBeTruthy();
    const task = database.prepare('SELECT * FROM tasks WHERE event_key = ?').get(ev.event_key);
    expect(task).toBeTruthy();
    expect(task.sla_first_action).toBe('2026-09-17'); // due_date 2026-11-01 minus 45 days
    expect(task.sla_first_action < ev.due_date).toBe(true);
  });

  it('recovery 2: surfaces a renewal months before it is due, not the week of expiration', () => {
    const ev = database.prepare("SELECT * FROM events WHERE policy_no = 'FQ-88251902' AND kind = 'renewal_due'").get();
    expect(ev).toBeTruthy();
    const daysEarly = (Date.parse(ev.due_date) - ev.extracted_at) / 86400000;
    expect(daysEarly).toBeGreaterThan(150);
  });

  it('recovery 3: collapses a renewal notice delivered three times into one event with three recorded sources', () => {
    const ev = database.prepare("SELECT * FROM events WHERE policy_no = 'FQ-88231190' AND kind = 'renewal_due'").get();
    expect(ev).toBeTruthy();
    const sources = database.prepare('SELECT * FROM event_sources WHERE event_key = ?').all(ev.event_key);
    expect(sources).toHaveLength(3);
    expect(new Set(sources.map(s => s.source_msg_id)).size).toBe(3);
  });

  it('a lapse_warning event carries the 0/0/0 SLA — it is already a fire, not a scheduled follow-up', () => {
    const ev = database.prepare("SELECT * FROM events WHERE kind = 'lapse_warning'").get();
    expect(ev).toBeTruthy();
    // Below the auto threshold here (unresolved account — §0.5 correctly
    // routes it to review rather than guessing), but the SLA table itself
    // (§6.1) is what a human sees zero slack on once they accept it.
    expect(SLA.lapse_warning).toEqual({ firstAction: 0, escalate: 0, critical: 0 });
  });
});
