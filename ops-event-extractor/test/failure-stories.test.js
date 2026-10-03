'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { FixedClock } = require('../src/core/clock');
const fulfillment = require('../src/tasks/fulfillment');
const { runSweep } = require('../src/tasks/sweeps');

/**
 * The four ways this kind of system fails quietly in an agency. Each of these
 * is a thing that would look fine on a dashboard and be wrong.
 */

test('a promise to remove a vehicle stays open until the endorsement actually exists', async () => {
  const c = await h.processedCorpus({ at: '2026-04-10T14:00:00Z' });
  const obl = c.db.prepare("SELECT * FROM obligations WHERE object_key LIKE 'vehicle:%'").get();
  assert.ok(obl, 'the commitment was captured');

  // Before the endorsement document is filed.
  const early = fulfillment.check(c.db, c.cfg, new FixedClock(c.cfg.timezone, '2026-04-10T14:00:00Z'));
  let task = h.taskFor(c.db, obl.id);
  assert.notEqual(task.status, 'completed', 'saying it will happen is not evidence it happened');
  assert.ok(!early.closed.some((x) => x.task === task.id));

  // After it is filed, with the right VIN.
  const later = fulfillment.check(c.db, c.cfg, new FixedClock(c.cfg.timezone, '2026-04-25T14:00:00Z'));
  task = h.taskFor(c.db, obl.id);
  assert.equal(task.status, 'completed', 'the endorsement document closes it');
  const closing = later.closed.find((x) => x.task === task.id);
  assert.match(closing.checks.object.why, /jalc4w164h7000112/i, 'closed on the VIN, not on the account alone');

  const link = c.db.prepare("SELECT * FROM fulfillment_links WHERE task_id = ? AND decision = 'auto_close'").get(task.id);
  assert.ok(link, 'the closure records which document closed it');
  h.cleanup(c.dir);
});

test('an endorsement for a different vehicle does not close the commitment', async () => {
  const c = await h.processedCorpus({ at: '2026-04-25T14:00:00Z' });
  const obl = c.db.prepare("SELECT * FROM obligations WHERE object_key LIKE 'vehicle:%'").get();
  const wrong = c.db.prepare("SELECT * FROM qq_activity WHERE object_key LIKE '%Ford Transit%'").get();
  assert.ok(wrong, 'the wrong-vehicle endorsement is in the fixture set');

  const r = fulfillment.check(c.db, c.cfg, c.clock);
  const usedWrong = [...r.closed, ...r.candidates].some((x) => x.activity === wrong.id
    && x.task === h.taskFor(c.db, obl.id).id && r.closed.some((y) => y.activity === wrong.id));
  assert.equal(usedWrong, false, 'the wrong VIN never closes the task');
  h.cleanup(c.dir);
});

test('an unanswered audit escalates before its deadline rather than on it', async () => {
  const c = await h.processedCorpus({ at: '2026-04-15T14:00:00Z' });
  const obl = c.db.prepare(`SELECT * FROM obligations WHERE kind = 'audit_request' AND account_id = 'acct_ironwood'`).get();
  const task = h.taskFor(c.db, obl.id);
  assert.ok(obl.stated_deadline, 'the audit has a stated deadline');
  assert.ok(task.escalation_at < obl.stated_deadline || task.escalation_at.slice(0, 10) < obl.stated_deadline,
    `escalation ${task.escalation_at} precedes the deadline ${obl.stated_deadline}`);

  runSweep(c.db, c.cfg, new FixedClock(c.cfg.timezone, '2026-04-20T14:00:00Z'));
  const fired = c.db.prepare('SELECT level FROM task_escalations WHERE task_id = ?').all(task.id).map((r) => r.level);
  assert.ok(fired.includes('first_action'), 'the first reminder fired');
  const deadlineDay = new Date(`${obl.stated_deadline}T00:00:00Z`);
  assert.ok(new Date('2026-04-20T14:00:00Z') < deadlineDay, 'and it fired while there was still time to act');
  h.cleanup(c.dir);
});

test('a matching receipt closes the payment instead of chasing it again', async () => {
  const c = await h.processedCorpus({ at: '2026-04-25T14:00:00Z' });
  const obl = c.db.prepare("SELECT * FROM obligations WHERE object_key = 'installment:3'").get();
  const r = fulfillment.check(c.db, c.cfg, c.clock);
  const closed = r.closed.find((x) => x.checks.amount.why.includes('1240'));
  assert.ok(closed, 'the matching receipt closed the payment');
  assert.match(closed.checks.term.why, /term matches/);
  h.cleanup(c.dir);
});

test('a receipt for another term and amount does not close the payment', async () => {
  const c = await h.processedCorpus({ at: '2026-04-25T14:00:00Z' });
  const other = c.db.prepare("SELECT * FROM qq_activity WHERE object_key = 'installment:2'").get();
  const r = fulfillment.check(c.db, c.cfg, c.clock);
  assert.ok(!r.closed.some((x) => x.activity === other.id), 'the wrong-term receipt closed nothing');
  const considered = [...r.candidates, ...r.rejected].some((x) => x.activity === other.id);
  assert.ok(considered, 'but it was examined and the reason recorded rather than ignored');
  h.cleanup(c.dir);
});

test('a note this system wrote cannot be used as evidence that the work was done', async () => {
  const c = await h.processedCorpus({ at: '2026-04-25T14:00:00Z' });
  const selfNote = c.db.prepare("SELECT * FROM qq_activity WHERE generated_by = 'ops-event-extractor'").get();
  assert.ok(selfNote, 'the self-generated note is in the fixture set');
  const r = fulfillment.check(c.db, c.cfg, c.clock);
  assert.ok(!r.closed.some((x) => x.activity === selfNote.id), 'it closed nothing');
  assert.ok(r.rejected.some((x) => x.activity === selfNote.id && /self-generated/.test(x.why)),
    'and the refusal says why');
  h.cleanup(c.dir);
});

test('a reversal reopens a task that was closed on the thing being reversed', async () => {
  const c = await h.processedCorpus({ at: '2026-05-01T14:00:00Z' });
  const r = fulfillment.check(c.db, c.cfg, c.clock);
  assert.ok(r.reopened.length >= 1, 'the reversal reopened something');
  const obl = c.db.prepare("SELECT * FROM obligations WHERE object_key = 'installment:3'").get();
  const task = h.taskFor(c.db, obl.id);
  assert.notEqual(task.status, 'completed', 'the payment is owed again');
  const link = c.db.prepare("SELECT * FROM fulfillment_links WHERE task_id = ? AND decision = 'reversal'").get(task.id);
  assert.ok(link, 'the reopening is traceable to the reversal');
  h.cleanup(c.dir);
});

test('kinds with no agreed SLA still surface, with the gap stated', async () => {
  const c = await h.processedCorpus();
  for (const kind of ['declination', 'claim_activity', 'endorsement_request']) {
    const obl = c.db.prepare('SELECT * FROM obligations WHERE kind = ?').get(kind);
    assert.ok(obl, `${kind} produced an obligation`);
    const task = h.taskFor(c.db, obl.id);
    assert.ok(task, `${kind} produced a visible task`);
    assert.equal(task.missing_sla, 1, `${kind} is marked as having no agreed SLA rather than given an invented one`);
    assert.notEqual(task.status, 'completed');
  }
  h.cleanup(c.dir);
});
