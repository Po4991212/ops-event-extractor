'use strict';
/**
 * Confidence from observable validation results.
 *
 * Account resolution dominates, because filing an obligation against the wrong
 * insured is the most expensive mistake available here. The model's own
 * self-reported confidence carries the least weight of anything in the sum: it
 * is the one input that cannot be checked.
 *
 * These weights and the thresholds in config are starting values to evaluate.
 * They are not calibrated probabilities and nothing here should be read as one.
 */
const WEIGHTS = {
  account: 0.45,
  evidence: 0.25,
  parsing: 0.15,
  extractor: 0.10,
  self_report: 0.05,
};

const ACCOUNT_SCORE = {
  policy_exact: 1.0,
  name_exact: 0.9,
  zip_disambiguated: 0.75,
  none: 0.0,
};

function score(event, { resolution, gateResult, source, message }) {
  const parts = {};
  parts.account = ACCOUNT_SCORE[resolution ? resolution.method : 'none'] ?? 0;
  if (resolution && resolution.requiresReview) parts.account = 0;

  const claimedCount = (event.fields || []).length || 1;
  const grounded = gateResult.evidence.length;
  parts.evidence = Math.min(1, grounded / claimedCount);
  if (gateResult.warnings.some((w) => w.gate === 'evidence_block_index')) parts.evidence *= 0.9;

  const dateOk = event.stated_deadline === null || /^\d{4}-\d{2}-\d{2}$/.test(String(event.stated_deadline));
  const amtOk = event.amount === null || Number.isFinite(Number(event.amount));
  parts.parsing = (dateOk ? 0.5 : 0) + (amtOk ? 0.5 : 0);

  // A learned pattern sits between the two: deterministic like a parser, but
  // induced from model output rather than written and reviewed as code.
  parts.extractor = { parser: 1.0, learned: 0.8 }[source] ?? 0.6;
  parts.self_report = Math.max(0, Math.min(1, Number(event.model_confidence ?? 0)));

  let total = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) total += w * (parts[k] ?? 0);

  const caps = [];
  if (message && message.processing_complete === 0) { caps.push('incomplete processing'); total = Math.min(total, 0.70); }
  if (gateResult.warnings.length) caps.push(...gateResult.warnings.map((w) => w.gate));

  return { score: Number(total.toFixed(4)), parts, caps, weights: WEIGHTS };
}

function band(score, thresholds) {
  if (score >= thresholds.auto) return 'auto';
  if (score >= thresholds.review) return 'review';
  return 'low_review';
}

module.exports = { score, band, WEIGHTS, ACCOUNT_SCORE };
