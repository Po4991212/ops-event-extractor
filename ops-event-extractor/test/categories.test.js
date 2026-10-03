'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { categorize, categoryForKind } = require('../src/extract/categorize');
const { CATEGORIES, validateCategories } = require('../src/config/categories');
const { processedCorpus, cleanup } = require('./helpers');

/** A minimal message as getMessage returns it, with one body block. */
function msg(subject, body = '', { from = 'someone@client.test', parts = [] } = {}) {
  return { subject, from_addr: from, parts, blocks: [{ seq: 0, kind: 'reply', canonical_text: body }] };
}
const none = { routing: { family: null, route: 'fallback' }, accepted: [], quarantined: [] };
const withKind = (kind, family = null) => ({ routing: { family, route: 'family' }, accepted: [{ kind }], quarantined: [] });

// One everyday email per category, written from the agency's descriptions.
const SAMPLES = [
  [1, 'Do you insure food trucks?', 'A friend referred me to you. We are looking for insurance for our new food truck.'],
  [2, 'Completed application for Ridge Bakery', 'Attached is the ACORD application and our vehicle schedule.'],
  [3, 'Missing information for Ridge Bakery submission', 'Please provide three years of loss history and the roof age.'],
  [4, 'Proposal for Ridge Bakery', 'Here are two options with different deductibles for your review.'],
  [5, 'Authorization to bind - Ridge Bakery', 'We accept option B. Please go ahead.'],
  [6, 'Upcoming renewal - Ridge Bakery', 'Please send updated sales figures before we go to market.'],
  [7, 'Add vehicle to policy', 'We bought a 2024 Ford F-150 and need it covered from Monday.'],
  [8, 'Certificate of insurance needed for job site', 'The general contractor needs us listed by Friday.'],
  [9, 'Question about exclusions in our policy', 'Would mold damage from a leaking pipe be excluded?'],
  [10, 'Invoice 2231 for Ridge Bakery', 'Your balance for the new policy is attached.'],
  [11, 'Your finance agreement is ready', 'Sign and return it with the down payment.'],
  [12, 'Please cancel our policy effective 6/1', 'We sold the business.'],
  [13, 'New claim - water damage at Ridge Bakery', 'A pipe burst overnight in the kitchen.'],
  [14, 'Inspection scheduled for 123 Main St', 'The inspector will arrive Tuesday at 10am.'],
  [15, 'Premium audit appointment', 'Please have payroll records ready for the auditor.'],
  [16, 'Your commission statement for May', 'Statement attached.'],
  [17, 'Account handoff: Ridge Bakery to Maria', 'Maria owns this account starting Monday.'],
  [18, 'Our June newsletter', 'Ten tips for small business owners. Unsubscribe at any time.'],
];

test('the configuration has exactly the eighteen agency categories', () => {
  assert.deepEqual(validateCategories(), []);
  assert.equal(CATEGORIES.length, 18);
});

for (const [n, subject, body] of SAMPLES) {
  test(`category ${n}: "${subject}"`, () => {
    const r = categorize(msg(subject, body), none);
    assert.equal(r.n, n, `${subject} went to ${r.n} (${r.reason})`);
    assert.equal(r.suspicious, false);
  });
}

test('an extracted obligation decides the category before any keyword', () => {
  // The subject says "renewal", but the grounded obligation is a cancellation.
  const r = categorize(msg('Renewal update', 'Coverage will be cancelled.'), withKind('cancellation_notice'));
  assert.equal(r.category, 'cancellation');
  assert.equal(r.source, 'event_kind');
});

test('a payment from a premium finance company is premium financing, not billing', () => {
  assert.equal(categoryForKind('payment_due', { family: 'ipfs' }), 'premium_financing');
  assert.equal(categoryForKind('payment_due', { text: 'Installment 3 is due' }), 'premium_financing');
  assert.equal(categoryForKind('payment_due', { text: 'Premium due by 05/01/2026' }), 'billing');
});

test('a request to change bank details is suspicious even when it looks like an invoice', () => {
  const r = categorize(msg('Invoice 2231', 'Please note our updated bank details for all future payments.'), withKind('payment_due'));
  assert.equal(r.n, 18);
  assert.equal(r.suspicious, true);
  assert.match(r.reason, /payment/);
});

test('a lookalike carrier sender is suspicious', () => {
  const r = categorize(msg('Renewal Notice', 'Renew now.', { from: 'notices@twia.test.evil-lookalike.test' }), withKind('renewal_due'));
  assert.equal(r.suspicious, true);
  assert.match(r.reason, /imitates twia\.test/);
});

test('a risky attachment is suspicious', () => {
  const r = categorize(msg('Invoice', 'See attached.', { parts: [{ filename: 'invoice.pdf.exe' }] }), none);
  assert.equal(r.suspicious, true);
});

test('when nothing fits the category is left empty for a person, not guessed', () => {
  const r = categorize(msg('Checking in', 'Hope you had a good weekend.'), none);
  assert.equal(r.category, null);
  assert.equal(r.source, 'none');
});

test('every corpus email gets a category row, and nothing is learned from suspicious mail', async () => {
  const { db, dir } = await processedCorpus();
  try {
    const total = db.prepare('SELECT COUNT(*) c FROM messages').get().c;
    assert.equal(db.prepare('SELECT COUNT(*) c FROM message_categories').get().c, total);
    const sus = db.prepare(`SELECT m.from_addr FROM message_categories c JOIN messages m ON m.id = c.message_id
      WHERE c.suspicious = 1`).all().map((r) => r.from_addr);
    assert.ok(sus.some((f) => f.includes('evil-lookalike')));
    const fromSuspicious = db.prepare("SELECT COUNT(*) c FROM learned_patterns WHERE sender LIKE '%evil-lookalike%'").get().c;
    assert.equal(fromSuspicious, 0);
  } finally { cleanup(dir); }
});
