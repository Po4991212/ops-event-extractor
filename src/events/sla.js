import { addDays } from '../normalize/dates.js';

// negative = days BEFORE due_date; positive = days AFTER the event's own
// date (extracted_at) when there is no due_date to anchor to. Numbers and
// rationale are in docs/SPEC.md §6.1; `lapse_warning` at 0/0/0 is
// deliberate — that's already a fire.
export const SLA = {
  renewal_due: { firstAction: -45, escalate: -20, critical: -7 },
  payment_due: { firstAction: -10, escalate: -3, critical: -1 },
  lapse_warning: { firstAction: 0, escalate: 0, critical: 0 },
  nonrenewal_notice: { firstAction: 0, escalate: 2, critical: 5 },
  cancellation_notice: { firstAction: 0, escalate: 1, critical: 3 },
  signature_required: { firstAction: 1, escalate: 3, critical: 7 },
  coi_request: { firstAction: 0, escalate: 1, critical: 2 },
  audit_request: { firstAction: 2, escalate: 7, critical: 14 },
  uw_question: { firstAction: 1, escalate: 2, critical: 4 },
  client_commitment: { firstAction: 2, escalate: 5, critical: 10 },
  quote_received: { firstAction: 1, escalate: 3, critical: 7 },
  endorsement_request: { firstAction: 1, escalate: 3, critical: 7 },
  claim_activity: { firstAction: 1, escalate: 3, critical: 7 },
  declination: { firstAction: 1, escalate: 3, critical: 7 },
  other: { firstAction: 2, escalate: 7, critical: 14 }
};

/**
 * Anchors renewal/payment/lapse/cancellation-family SLAs to due_date
 * (offsets are negative, i.e. before it); everything else anchors to the
 * event's own date (extracted_at), since there is nothing to count down to.
 */
const DUE_DATE_ANCHORED = new Set(['renewal_due', 'payment_due', 'lapse_warning', 'nonrenewal_notice', 'cancellation_notice']);

export function computeSla(ev) {
  const table = SLA[ev.kind] || SLA.other;
  const anchorIso = (DUE_DATE_ANCHORED.has(ev.kind) && ev.due_date) ? ev.due_date : ev.extracted_at_date;
  if (!anchorIso) return { firstAction: null, escalate: null, critical: null };
  return {
    firstAction: addDays(anchorIso, table.firstAction),
    escalate: addDays(anchorIso, table.escalate),
    critical: addDays(anchorIso, table.critical)
  };
}
