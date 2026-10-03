'use strict';
const { validateEventPayload, SCHEMA_VERSION } = require('./schema');
const { validateSpan, supportsField } = require('./evidence');

/**
 * Hard gates, run before any score is computed. A confidence number never
 * rescues a candidate that failed one of these.
 *
 * Completeness is handled differently from the rest, deliberately: a notice
 * with an unreadable attachment is exactly the message the agency cannot
 * afford to drop, so it degrades to review instead of being quarantined. That
 * interpretation is recorded in docs/adr/0005.
 */
const FACTUAL_PATHS = /^(stated_deadline|amount|policy_ref|object_key|obligation)$/;

function blockKindOf(blocks, seq) {
  const b = blocks.find((x) => x.seq === seq);
  return b ? b.kind : null;
}

function runGates(event, { blocks, message, resolution, zone, payload }) {
  const failures = [];
  const warnings = [];
  const evidenceOut = [];

  if (payload && !validateEventPayload(payload)) {
    failures.push({ gate: 'schema', detail: JSON.stringify(validateEventPayload.errors).slice(0, 400) });
    return { ok: false, failures, warnings, evidence: [] };
  }
  if (payload && payload.schema_version !== SCHEMA_VERSION) {
    failures.push({ gate: 'schema', detail: `unexpected schema version ${payload.schema_version}` });
  }

  // --- every factual field needs a span that exists and that supports it ---
  const claimed = [];
  if (event.stated_deadline !== null) claimed.push(['stated_deadline', event.stated_deadline]);
  if (event.amount !== null) claimed.push(['amount', event.amount]);
  if (event.object_key !== null) claimed.push(['object_key', event.object_key]);
  claimed.push(['obligation', event.obligation]);

  const fieldIndex = new Map((event.fields || []).map((f) => [f.path, f]));

  for (const [path, value] of claimed) {
    const f = fieldIndex.get(path);
    if (!f) {
      failures.push({ gate: 'evidence_present', detail: `no evidence supplied for field "${path}"` });
      continue;
    }
    const span = validateSpan(blocks, f.block_seq, f.quote);
    if (!span.ok) {
      failures.push({ gate: 'evidence_grounded', detail: `${path}: ${span.reason}` });
      continue;
    }
    if (span.corrected) warnings.push({ gate: 'evidence_block_index', detail: `${path}: ${span.reason}` });

    // The obligation line is a summary the extractor wrote, not a string the
    // carrier wrote. It must point at a real span, but it is recorded as
    // derived and is not held to literal token support.
    if (path === 'obligation') {
      evidenceOut.push({ path, value, span, support: 'summary derived from this span', nature: 'derived' });
      continue;
    }

    const support = supportsField(path, value, f.quote, zone, { blockKind: blockKindOf(blocks, span.blockSeq) });
    if (!support.ok) {
      failures.push({ gate: 'evidence_supports_field', detail: `${path}: ${support.reason}` });
      continue;
    }
    evidenceOut.push({ path, value, span, support: support.reason, nature: 'extracted' });
  }

  // --- parseable dates and amounts ---
  if (event.stated_deadline !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(event.stated_deadline))) {
    failures.push({ gate: 'date_parse', detail: `stated_deadline "${event.stated_deadline}" is not an ISO date` });
  }
  if (event.amount !== null && !Number.isFinite(Number(event.amount))) {
    failures.push({ gate: 'amount_parse', detail: `amount "${event.amount}" is not numeric` });
  }

  // --- account contradiction ---
  if (resolution && resolution.requiresReview && /conflict|contradic/i.test(resolution.reason || '')) {
    failures.push({ gate: 'account_contradiction', detail: resolution.reason });
  }

  // --- processing completeness (degrade, do not discard) ---
  if (message && message.processing_complete === 0) {
    warnings.push({ gate: 'processing_completeness', detail: message.incomplete_reason || 'incomplete processing' });
  }

  return { ok: failures.length === 0, failures, warnings, evidence: evidenceOut };
}

/**
 * Urgency is computed independently of confidence and independently of whether
 * the gates passed. A lapse notice that failed grounding still has to reach a
 * human today.
 */
function urgencyOf(event, { bindObserved = false } = {}) {
  if (event.kind === 'lapse_warning') return { urgent: true, reason: 'potential lapse' };
  if (event.kind === 'cancellation_notice') return { urgent: true, reason: 'pending cancellation' };
  if (event.kind === 'condition_precedent' && bindObserved) {
    return { urgent: true, reason: 'bind discussion observed while a binding condition is unanswered' };
  }
  return { urgent: false, reason: null };
}

module.exports = { runGates, urgencyOf };
