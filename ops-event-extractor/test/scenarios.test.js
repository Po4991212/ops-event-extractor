'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');
const h = require('./helpers');
const { FixedClock } = require('../src/core/clock');
const { runSweep } = require('../src/tasks/sweeps');
const { scan } = require('../src/security/no-send-scan');
const leakage = require('../src/eval/leakage');

test('S1: a March renewal notice produces a first action at least 45 days before the policy lapses', async () => {
  const c = await h.processedCorpus();
  const [obl] = h.obligationsFor(c.db, c.keys.twia_renewal).filter((o) => o.kind === 'renewal_due');
  assert.ok(obl, 'renewal obligation exists');
  const task = h.taskFor(c.db, obl.id);

  const due = DateTime.fromISO(obl.stated_deadline, { zone: c.cfg.timezone });
  const first = DateTime.fromISO(task.first_action_at, { zone: c.cfg.timezone });
  // Compared as calendar dates in the agency's timezone. Comparing instants
  // would read 44.4 days purely because both are set to business hours.
  const days = due.startOf('day').diff(first.startOf('day'), 'days').days;
  assert.ok(days >= 45, `first action ${first.toISODate()} is ${days} days before ${due.toISODate()}, expected >= 45`);

  const times = [task.first_action_at, task.escalation_at, task.critical_at].filter(Boolean);
  assert.deepEqual(times, [...times].sort(), 'reminder times are in order');
  h.cleanup(c.dir);
});

test('S2: an obligation stated only inside an HTML table survives normalization with its span', async () => {
  const c = await h.processedCorpus();
  const [obl] = h.obligationsFor(c.db, c.keys.twia_renewal).filter((o) => o.kind === 'renewal_due');
  const payload = h.payloadOf(c.db, obl);
  assert.equal(payload.amount, 18412, 'renewal premium came out of the HTML table');

  const amountEvidence = h.evidenceOf(c.db, obl).find((e) => e.field_path === 'amount');
  assert.ok(amountEvidence, 'the amount carries evidence');
  assert.match(amountEvidence.quote, /18,412\.00/, 'the span is the table row itself');

  const block = c.db.prepare('SELECT kind FROM message_blocks WHERE id = ?').get(amountEvidence.block_id);
  assert.equal(block.kind, 'table', 'the span is attributed to a table block');

  const received = c.db.prepare('SELECT source_ts FROM messages WHERE id = ?').get(c.keys.twia_renewal).source_ts;
  assert.match(received, /^2026-03/, 'the message arrived in March');
  assert.match(obl.stated_deadline, /^2026-06/, 'and carries a June obligation');
  h.cleanup(c.dir);
});

test('S3: three forwards make one obligation with three extra source links, and a distinct item stays separate', async () => {
  const c = await h.processedCorpus();
  const renewals = h.obligationsFor(c.db, c.keys.twia_renewal).filter((o) => o.kind === 'renewal_due');
  assert.equal(renewals.length, 1, 'exactly one renewal obligation');
  const obl = renewals[0];

  for (const key of ['twia_fwd1', 'twia_fwd2', 'twia_fwd3_other_mailbox']) {
    const linked = h.obligationsFor(c.db, c.keys[key]).map((o) => o.id);
    assert.deepEqual(linked, [obl.id], `${key} links to the same obligation rather than creating another`);
  }
  assert.equal(h.sourceCount(c.db, obl.id), 4, 'original plus three forwards');

  const mailboxes = c.db.prepare(`SELECT DISTINCT m.mailbox_id FROM source_links sl JOIN messages m ON m.id = sl.message_id
    WHERE sl.obligation_id = ?`).all(obl.id).map((r) => r.mailbox_id);
  assert.ok(mailboxes.length > 1, 'the obligation spans more than one mailbox');

  const distinct = h.obligationsFor(c.db, c.keys.twia_distinct_signature);
  assert.equal(distinct.length, 1);
  assert.notEqual(distinct[0].id, obl.id, 'a different obligation on the same policy is not folded in');
  assert.equal(distinct[0].kind, 'signature_required');

  const tasks = c.db.prepare("SELECT COUNT(*) c FROM tasks WHERE obligation_id = ?").get(obl.id).c;
  assert.equal(tasks, 1, 'one task, not four');
  h.cleanup(c.dir);
});

test('S4: a carrier question in a new thread links on corroborating identity; a same-subject decoy does not', async () => {
  const c = await h.processedCorpus();
  const quote = h.obligationsFor(c.db, c.keys.fq_quote).find((o) => o.kind === 'quote_received');
  const followUp = h.obligationsFor(c.db, c.keys.fq_question_newthread);
  assert.ok(followUp.some((o) => o.id === quote.id), 'the new-thread question attaches to the original quote');

  const decoy = h.obligationsFor(c.db, c.keys.fq_decoy_other_account);
  assert.ok(decoy.length, 'the decoy produced its own obligation');
  assert.ok(!decoy.some((o) => o.id === quote.id), 'the decoy did not link to the other account');
  assert.equal(decoy[0].account_id, 'acct_marfa');

  const qThread = c.db.prepare('SELECT gmail_thread_id FROM messages WHERE id = ?').get(c.keys.fq_quote).gmail_thread_id;
  const fThread = c.db.prepare('SELECT gmail_thread_id FROM messages WHERE id = ?').get(c.keys.fq_question_newthread).gmail_thread_id;
  assert.notEqual(qThread, fThread, 'the link was made across different threads');
  h.cleanup(c.dir);
});

test('S4: a bind confirmation leaves the unsatisfied condition open and marks it urgent', async () => {
  const c = await h.processedCorpus();
  const cond = c.db.prepare("SELECT * FROM obligations WHERE kind = 'condition_precedent'").get();
  assert.ok(cond, 'the binding condition exists');
  const task = h.taskFor(c.db, cond.id);
  assert.notEqual(task.status, 'completed', 'talk of binding did not close the condition');
  assert.equal(task.urgent, 1, 'and the unmet condition is now urgent');
  assert.match(task.urgent_reason || '', /bind/i);
  h.cleanup(c.dir);
});

test('S5: fabricated, empty and unrelated spans are all refused', async () => {
  const c = await h.processedCorpus();
  const cases = {
    grounding_fabricated: /evidence_grounded/,
    grounding_empty: /evidence_grounded/,
    grounding_unrelated_span: /evidence_supports_field/,
  };
  for (const [key, reason] of Object.entries(cases)) {
    const held = h.heldFor(c.db, c.keys[key]);
    assert.ok(held.length, `${key} was held back`);
    assert.match(held[0].reason, reason, `${key} failed the expected gate`);
    assert.equal(h.obligationsFor(c.db, c.keys[key]).length, 0, `${key} created no obligation`);
  }

  const unrelated = h.heldFor(c.db, c.keys.grounding_unrelated_span)[0];
  const diag = JSON.parse(unrelated.diagnostic);
  assert.match(JSON.stringify(diag.failures), /no deadline language/,
    'the refusal explains that a real sentence about an office closure does not state a deadline');

  const held = c.db.prepare('SELECT COUNT(*) c FROM quarantine').get().c;
  assert.ok(held >= 3, 'held items are retained rather than discarded');
  h.cleanup(c.dir);
});

test('S6: instructions embedded in message content change nothing', async () => {
  const c = await h.processedCorpus();
  assert.equal(h.obligationsFor(c.db, c.keys.injection).length, 0, 'no obligation from the injected message');

  const outbox = c.db.prepare('SELECT COUNT(*) c FROM outbox').get().c;
  assert.equal(outbox, 0, 'nothing was queued for an external system');

  const audits = c.db.prepare(`SELECT COUNT(*) c FROM audit_log
    WHERE action LIKE 'external_write_permitted'`).get().c;
  assert.equal(audits, 0, 'no external write was authorised');

  const attempt = c.db.prepare(`SELECT * FROM processing_attempts WHERE message_id = ? ORDER BY id DESC LIMIT 1`)
    .get(c.keys.injection);
  assert.ok(attempt, 'the message was processed rather than skipped');

  // The instruction text is stored as content and never promoted out of it.
  const blocks = c.db.prepare('SELECT canonical_text FROM message_blocks WHERE message_id = ?').all(c.keys.injection);
  assert.ok(blocks.some((b) => /ignore/i.test(b.canonical_text)), 'the text is retained as data');
  const calls = c.db.prepare('SELECT COUNT(*) c FROM model_calls WHERE message_id = ?').get(c.keys.injection).c;
  assert.ok(calls >= 1, 'the extraction step ran with only the read-only source tool available');
  h.cleanup(c.dir);
});

test('S7: the no-send scan passes on a clean checkout, including comments', () => {
  const r = scan(process.cwd());
  assert.equal(r.findings.length, 0, `no send capability in source: ${JSON.stringify(r.findings)}`);
  assert.ok(r.files > 20, 'the scan actually read the tree');

  // The scanner must be able to find violations, or a clean result means nothing.
  const fixtures = scan(require('node:path').join(process.cwd(), 'test', 'fixtures', 'nosend'),
    { targets: ['.'], extensions: ['.txt'] });
  assert.ok(fixtures.files >= 4, 'the fixture directory was actually read');
  assert.ok(fixtures.findings.length >= 3, 'the scanner detects planted violations');
  assert.ok(fixtures.findings.some((f) => /comment/.test(f.file)), 'including one inside a comment');
});

test('S8: the leakage check reports honestly when the private list is unavailable', () => {
  const withoutList = leakage.check(process.cwd(), { privateListPath: undefined });
  assert.equal(withoutList.findings.length, 0, 'no secrets or real addresses in the tree');
  assert.equal(withoutList.complete, false, 'an unavailable private list cannot yield a complete pass');
  assert.match(withoutList.verdict, /private name list was not available/);

  const fs = require('node:fs'); const os = require('node:os'); const p = require('node:path');
  const listPath = p.join(fs.mkdtempSync(p.join(os.tmpdir(), 'names-')), 'names.txt');
  fs.writeFileSync(listPath, '# fictitious\nZzyzx Holdings\n');
  const withList = leakage.check(process.cwd(), { privateListPath: listPath });
  assert.equal(withList.privateList.available, true);
  assert.equal(withList.complete, true, 'with the list present and no findings, the pass is complete');
});

test('S9: silence escalates without new inbound mail, and a restart does not repeat it', async () => {
  const c = await h.processedCorpus({ at: '2026-04-20T14:00:00Z' });
  const question = c.db.prepare(`SELECT t.* FROM tasks t JOIN obligations o ON o.id = t.obligation_id
    WHERE t.kind = 'uw_question' AND o.account_id = 'acct_ironwood'`).get();
  assert.ok(question, 'the outbound question is tracked');

  const first = runSweep(c.db, c.cfg, new FixedClock(c.cfg.timezone, '2026-04-20T14:00:00Z'));
  const silences = c.db.prepare("SELECT level FROM task_escalations WHERE task_id = ? AND level LIKE 'silence%'")
    .all(question.id).map((r) => r.level);
  assert.ok(silences.length >= 1, `silence escalated with no new inbound mail (${silences.join(',')})`);

  const before = c.db.prepare('SELECT COUNT(*) c FROM task_escalations').get().c;
  // A restart means new handles on the same file and no in-memory state.
  const { open } = require('../src/db/db');
  const db2 = open(c.cfg.dbPath);
  const again = runSweep(db2, c.cfg, new FixedClock(c.cfg.timezone, '2026-04-20T15:30:00Z'));
  assert.equal(again.fired.length, 0, 'a second sweep after restart fires nothing already fired');
  assert.equal(db2.prepare('SELECT COUNT(*) c FROM task_escalations').get().c, before, 'no duplicate rows');

  const state = db2.prepare("SELECT * FROM sweep_state WHERE name = 'default'").get();
  assert.ok(state && state.last_run_at, 'the sweep persists its own state');
  assert.ok(first.tasksExamined > 0);
  h.cleanup(c.dir);
});

test('S9: a reply that does not answer the question does not stop the clock', async () => {
  const c = await h.processedCorpus({ at: '2026-04-25T14:00:00Z' });
  const { answeringReply } = require('../src/tasks/sweeps');
  const task = c.db.prepare(`SELECT t.*, o.obligation_subject, o.object_key FROM tasks t
    JOIN obligations o ON o.id = t.obligation_id
    WHERE t.kind = 'uw_question' AND o.account_id = 'acct_ironwood'`).get();

  const replies = c.db.prepare(`SELECT COUNT(*) c FROM messages WHERE gmail_thread_id =
    (SELECT gmail_thread_id FROM messages WHERE id = ?) AND direction = 'inbound'`).get(c.keys.agency_outbound_question).c;
  assert.ok(replies >= 1, 'there is a reply in the thread');
  assert.equal(answeringReply(c.db, task), null, 'but it does not answer what was asked');

  runSweep(c.db, c.cfg, new FixedClock(c.cfg.timezone, '2026-04-25T14:00:00Z'));
  const levels = c.db.prepare("SELECT level FROM task_escalations WHERE task_id = ? AND level LIKE 'silence%'")
    .all(task.id).length;
  assert.ok(levels >= 1, 'the clock kept running through the unrelated reply');
  h.cleanup(c.dir);
});
