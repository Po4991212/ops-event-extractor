'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, cleanup, corpus } = require('./helpers');
const { FixedClock } = require('../src/core/clock');
const { storeMessage } = require('../src/ingest/store');
const { upsertMailbox } = require('../src/ingest/sync');
const { processMessage } = require('../src/extract/pipeline');
const { makeExtractor } = require('../src/extract/model/extractor');
const learned = require('../src/extract/learned/patterns');
const { sha256 } = require('../src/core/hash');

/**
 * A carrier none of the nine parser families knows, sending the same payment
 * reminder template for different clients. Every one of these goes to the
 * model today; the point of learned patterns is that most of them stop doing so.
 */
const SENDER = 'billing@newcarrier.test';
const CLIENTS = [
  ['Bluebonnet Logistics LLC', 'PGR-CM-4471902'],
  ['Pecan Grove Dental PLLC', 'FQ-CA-5590231'],
  ['Sabine River Marine Supply Inc', 'TWIA-8841207'],
  ['Comal Valley HOA', 'WS-2210045'],
  ['Ironwood Roofing Co', 'AMW-TFIA-33125'],
  ['Bluebonnet Logistics LLC', 'IPFS-QN-778120'],
];

function reminder(i, { from = SENDER, due = `05/${10 + i}/2026`, lead = '' } = {}) {
  const [name, policy] = CLIENTS[i % CLIENTS.length];
  return {
    key: `lp-${from}-${i}-${due}-${lead.length}`,
    thread: `lp-thread-${from}-${i}`,
    from, to: 'commercial-tx@agency.test', subject: `Payment reminder ${policy}`,
    date: `2026-04-${String(10 + i).padStart(2, '0')}T14:00:00Z`,
    plain: `Dear agent,\n\n${lead}A premium payment for ${name} on policy ${policy} is outstanding.\n`
      + `Payment is due by ${due}.\n\nThank you.\n`,
  };
}

function setup(overrides = {}) {
  const { db, cfg, dir } = freshDb('learned');
  Object.assign(cfg.learnedPatterns, overrides);
  const clock = new FixedClock(cfg.timezone, '2026-05-01T14:00:00Z');
  corpus.seedReferenceData(db, clock);
  upsertMailbox(db, clock, corpus.MAILBOXES[0]);
  const inner = makeExtractor(db, cfg, clock);
  const calls = { n: 0 };
  const modelExtractor = async (m, b) => { calls.n += 1; return inner(m, b); };
  const run = async (spec, opts = {}) => {
    const { id } = storeMessage(db, cfg, clock, {
      mailboxId: 'mbx_commercialtx', gmailMessageId: `g_${sha256(spec.key).slice(0, 14)}`, gmailThreadId: `th_${sha256(spec.thread).slice(0, 12)}`,
      raw: corpus.buildRaw(spec), labels: ['INBOX'], observedAt: spec.date,
    });
    return processMessage(db, cfg, clock, id, { modelExtractor, ...opts });
  };
  return { db, cfg, clock, dir, calls, run };
}

/** The payment-reminder pattern. Other templates in a message may teach their own. */
function onlyPattern(db) {
  const rows = learned.list(db).filter((p) => p.kind === 'payment_due');
  assert.equal(rows.length, 1, `expected one payment_due pattern, found ${rows.length}`);
  return rows[0];
}

test('an accepted model answer becomes a shadow pattern built from template words only', async () => {
  const { db, dir, run } = setup();
  try {
    await run(reminder(0));
    const p = onlyPattern(db);
    assert.equal(p.status, 'shadow');
    assert.equal(p.sender, SENDER);
    assert.equal(p.kind, 'payment_due');
    assert.equal(p.category, 'billing');
    const rules = JSON.parse(p.rules_json);
    assert.deepEqual(rules.trigger, ['Payment', 'is', 'due', 'by']);
    assert.deepEqual(rules.fields.stated_deadline.cue, ['Payment', 'is', 'due', 'by']);
    // No client name and no policy number made it into the pattern.
    assert.doesNotMatch(p.rules_json, /Bluebonnet|PGR|\d/);
  } finally { cleanup(dir); }
});

test('shadow agreement makes a pattern ready, but only a named person can approve it', async () => {
  const { db, clock, dir, run } = setup();
  try {
    for (let i = 0; i < 4; i += 1) await run(reminder(i));
    const p = onlyPattern(db);
    assert.equal(p.agreements, 3);
    assert.equal(p.status, 'ready');
    assert.throws(() => learned.approve(db, clock, p.id, {}), /name of the person/);
    const a = learned.approve(db, clock, p.id, { by: 'pv' });
    assert.equal(a.status, 'approved');
    assert.equal(a.approved_by, 'pv');
  } finally { cleanup(dir); }
});

test('a pattern still in shadow cannot be approved', async () => {
  const { db, clock, dir, run } = setup();
  try {
    await run(reminder(0));
    await run(reminder(1));
    assert.throws(() => learned.approve(db, clock, onlyPattern(db).id, { by: 'pv' }), /only a pattern .* \(ready\)/);
  } finally { cleanup(dir); }
});

test('an approved pattern replaces the model call and its event still passes the evidence gates', async () => {
  const { db, clock, dir, calls, run } = setup({ spotCheckEvery: 0 });
  try {
    for (let i = 0; i < 4; i += 1) await run(reminder(i));
    learned.approve(db, clock, onlyPattern(db).id, { by: 'pv' });
    const before = calls.n;

    const out = await run(reminder(4));
    assert.equal(calls.n, before, 'the model must not be called');
    assert.equal(out.learnedPattern, onlyPattern(db).id);
    assert.equal(out.accepted.length, 1);
    assert.equal(out.accepted[0].kind, 'payment_due');

    const ob = db.prepare('SELECT * FROM obligations WHERE id = ?').get(out.accepted[0].obligationId);
    assert.equal(ob.stated_deadline, '2026-05-14');
    const ev = db.prepare('SELECT * FROM evidence WHERE event_version_id = ?').all(ob.current_version_id);
    assert.ok(ev.some((e) => e.field_path === 'stated_deadline' && /Payment is due by 05\/14\/2026/.test(e.quote)));
    assert.equal(onlyPattern(db).uses, 1);
  } finally { cleanup(dir); }
});

test('approved patterns work without the model at all (parsers-only mode)', async () => {
  const { db, clock, dir, run } = setup({ spotCheckEvery: 0 });
  try {
    for (let i = 0; i < 4; i += 1) await run(reminder(i));
    learned.approve(db, clock, onlyPattern(db).id, { by: 'pv' });
    const out = await run(reminder(5), { modelExtractor: null });
    assert.equal(out.deferred, false);
    assert.equal(out.accepted.length, 1);
  } finally { cleanup(dir); }
});

test('a pattern never applies to a different sender, even with identical text', async () => {
  const { db, clock, dir, calls, run } = setup({ spotCheckEvery: 0 });
  try {
    for (let i = 0; i < 4; i += 1) await run(reminder(i));
    learned.approve(db, clock, onlyPattern(db).id, { by: 'pv' });
    const before = calls.n;
    const out = await run(reminder(4, { from: 'billing@newcarrier.test.lookalike.test' }));
    assert.equal(calls.n, before + 1, 'a lookalike sender goes to the model');
    assert.equal(out.learnedPattern, undefined);
  } finally { cleanup(dir); }
});

test('a disagreement with the model in shadow suspends the pattern', async () => {
  const { db, clock, dir, run } = setup();
  try {
    await run(reminder(0));
    await run(reminder(1));
    // Same template, but a lapse line ahead of it changes what the model reports.
    await run(reminder(2, { lead: 'Coverage will lapse on 06/01/2026 if unpaid.\n' }));
    const p = onlyPattern(db);
    assert.equal(p.disagreements, 1);
    assert.equal(p.status, 'suspended');
    assert.throws(() => learned.approve(db, clock, p.id, { by: 'pv' }));
  } finally { cleanup(dir); }
});

test('a spot check that disagrees suspends an approved pattern and the model answer is used', async () => {
  const { db, clock, dir, calls, run } = setup({ spotCheckEvery: 2 });
  try {
    for (let i = 0; i < 4; i += 1) await run(reminder(i));
    learned.approve(db, clock, onlyPattern(db).id, { by: 'pv' });

    await run(reminder(4)); // use 1: pattern only
    const before = calls.n;
    const out = await run(reminder(5, { lead: 'Coverage will lapse on 06/01/2026 if unpaid.\n' })); // use 2: spot check
    assert.equal(calls.n, before + 1);
    assert.equal(out.learnedPattern, undefined, 'the model answer wins a spot check');
    assert.equal(onlyPattern(db).status, 'suspended');

    const after = calls.n;
    await run(reminder(0, { due: '05/30/2026' }));
    assert.equal(calls.n, after + 1, 'a suspended pattern no longer replaces the model');
  } finally { cleanup(dir); }
});

test('reprocessing the same messages does not count agreement twice', async () => {
  const { db, cfg, clock, dir, run } = setup();
  try {
    for (let i = 0; i < 3; i += 1) await run(reminder(i));
    const ids = db.prepare('SELECT id FROM messages').all().map((r) => r.id);
    for (const id of ids) await processMessage(db, cfg, clock, id, { modelExtractor: makeExtractor(db, cfg, clock) });
    const p = onlyPattern(db);
    assert.equal(p.agreements, 2);
    assert.equal(p.status, 'shadow');
  } finally { cleanup(dir); }
});

test('nothing is learned from colleagues inside the agency', async () => {
  const { db, dir, run } = setup();
  try {
    await run(reminder(0, { from: 'dana@agency.test' }));
    assert.equal(learned.list(db).length, 0);
  } finally { cleanup(dir); }
});

test('a retired pattern is not learned again from the next email', async () => {
  const { db, clock, dir, run } = setup();
  try {
    await run(reminder(0));
    learned.retire(db, clock, onlyPattern(db).id, { by: 'pv', reason: 'template is unreliable' });
    await run(reminder(1));
    const p = onlyPattern(db);
    assert.equal(p.status, 'retired');
  } finally { cleanup(dir); }
});

test('an email where the model found two obligations does not count as agreement', () => {
  const one = { kind: 'payment_due', stated_deadline: '2026-05-12', amount: null };
  assert.equal(learned.compare(one, [one]).agree, true);
  const r = learned.compare(one, [one, { kind: 'coi_request', stated_deadline: null, amount: null }]);
  assert.equal(r.agree, false);
  assert.match(r.detail.reason, /found 2 obligations/);
});
