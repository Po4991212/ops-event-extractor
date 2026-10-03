'use strict';
const { LABELS } = require('./labels');

/**
 * Scores a processed database against the labels.
 *
 * Every rate is reported with its numerator and denominator, because "97%
 * accurate" on 36 fixtures is a sentence that should not be able to hide how
 * few fixtures there were. Nothing here reports a rate as a bare percentage.
 */
function obligationsForMessage(db, messageKey, keyToMessageId) {
  const messageId = keyToMessageId[messageKey];
  if (!messageId) return [];
  return db.prepare(`SELECT o.*, sl.link_reason FROM source_links sl JOIN obligations o ON o.id = sl.obligation_id
    WHERE sl.message_id = ?`).all(messageId);
}

function matches(expected, actual, db) {
  if (expected.kind !== actual.kind) return false;
  if (expected.account === null) { if (actual.account_id !== null) return false; }
  else if (expected.account !== actual.account_id) return false;
  if (expected.policy && expected.policy !== actual.policy_ref) return false;
  if (expected.deadline) {
    const v = db.prepare('SELECT payload_json FROM event_versions WHERE id = ?').get(actual.current_version_id);
    const p = v ? JSON.parse(v.payload_json) : {};
    if ((actual.stated_deadline || p.stated_deadline) !== expected.deadline) return false;
  }
  if (expected.amount !== undefined) {
    const v = db.prepare('SELECT payload_json FROM event_versions WHERE id = ?').get(actual.current_version_id);
    const p = v ? JSON.parse(v.payload_json) : {};
    if (Number(p.amount) !== Number(expected.amount)) return false;
  }
  if (expected.object && !String(actual.object_key || '').startsWith(expected.object)) return false;
  return true;
}

function score(db, keyToMessageId) {
  const rows = [];
  let tp = 0; let fp = 0; let fn = 0;
  let dispositionRight = 0; let dispositionTotal = 0;

  for (const [key, label] of Object.entries(LABELS)) {
    const messageId = keyToMessageId[key];
    if (!messageId) continue;
    const actual = obligationsForMessage(db, key, keyToMessageId);
    const held = db.prepare('SELECT COUNT(*) c FROM quarantine WHERE message_id = ?').get(messageId).c;
    const noise = db.prepare("SELECT COUNT(*) c FROM processing_attempts WHERE message_id = ? AND status = 'noise'").get(messageId).c;

    const observed = held > 0 ? 'held' : (actual.length ? 'accepted' : (noise ? 'noise' : 'none'));
    // "noise" and "none" both mean nothing was created; treat them as
    // interchangeable when the label expected either.
    const dispOk = observed === label.disposition
      || (label.disposition === 'none' && observed === 'noise')
      || (label.disposition === 'noise' && observed === 'none')
      || (label.disposition === 'accepted' && observed === 'accepted');
    dispositionTotal += 1;
    if (dispOk) dispositionRight += 1;

    const unmatched = [...actual];
    const missed = [];
    for (const e of label.expect) {
      const i = unmatched.findIndex((a) => matches(e, a, db));
      if (i >= 0) { tp += 1; unmatched.splice(i, 1); } else { fn += 1; missed.push(e); }
    }
    // A merged obligation is not a false positive: the label said it should
    // join an existing one, and joining is what "link_reason" records.
    const spurious = label.mergesWith
      ? unmatched.filter((a) => a.link_reason === 'original')
      : unmatched;
    fp += spurious.length;

    rows.push({
      key, expectedDisposition: label.disposition, observedDisposition: observed, dispositionOk: dispOk,
      expected: label.expect.length, matched: label.expect.length - missed.length,
      missed: missed.map((m) => m.kind), spurious: spurious.map((s) => s.kind), notes: label.notes || null,
    });
  }

  const precisionDen = tp + fp;
  const recallDen = tp + fn;
  return {
    counts: { truePositives: tp, falsePositives: fp, falseNegatives: fn },
    precision: { value: precisionDen ? tp / precisionDen : null, numerator: tp, denominator: precisionDen },
    recall: { value: recallDen ? tp / recallDen : null, numerator: tp, denominator: recallDen },
    disposition: { value: dispositionTotal ? dispositionRight / dispositionTotal : null,
      numerator: dispositionRight, denominator: dispositionTotal },
    rows,
    caveat: 'Measured on a synthetic corpus with the offline extraction stub. These numbers describe '
      + 'whether the pipeline behaves as specified on fixtures written alongside it. They are not a '
      + 'measurement of live extraction quality and must not be quoted as one.',
  };
}

function format(m) {
  const pct = (r) => (r.value === null ? 'n/a' : `${(r.value * 100).toFixed(1)}% (${r.numerator}/${r.denominator})`);
  const lines = [
    `precision:   ${pct(m.precision)}`,
    `recall:      ${pct(m.recall)}`,
    `disposition: ${pct(m.disposition)}`,
    '',
  ];
  for (const r of m.rows.filter((x) => !x.dispositionOk || x.missed.length || x.spurious.length)) {
    lines.push(`  ${r.key}: expected ${r.expectedDisposition}, observed ${r.observedDisposition}`
      + (r.missed.length ? `, missed [${r.missed.join(', ')}]` : '')
      + (r.spurious.length ? `, unexpected [${r.spurious.join(', ')}]` : ''));
  }
  if (lines[lines.length - 1] !== '') lines.push('');
  lines.push(m.caveat);
  return lines.join('\n');
}

module.exports = { score, format };
