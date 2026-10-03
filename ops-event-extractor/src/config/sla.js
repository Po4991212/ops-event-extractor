'use strict';
/**
 * THE single SLA configuration source. There is deliberately no second table.
 *
 * Sign convention (from the September continuation):
 *   negative -> days BEFORE a confirmed obligation due date  (calendar days)
 *   zero/pos -> days AFTER first supported receipt            (business days)
 *
 * `first`/`critical` are agency-provided. `escalation` values are marked as
 * assumptions: no earlier table was supplied to this build, so the intermediate
 * step was interpolated and needs agency review (see docs/adr/0003).
 */
const A = 'assumption';
const G = 'agency-provided';

const SLA = {
  lapse_warning:        { first: 0,   escalation: 0,   critical: 0,   firstSrc: G, escSrc: A, critSrc: G },
  cancellation_notice:  { first: 0,   escalation: 1,   critical: 3,   firstSrc: G, escSrc: A, critSrc: G },
  coi_request:          { first: 0,   escalation: 1,   critical: 2,   firstSrc: G, escSrc: A, critSrc: G },
  condition_precedent:  { first: 1,   escalation: 2,   critical: 3,   firstSrc: G, escSrc: A, critSrc: G },
  payment_due:          { first: -10, escalation: -5,  critical: -1,  firstSrc: G, escSrc: A, critSrc: G },
  uw_question:          { first: 1,   escalation: 2,   critical: 4,   firstSrc: G, escSrc: A, critSrc: G },
  client_commitment:    { first: 1,   escalation: 3,   critical: 5,   firstSrc: G, escSrc: A, critSrc: G },
  signature_required:   { first: 1,   escalation: 3,   critical: 7,   firstSrc: G, escSrc: A, critSrc: G },
  quote_received:       { first: 1,   escalation: 3,   critical: 7,   firstSrc: G, escSrc: A, critSrc: G },
  audit_request:        { first: 2,   escalation: 7,   critical: 14,  firstSrc: G, escSrc: A, critSrc: G },
  renewal_due:          { first: -45, escalation: -21, critical: -7,  firstSrc: G, escSrc: A, critSrc: G },
  // Retained from the original policy until the agency changes it.
  nonrenewal_notice:    { first: 0,   escalation: 2,   critical: 5,   firstSrc: G, escSrc: G, critSrc: G },
};

/** Kinds with no defined offsets: still get a visible task, explicitly flagged. */
const MISSING_SLA_KINDS = ['declination', 'endorsement_request', 'claim_activity', 'other'];

const EVENT_KINDS = [
  'renewal_due', 'payment_due', 'lapse_warning', 'nonrenewal_notice', 'cancellation_notice',
  'signature_required', 'coi_request', 'audit_request', 'quote_received', 'declination',
  'uw_question', 'client_commitment', 'endorsement_request', 'claim_activity', 'other',
  'condition_precedent',
];

/** Ordering invariant: first <= escalation <= critical on the timeline. */
function validateSla(table = SLA) {
  const problems = [];
  for (const [kind, row] of Object.entries(table)) {
    if (!EVENT_KINDS.includes(kind)) problems.push(`${kind}: not a supported event kind`);
    const { first, escalation, critical } = row;
    if (![first, escalation, critical].every(Number.isFinite)) { problems.push(`${kind}: non-numeric offset`); continue; }
    const sameSign = (a, b) => (a < 0) === (b < 0);
    if (!sameSign(first, critical) || !sameSign(first, escalation)) {
      problems.push(`${kind}: offsets mix deadline-relative and receipt-relative anchors`);
    }
    if (!(first <= escalation && escalation <= critical)) {
      problems.push(`${kind}: offsets out of order (${first}, ${escalation}, ${critical})`);
    }
  }
  for (const k of MISSING_SLA_KINDS) if (table[k]) problems.push(`${k}: must not have an invented SLA`);
  const covered = new Set([...Object.keys(table), ...MISSING_SLA_KINDS]);
  for (const k of EVENT_KINDS) if (!covered.has(k)) problems.push(`${k}: no SLA row and not listed as missing-SLA`);
  return problems;
}

/** Negative offsets are anchored to the confirmed due date; positive to receipt. */
function anchorOf(kind) {
  const row = SLA[kind];
  if (!row) return null;
  return row.first < 0 || row.critical < 0 ? 'due_date' : 'receipt';
}

module.exports = { SLA, MISSING_SLA_KINDS, EVENT_KINDS, validateSla, anchorOf };
