'use strict';
const { derivedId, sha256 } = require('../core/hash');

/**
 * Obligation identity, kept separate from source deduplication.
 *
 * Three forwards of one renewal notice are three sources of one obligation.
 * Two promises made on the same call to the same account on the same day are
 * two obligations that happen to share an account, a kind and a date. A key
 * built from account + policy + kind + due date cannot tell those apart, so the
 * obligation's subject and object are part of the key.
 */
const STOPWORDS = new Set(['the', 'and', 'for', 'will', 'with', 'from', 'this', 'that', 'have', 'has', 'been',
  'please', 'your', 'our', 'you', 'we', 'policy', 'account', 'insured', 'before', 'until', 'still', 'need', 'needs']);

function contentTokens(s) {
  return new Set(String(s || '').toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t)));
}

function overlap(a, b) {
  const A = contentTokens(a); const B = contentTokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / Math.min(A.size, B.size);
}

function normalizeSubject(text) {
  return [...contentTokens(text)].sort().join(' ');
}

/**
 * An event with no resolved account is never merged with anything: identity
 * falls back to the message it came from, so two unidentified obligations stay
 * two obligations until a human says otherwise.
 */
function identityKey(event, { accountId, policyRef, termRef, messageId }) {
  if (!accountId) return derivedId('obl', 'unresolved', messageId, event.kind, normalizeSubject(event.obligation), event.object_key || '');
  return derivedId('obl', accountId, policyRef || '', termRef || '', event.kind,
    normalizeSubject(event.obligation), event.object_key || '');
}

/** Object keys of the same shape have to match; differently shaped ones do not veto. */
function objectCompatible(a, b) {
  if (!a || !b) return true;
  const [ta] = String(a).split(':');
  const [tb] = String(b).split(':');
  if (ta !== tb) return true;
  return String(a).toLowerCase() === String(b).toLowerCase() || overlap(a, b) >= 0.6;
}

const LINK_THRESHOLD = 0.4;

/**
 * Candidate matching for a related message in another thread.
 * Subject equality is not used here at all - only account, policy, kind and
 * corroborating content. Ambiguity returns every candidate for review rather
 * than picking the best one.
 */
function findLinkCandidates(db, event, { accountId, policyRef }) {
  if (!accountId) return { candidates: [], ambiguous: false };
  const rows = db.prepare(`SELECT o.*, ev.payload_json FROM obligations o
    LEFT JOIN event_versions ev ON ev.id = o.current_version_id
    WHERE o.account_id = ? AND o.kind = ? AND o.status = 'active'`).all(accountId, event.kind);

  const scored = rows
    .filter((r) => (!policyRef || !r.policy_ref || r.policy_ref === policyRef))
    .map((r) => {
      const prev = r.payload_json ? JSON.parse(r.payload_json) : {};
      const sim = Math.max(
        overlap(event.obligation, r.obligation_subject),
        overlap(`${event.obligation} ${event.object_key || ''}`, `${prev.obligation || ''} ${r.object_key || ''}`),
      );
      // Same policy, same kind, same stated deadline is strong corroboration -
      // it is how three differently-worded forwards of one notice find each
      // other. It is never enough on its own: object compatibility still has a
      // veto, which is what keeps two same-day commitments apart.
      const strong = Boolean(policyRef && event.stated_deadline
        && r.policy_ref === policyRef && prev.stated_deadline === event.stated_deadline);
      return {
        obligation: r,
        similarity: Number(sim.toFixed(3)),
        strong,
        compatible: objectCompatible(event.object_key, r.object_key),
      };
    })
    .filter((c) => c.compatible && (c.strong || c.similarity >= LINK_THRESHOLD))
    .sort((a, b) => b.similarity - a.similarity);

  const top = scored.filter((c) => c.strong || c.similarity >= LINK_THRESHOLD);
  const ambiguous = top.length > 1 && Math.abs(top[0].similarity - top[1].similarity) < 0.15;
  return { candidates: top, ambiguous };
}

/** Distinguishes "same notice again" from "the facts changed". */
/**
 * What counts as a revision.
 *
 * Only material facts. Two sources describing the same obligation in different
 * words - a carrier's notice and a colleague's forward of it - are not a
 * correction of each other, and treating them as one produced a new version on
 * every pass, with the summary flip-flopping between phrasings forever. The
 * obligation text is a human-readable label; the date, the amount, the object
 * and the kind are the facts the version history exists to protect.
 */
const MATERIAL_FIELDS = ['stated_deadline', 'amount', 'currency', 'object_key', 'kind', 'responsible'];

function revisionReason(prevPayload, nextEvent) {
  const diffs = [];
  for (const k of MATERIAL_FIELDS) {
    if (JSON.stringify(prevPayload[k]) !== JSON.stringify(nextEvent[k])) diffs.push(k);
  }
  return diffs;
}

module.exports = { identityKey, findLinkCandidates, normalizeSubject, overlap, revisionReason, contentTokens, MATERIAL_FIELDS, LINK_THRESHOLD };
