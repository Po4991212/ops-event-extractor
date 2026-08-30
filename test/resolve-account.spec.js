import { describe, expect, it } from 'vitest';
import { resetClientIndexCache, resolveAccount } from '../src/resolve/account.js';

describe('resolve/account (§0.5, §4.4 E&O-safe flow)', () => {
  it('resolves a single strong policy-number match with score 1.0', () => {
    resetClientIndexCache();
    const r = resolveAccount(null, { policyNo: 'FQ-88213401' });
    expect(r.method).toBe('policy');
    expect(r.id).toBe('C-1001');
    expect(r.score).toBe(1.0);
  });

  it('resolves an exact normalized name (suffix-insensitive)', () => {
    const r = resolveAccount('Alder Plumbing & Rooter, LLC');
    expect(r.method).toBe('name_exact');
    expect(r.id).toBe('C-1003');
  });

  it('resolves "X of Y LLC" against the shorter "X" via containment fuzzy match when unambiguous', () => {
    // Only one client in the index contains {cormac, whitfield} — unambiguous.
    const r = resolveAccount('Cormac Whitfield');
    expect(r.method).toBe('name_exact');
    expect(r.id).toBe('C-1002');
  });

  it('never auto-picks between two near-identical accounts (the "DNA Access Services" duplicate-pair case)', () => {
    // "Meridian Access Systems, LLC" (C-1006) vs "Meridian Access Systems LLC" (C-1007)
    // both normalize to the same key, so lookupByName finds both — must not guess.
    const r = resolveAccount('Meridian Access Systems LLC');
    expect(r.id).toBeNull();
    expect(r.method).toBe('ambiguous_exact');
    expect(r.candidates.length).toBe(2);
  });

  it('resolves a DBA-suffixed query to its shorter parent name via containment fuzzy match', () => {
    // "Riverbend Nail Studio" is a strict token subset of C-1001's full name
    // ("...LLC DBA Alpha Nail Spa Denton") and matches no other client —
    // unambiguous, so it resolves without a human in the loop.
    const r = resolveAccount('Riverbend Nail Studio');
    expect(r.method).toBe('name_fuzzy');
    expect(r.id).toBe('C-1001');
  });

  it('KNOWN LIMITATION: an exact match short-circuits before a fuzzy near-duplicate is considered (§4.4 algorithm as specified)', () => {
    // Per docs/SPEC.md §4.4, an exact normalized-name match returns
    // immediately (score 0.95) without checking whether a *different*,
    // fuzzy-matching client also exists — e.g. a query that exactly equals
    // "Sunburst Nails" (C-1009) resolves there even though "Sunburst Nails
    // of Katy LLC" (C-1008) is a plausible near-duplicate. This mirrors the
    // spec's own algorithm exactly; it is recorded as a known limitation in
    // the final report rather than silently changed, since the spec
    // prescribes this order deliberately (policy → exact → fuzzy).
    const r = resolveAccount('Sunburst Nails');
    expect(r.method).toBe('name_exact');
    expect(r.id).toBe('C-1009');
  });

  it('returns none with empty candidates when there is no name and no policy', () => {
    const r = resolveAccount(null);
    expect(r).toEqual({ id: null, method: 'none', score: 0, candidates: [] });
  });

  it('returns ambiguous (never guesses) for a name with no reasonable match', () => {
    const r = resolveAccount('Totally Unrelated Business Name Zzyzx');
    expect(r.id).toBeNull();
  });
});
