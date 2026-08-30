import { describe, expect, it } from 'vitest';
import { normalizedIncludes, routeStatus, score } from '../src/score/confidence.js';

const baseCtx = { today: '2026-08-01', resolution: { method: 'policy' }, body: 'Subject line\n\nPolicy Number: FQ-123456 expires on August 15, 2026.' };

describe('score/confidence (§0.4, §5.4 — computed, not self-reported)', () => {
  it('grounding gate discards an event whose raw_span does not appear verbatim in the source (hallucination detector)', () => {
    const ev = { due_date: '2026-08-15', due_date_basis: 'stated', policy_no: 'FQ-123456', raw_span: 'This sentence was never in the email', extractor: 'llm', model_confidence: 0.99 };
    const result = score(ev, baseCtx);
    expect(result.gate).toBe('hallucinated_span');
    expect(result.total).toBe(0);
    expect(routeStatus(result)).toBe('discarded');
  });

  it('grounding passes when the complete raw_span appears verbatim (after whitespace/NFKC normalization)', () => {
    const ev = { due_date: '2026-08-15', due_date_basis: 'stated', policy_no: 'FQ-123456', raw_span: 'expires on August 15, 2026', extractor: 'parser', model_confidence: null };
    const result = score(ev, baseCtx);
    expect(result.gate).toBeNull();
    expect(result.parts.grounding).toBe(1);
  });

  it('does not pass on a partial-prefix match — the complete span must be present, not just its opening (§5.4)', () => {
    const ev = { due_date: '2026-08-15', due_date_basis: 'stated', policy_no: 'FQ-123456', raw_span: 'expires on August 15, 2026 and also grants a unicorn', extractor: 'llm', model_confidence: 0.9 };
    const result = score(ev, baseCtx);
    expect(result.gate).toBe('hallucinated_span');
  });

  it('unparseable-date gate discards a non-"absent" date that fails to parse', () => {
    const ev = { due_date: 'not-a-date', due_date_basis: 'stated', policy_no: 'FQ-123456', raw_span: 'expires on August 15, 2026', extractor: 'parser' };
    const result = score(ev, baseCtx);
    expect(result.gate).toBe('unparseable_date');
  });

  it('routes a high-confidence parser event to auto', () => {
    const ev = { due_date: '2026-08-15', due_date_basis: 'stated', policy_no: 'FQ-123456', raw_span: 'expires on August 15, 2026', extractor: 'parser' };
    const result = score(ev, baseCtx);
    expect(routeStatus(result)).toBe('auto');
  });

  it('routes an unresolved-account event to review, not auto, even with a stated date (§0.5 never guess an account)', () => {
    const ev = { due_date: '2026-08-15', due_date_basis: 'stated', policy_no: null, raw_span: 'expires on August 15, 2026', extractor: 'parser' };
    const result = score(ev, { ...baseCtx, resolution: { method: 'none' } });
    expect(routeStatus(result)).toBe('queued');
  });

  it('normalizedIncludes ignores whitespace and NFKC differences', () => {
    expect(normalizedIncludes('Hello   world\ntest', 'Hello world test')).toBe(true);
    expect(normalizedIncludes('Hello world', 'Goodbye world')).toBe(false);
  });
});
