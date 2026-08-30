import { alignEvents } from './align.js';

function prf(tp, fp, fn) {
  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  const f1 = precision && recall && (precision + recall) > 0 ? (2 * precision * recall) / (precision + recall) : null;
  return { precision, recall, f1, tp, fp, fn };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/** §7.2 metrics table, computed from a set of events + the routing/llm_calls rows produced alongside them. */
export function scoreRun({ predicted, groundTruth, allEvents, llmCalls }) {
  const { matches, falsePositives, falseNegatives } = alignEvents(predicted, groundTruth);
  const headline = prf(matches.length, falsePositives.length, falseNegatives.length);

  const fieldMatch = (field) => {
    const withField = matches.filter(m => m.groundTruth[field] != null || m.predicted[field] != null);
    if (withField.length === 0) return null;
    const correct = withField.filter(m => (m.groundTruth[field] ?? null) === (m.predicted[field] ?? null)).length;
    return correct / withField.length;
  };
  const perField = { account_name_raw: fieldMatch('account_name_raw'), kind: fieldMatch('kind'), due_date: fieldMatch('due_date') };

  const byExtractor = {};
  for (const ev of allEvents) {
    byExtractor[ev.extractor] ??= { total: 0 };
    byExtractor[ev.extractor].total += 1;
  }

  const byDomain = {};
  for (const ev of allEvents) {
    const domain = ev.from_domain || 'unknown';
    byDomain[domain] ??= { total: 0 };
    byDomain[domain].total += 1;
  }

  const total = allEvents.length;
  const autoEvents = allEvents.filter(e => e.status === 'auto');
  const queuedEvents = allEvents.filter(e => e.status === 'queued');
  const reviewQueueRate = total === 0 ? null : queuedEvents.length / total;

  const autoMatched = matches.filter(m => allEvents.find(e => e.event_key === m.predicted.event_key)?.status === 'auto');
  const autoBandPrecision = autoEvents.length === 0 ? null : autoMatched.length / autoEvents.length;

  const costCents = (llmCalls || []).reduce((s, r) => s + (r.cost_cents || 0), 0);
  const costPer1000 = total === 0 ? null : (costCents / total) * 1000;
  const naiveCostPer1000 = (() => {
    // naive baseline: every message sent straight to the extraction-tier model, no routing.
    const sonnetCall = (llmCalls || []).find(r => r.purpose === 'extract');
    if (!sonnetCall || !sonnetCall.input_tokens) return null;
    const avgInTok = sonnetCall.input_tokens;
    const avgOutTok = sonnetCall.output_tokens || 200;
    const sonnetPrice = { in: 2, out: 10 };
    return ((avgInTok / 1e6) * sonnetPrice.in + (avgOutTok / 1e6) * sonnetPrice.out) * 100 * 1000;
  })();

  const latencies = (llmCalls || []).map(r => r.latency_ms).filter(n => n != null).sort((a, b) => a - b);

  return {
    headline,
    perField,
    byExtractor,
    byDomain,
    reviewQueueRate,
    autoBandPrecision,
    autoCount: autoEvents.length,
    queuedCount: queuedEvents.length,
    costCentsPer1000: costPer1000,
    naiveCostCentsPer1000: naiveCostPer1000,
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    falsePositives: falsePositives.length,
    falseNegatives: falseNegatives.length
  };
}
