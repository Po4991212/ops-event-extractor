import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const SUFFIX_WORDS = new Set(['llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'llp', 'ltd', 'lp']);

let _index = null;
let _loggedSource = false;

const SYNTHETIC_INDEX_PATH = path.join(config.root, 'src', 'resolve', 'index.json');

/**
 * Loads and caches the local client index (§4.4: "don't hit QQ per-message").
 * Prefers a real index at QQ_CLIENT_INDEX_PATH (built by
 * resolve/importClientIndex.js from the live QQ API or a CSV export —
 * always gitignored, see ADR 0006/0007) and falls back to the committed
 * synthetic index otherwise. Which one is active is logged once, loudly —
 * silently resolving real client names against fake data (or vice versa)
 * is exactly the kind of mistake this function exists to prevent.
 */
export function loadClientIndex(indexPath) {
  if (_index) return _index;
  const resolvedPath = indexPath
    || (config.qq.clientIndexPath && fs.existsSync(config.qq.clientIndexPath) ? config.qq.clientIndexPath : SYNTHETIC_INDEX_PATH);

  if (!_loggedSource) {
    _loggedSource = true;
    const label = resolvedPath === SYNTHETIC_INDEX_PATH ? 'SYNTHETIC (demo/test data)' : `REAL (${resolvedPath})`;
    // eslint-disable-next-line no-console
    console.error(`[resolve] client index source: ${label}`);
  }

  const raw = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  _index = raw.clients.map(c => ({ ...c, _normName: normName(c.name), _tokens: tokenSet(c.name) }));
  return _index;
}

export function resetClientIndexCache() { _index = null; }

/** lowercase, strip punctuation, drop entity-suffix words, collapse whitespace. */
export function normName(nameRaw) {
  return (nameRaw || '')
    .toLowerCase()
    .replace(/[.,]/g, '')
    .split(/\s+/)
    .filter(w => w && !SUFFIX_WORDS.has(w))
    .join(' ')
    .trim();
}

function tokenSet(nameRaw) {
  return new Set(normName(nameRaw).split(' ').filter(Boolean));
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function isContainment(a, b) {
  if (a.size === 0 || b.size === 0) return false;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (!big.has(t)) return false;
  return true;
}

/** Fuzzy-scores a raw name against every cached client; never picks, only ranks. */
export function fuzzyName(nameRaw, { limit = 5, minScore = 0.82 } = {}) {
  const index = loadClientIndex();
  const queryTokens = tokenSet(nameRaw);
  const results = index.map(c => {
    const containment = isContainment(queryTokens, c._tokens);
    // Containment (one name's tokens are a strict subset of the other's —
    // a shorter query matching a fuller DBA-qualified name, §4.4) scores
    // high enough to clear the auto-fuzzy threshold below on its own;
    // plain token overlap (Jaccard) does not. See
    // test/resolve-account.spec.js for a concrete synthetic example.
    const score = containment ? Math.max(0.96, jaccard(queryTokens, c._tokens)) : jaccard(queryTokens, c._tokens);
    return { id: c.id, name: c.name, score };
  });
  return results
    .filter(r => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function lookupByName(nameRaw) {
  const index = loadClientIndex();
  const key = normName(nameRaw);
  return index.filter(c => c._normName === key).map(c => ({ id: c.id, name: c.name }));
}

export function normalizePolicy(policyNo) {
  return (policyNo || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function lookupByPolicy(policyNo) {
  const index = loadClientIndex();
  const key = normalizePolicy(policyNo);
  if (!key) return [];
  return index
    .filter(c => (c.policies || []).some(p => normalizePolicy(p) === key))
    .map(c => ({ id: c.id, name: c.name }));
}

/**
 * E&O-safe resolution flow (§0.5, §4.4): policy number → single exact-name
 * match → single high-confidence fuzzy match → ambiguous (never auto-pick).
 * `zip` is an optional tertiary disambiguator when multiple fuzzy
 * candidates tie and the source provides one (rare for email; most callers
 * omit it).
 */
export function resolveAccount(nameRaw, { policyNo = null, zip = null } = {}) {
  if (policyNo) {
    const byPolicy = lookupByPolicy(policyNo);
    if (byPolicy.length === 1) return { id: byPolicy[0].id, method: 'policy', score: 1.0, candidates: [] };
  }
  if (!nameRaw) return { id: null, method: 'none', score: 0, candidates: [] };

  const exact = lookupByName(nameRaw);
  if (exact.length === 1) return { id: exact[0].id, method: 'name_exact', score: 0.95, candidates: [] };

  let fuzzy = fuzzyName(nameRaw, { limit: 5, minScore: 0.82 });
  if (fuzzy.length > 1 && zip) {
    const index = loadClientIndex();
    const zipFiltered = fuzzy.filter(f => index.find(c => c.id === f.id)?.zip === zip);
    if (zipFiltered.length === 1) return { id: zipFiltered[0].id, method: 'name_fuzzy_zip', score: zipFiltered[0].score, candidates: [] };
    if (zipFiltered.length > 1) fuzzy = zipFiltered;
  }
  if (fuzzy.length === 1 && fuzzy[0].score > 0.93) {
    return { id: fuzzy[0].id, method: 'name_fuzzy', score: fuzzy[0].score, candidates: [] };
  }

  return { id: null, method: exact.length > 1 ? 'ambiguous_exact' : 'ambiguous', score: 0, candidates: exact.length > 1 ? exact : fuzzy };
}
