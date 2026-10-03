'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { FixedClock } = require('../src/core/clock');
const corpus = require('../src/eval/corpus');
const { syncMailbox } = require('../src/ingest/sync');

/** The gmail id the transport will assign to a corpus spec. */
function transport0Id(spec) {
  return require('../src/core/hash').sha256(spec.key).slice(0, 14).replace(/^/, 'g_');
}
const { processMessage, processAll } = require('../src/extract/pipeline');
const { makeExtractor } = require('../src/extract/model/extractor');

test('windows-1252 content decodes; undecodable content is marked incomplete rather than guessed', async () => {
  const c = await h.processedCorpus();
  const good = c.db.prepare('SELECT * FROM messages WHERE id = ?').get(c.keys.charset_win1252);
  assert.equal(good.processing_complete, 1);
  const blocks = c.db.prepare('SELECT canonical_text FROM message_blocks WHERE message_id = ?').all(good.id);
  assert.ok(blocks.some((b) => /4,210\.00/.test(b.canonical_text)), 'the amount survived the charset');

  const damaged = c.db.prepare('SELECT * FROM messages WHERE id = ?').get(c.keys.damaged_charset);
  assert.equal(damaged.processing_complete, 0, 'the damaged message is flagged, not silently accepted');
  assert.equal(h.obligationsFor(c.db, damaged.id).length, 0, 'and it produced no confident obligation');
  h.cleanup(c.dir);
});

test('an unreadable attachment lowers confidence instead of being ignored', async () => {
  const c = await h.processedCorpus();
  const msg = c.db.prepare('SELECT * FROM messages WHERE id = ?').get(c.keys.pdf_attachment);
  assert.equal(msg.processing_complete, 0, 'the PDF could not be read and that is recorded');
  const obl = h.obligationsFor(c.db, msg.id)[0];
  assert.ok(obl, 'the obligation still surfaced from the readable part');
  assert.ok(obl.confidence <= 0.70, `confidence capped at incomplete processing (${obl.confidence})`);
  const task = h.taskFor(c.db, obl.id);
  assert.ok(task, 'a person still sees it');
  h.cleanup(c.dir);
});

test('two accounts with the same name and no disambiguator stop at unresolved', async () => {
  const c = await h.processedCorpus();
  const obl = h.obligationsFor(c.db, c.keys.ambiguous_account)[0];
  assert.ok(obl, 'the request still produced an obligation');
  assert.equal(obl.account_id, null, 'no account was guessed');
  const res = c.db.prepare('SELECT * FROM account_resolutions WHERE message_id = ?').get(c.keys.ambiguous_account);
  assert.ok(res, 'the resolution attempt is recorded');
  assert.match(res.method, /review|ambiguous|none/, `stopped rather than picked (${res.method})`);
  h.cleanup(c.dir);
});

test('a lookalike sender domain inherits no parser trust and resolves no account', async () => {
  const c = await h.processedCorpus();
  const attempt = c.db.prepare('SELECT * FROM processing_attempts WHERE message_id = ? ORDER BY id LIMIT 1')
    .get(c.keys.lookalike_sender);
  assert.notEqual(attempt.route_family, 'twia', 'the lookalike did not route to the TWIA parser');
  const obl = h.obligationsFor(c.db, c.keys.lookalike_sender)[0];
  if (obl) assert.equal(obl.account_id, null, 'and no account was attached to it');
  h.cleanup(c.dir);
});

test('two commitments made on the same call for the same day stay separate', async () => {
  const c = await h.processedCorpus();
  const obls = h.obligationsFor(c.db, c.keys.same_day_commitments);
  assert.equal(obls.length, 2, 'two distinct obligations');
  const [a, b] = obls;
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.object_key, b.object_key, 'kept apart by what they are about, not by their date');
  const payloads = obls.map((o) => h.payloadOf(c.db, o));
  assert.equal(payloads[0].stated_deadline, payloads[1].stated_deadline, 'even though the deadline is identical');
  h.cleanup(c.dir);
});

test('reprocessing the same message twice changes nothing', async () => {
  const c = await h.processedCorpus();
  const before = {
    obligations: c.db.prepare('SELECT COUNT(*) c FROM obligations').get().c,
    versions: c.db.prepare('SELECT COUNT(*) c FROM event_versions').get().c,
    links: c.db.prepare('SELECT COUNT(*) c FROM source_links').get().c,
    tasks: c.db.prepare('SELECT COUNT(*) c FROM tasks').get().c,
  };
  await processAll(c.db, c.cfg, c.clock, { modelExtractor: makeExtractor(c.db, c.cfg, c.clock) });
  const after = {
    obligations: c.db.prepare('SELECT COUNT(*) c FROM obligations').get().c,
    versions: c.db.prepare('SELECT COUNT(*) c FROM event_versions').get().c,
    links: c.db.prepare('SELECT COUNT(*) c FROM source_links').get().c,
    tasks: c.db.prepare('SELECT COUNT(*) c FROM tasks').get().c,
  };
  assert.deepEqual(after, before, 'a second full pass is a no-op');
  h.cleanup(c.dir);
});

test('a failure part-way through a write leaves nothing behind', async () => {
  const { db, cfg, dir } = h.freshDb();
  const { tx } = require('../src/db/db');
  const clock = new FixedClock(cfg.timezone, '2026-05-01T14:00:00Z');
  corpus.seedReferenceData(db, clock);

  const before = db.prepare('SELECT COUNT(*) c FROM obligations').get().c;
  assert.throws(() => tx(db, () => {
    db.prepare(`INSERT INTO obligations (id, identity_key, kind, obligation_subject, status, created_at)
      VALUES ('obl_partial','key_partial','renewal_due','half written','active',?)`).run(clock.nowISO());
    throw new Error('simulated crash before the version was written');
  }), /simulated crash/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM obligations').get().c, before,
    'the partial obligation was rolled back rather than left without a version');

  h.cleanup(dir);
});

test('every stored obligation is internally consistent', async () => {
  const c = await h.processedCorpus();
  const q = (sql) => c.db.prepare(sql).get().c;
  assert.equal(q('SELECT COUNT(*) c FROM obligations WHERE current_version_id IS NULL'), 0,
    'no obligation without a current version');
  assert.equal(q(`SELECT COUNT(*) c FROM event_versions v WHERE NOT EXISTS
    (SELECT 1 FROM evidence e WHERE e.event_version_id = v.id)`), 0, 'no version without evidence');
  assert.equal(q(`SELECT COUNT(*) c FROM tasks t WHERE NOT EXISTS
    (SELECT 1 FROM obligations o WHERE o.id = t.obligation_id)`), 0, 'no task without an obligation');
  assert.equal(q(`SELECT COUNT(*) c FROM obligations o WHERE NOT EXISTS
    (SELECT 1 FROM source_links s WHERE s.obligation_id = o.id)`), 0, 'no obligation without a source message');
  h.cleanup(c.dir);
});

test('sync paginates, survives an expired history id, and does not erase deleted messages', async () => {
  const { db, cfg, dir } = h.freshDb();
  const clock = new FixedClock(cfg.timezone, '2026-05-01T14:00:00Z');
  const mailbox = corpus.MAILBOXES.find((m) => m.configured);
  const own = corpus.messagesFor(mailbox.id);
  // A message that arrives mid-backfill, and one that is deleted between the
  // listing and the fetch.
  const transport = new corpus.SyntheticTransport({
    mailboxId: mailbox.id, messages: own, pageSize: 3,
    arriveDuringBackfill: [own[own.length - 1]],
    vanishing: [transport0Id(own[1])],
  });

  const first = await syncMailbox(db, cfg, clock, mailbox, transport, {});
  assert.ok(transport.calls.list > 1, `pagination made several list calls (${transport.calls.list})`);
  const stored = db.prepare('SELECT COUNT(*) c FROM messages').get().c;
  assert.ok(stored > 3, `more than one page was stored (${stored})`);
  assert.ok(first.backfilled, 'the backfill is recorded');
  assert.ok(first.backfilled.unavailable.includes(transport0Id(own[1])),
    'the message that vanished before fetch is reported as unavailable');

  // A vanished message is skipped, not fabricated.
  assert.ok(!db.prepare('SELECT 1 FROM messages WHERE id = ?').get(`${mailbox.id}:${transport.idFor(own[1].key)}`),
    'and nothing was written for it');

  // Now the stored history id ages out.
  const expired = new corpus.SyntheticTransport({
    mailboxId: mailbox.id, messages: own, pageSize: 3, historyExpired: true,
  });
  const second = await syncMailbox(db, cfg, clock, mailbox, expired, {});
  assert.equal(second.fullResync, true, 'an expired history id falls back to a full resync');
  assert.equal(second.historyStale, true, 'and a second expiry stops rather than recursing forever');
  assert.ok(db.prepare('SELECT COUNT(*) c FROM messages').get().c >= stored, 'nothing was lost in the fallback');

  // A message removed upstream is retained locally.
  const victim = db.prepare('SELECT id FROM messages LIMIT 1').get().id;
  const shrunk = new corpus.SyntheticTransport({
    mailboxId: mailbox.id, messages: own.filter((m) => `${mailbox.id}:${expired.idFor(m.key)}` !== victim), pageSize: 3,
  });
  await syncMailbox(db, cfg, clock, mailbox, shrunk, { forceFullResync: true });
  assert.ok(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(victim),
    'a message deleted upstream is retained locally rather than erased');
  h.cleanup(dir);
});

test('a model refusal and invalid output are both recorded and neither creates an obligation', async () => {
  const { db, cfg, dir } = h.freshDb();
  const clock = new FixedClock(cfg.timezone, '2026-05-01T14:00:00Z');
  corpus.seedReferenceData(db, clock);
  corpus.seedMessages(db, cfg, clock, { only: ['ambiguous_account'] });
  const id = corpus.keyToMessageId().ambiguous_account;

  for (const [label, extractor] of [
    ['refusal', async () => ({ status: 'refusal', detail: 'declined', promptVersion: 'p', schemaVersion: 's', inputHash: 'x' })],
    ['invalid', async () => ({ status: 'invalid_schema', detail: 'not json', promptVersion: 'p', schemaVersion: 's', inputHash: 'y' })],
  ]) {
    const r = await processMessage(db, cfg, clock, id, { modelExtractor: extractor });
    assert.ok(r, `${label} returned a result rather than throwing`);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM obligations').get().c, 0, `${label} created no obligation`);
  }
  const attempts = db.prepare('SELECT status FROM processing_attempts WHERE message_id = ?').all(id).map((a) => a.status);
  assert.ok(attempts.length >= 2, `both outcomes are recorded (${attempts.join(', ')})`);
  h.cleanup(dir);
});

test('the HTTP capability allowlist refuses anything that is not an approved read', () => {
  const http = require('../src/core/http');
  assert.doesNotThrow(() => http.check('GET', 'https://gmail.googleapis.com/gmail/v1/users/me/messages'),
    'reading mail is allowed');
  for (const [method, url, code, why] of [
    ['POST', 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', 'HTTP_DELIVERY_REFUSED', 'the Gmail send endpoint'],
    ['POST', 'https://api.sendgrid.com/v3/mail/send', 'HTTP_DELIVERY_REFUSED', 'a mail service provider'],
    ['GET', 'https://example.com/anything', 'HTTP_NOT_ALLOWLISTED', 'a host that is not on the list'],
    ['POST', 'http://api.openai.com/v1/responses', 'HTTP_NOT_HTTPS', 'plain HTTP'],
    ['POST', 'https://gmail.googleapis.com/gmail/v1/users/me/drafts', 'HTTP_NOT_ALLOWLISTED', 'draft creation'],
  ]) {
    assert.throws(() => http.check(method, url), (e) => e.code === code,
      `${why} is refused with ${code}`);
  }
});

test('all four write-switch combinations behave, and only one of them sends', () => {
  const { writeMode } = require('../src/writeback/guard');
  assert.equal(writeMode({ externalWritesApproved: false }, { live: false }).live, false);
  assert.equal(writeMode({ externalWritesApproved: false }, { live: true }).live, false);
  assert.equal(writeMode({ externalWritesApproved: true }, { live: false }).live, false);
  assert.equal(writeMode({ externalWritesApproved: true }, { live: true }).live, true);
  assert.match(writeMode({ externalWritesApproved: false }, { live: true }).reason, /OPS_EXTERNAL_WRITES_APPROVED/);
});

test('an unknown dispatch outcome is recorded as unknown and retried without duplicating', async () => {
  const { db, cfg, dir } = h.freshDb();
  const clock = new FixedClock(cfg.timezone, '2026-05-01T14:00:00Z');
  const outbox = require('../src/writeback/outbox');
  const liveCfg = { ...cfg, externalWritesApproved: true };
  const payload = { subject: 'note', body: 'body' };

  const a = outbox.enqueue(db, clock, { kind: 'qq_note', target: 'acct_x', payload });
  const b = outbox.enqueue(db, clock, { kind: 'qq_note', target: 'acct_x', payload });
  assert.equal(a.idempotency_key, b.idempotency_key, 'identical intent produces one entry');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM outbox').get().c, 1);

  let calls = 0;
  const flaky = async () => {
    calls += 1;
    const e = new Error('no response'); e.code = 'UNKNOWN_OUTCOME'; throw e;
  };
  const r1 = await outbox.dispatch(db, liveCfg, clock, { live: true, dispatcher: flaky });
  assert.equal(r1.unknown.length, 1, 'a silent failure is unknown, not failed');
  assert.equal(db.prepare('SELECT status FROM outbox').get().status, 'unknown');

  // A readback finds the note already there: reconcile rather than resend.
  outbox.reconcile(db, clock, { id: a.id, found: true });
  const r2 = await outbox.dispatch(db, liveCfg, clock, { live: true, dispatcher: flaky });
  assert.equal(r2.sent.length + r2.unknown.length, 0, 'nothing was sent a second time');
  assert.equal(calls, 1, 'the dispatcher was called exactly once');
  h.cleanup(dir);
});

test('CSV export neutralises formula injection', () => {
  const { toCsv, cell } = require('../src/export/csv');
  assert.equal(cell('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(cell('+1'), "'+1");
  assert.equal(cell('-1'), "'-1");
  assert.equal(cell('@x'), "'@x");
  const csv = toCsv([{ a: '=cmd|calc', b: 'plain' }], ['a', 'b']);
  assert.match(csv, /'=cmd/);
  assert.ok(!/^=cmd/m.test(csv), 'no cell starts a formula');
});

test('multiple mailboxes stay distinct while sharing one obligation', async () => {
  const c = await h.processedCorpus();
  const mailboxes = c.db.prepare('SELECT COUNT(DISTINCT mailbox_id) c FROM messages').get().c;
  assert.ok(mailboxes >= 2, 'the corpus spans more than one mailbox');
  const shared = c.db.prepare(`SELECT sl.obligation_id, COUNT(DISTINCT m.mailbox_id) n
    FROM source_links sl JOIN messages m ON m.id = sl.message_id
    GROUP BY sl.obligation_id HAVING n > 1`).all();
  assert.ok(shared.length >= 1, 'at least one obligation is evidenced from two mailboxes');
  h.cleanup(c.dir);
});
