'use strict';
const { normalizeName, rankScore } = require('./normalize-name');
const { derivedId } = require('../core/hash');

/**
 * Account resolution. The resolution ladder is fixed and short:
 *
 *   1. exact policy identifier
 *   2. exact normalized legal name or approved alias
 *   3. ZIP, and only to disambiguate candidates already eligible from step 2
 *   4. stop and show candidates
 *
 * There is no fuzzy step that can authorize a match. Similarity only orders the
 * candidate list a human sees. Guessing an account is how a notice ends up
 * filed against the wrong insured, which is worse than a review queue entry.
 */
function resolve(db, { policyRefs = [], names = [], zips = [], quotedOnlyNames = [] } = {}) {
  const candidates = [];
  const reasons = [];

  // --- 1. exact policy ---
  for (const ref of policyRefs.filter(Boolean)) {
    const rows = db.prepare(`SELECT p.policy_number, p.account_id, p.carrier, a.legal_name, a.contact_id, a.zip
      FROM qq_policies p JOIN qq_accounts a ON a.account_id = p.account_id
      WHERE p.policy_number = ?`).all(ref);
    for (const r of rows) candidates.push({ ...r, via: 'policy_exact', policy: ref });
  }

  if (candidates.length === 1) {
    const only = candidates[0];
    // A named insured that contradicts the policy's account is a review trigger,
    // not something to resolve by preferring one signal over the other.
    const conflicting = names.filter((n) => n && normalizeName(n) !== normalizeName(only.legal_name));
    if (conflicting.length) {
      const nameMatches = conflicting.filter((n) => lookupByName(db, n).length > 0);
      if (nameMatches.length) {
        return review(db, candidates.concat(nameMatches.flatMap((n) => lookupByName(db, n).map((r) => ({ ...r, via: 'name_exact' })))),
          `policy ${only.policy} resolves to "${only.legal_name}" but the message names "${nameMatches[0]}"`);
      }
    }
    return accept(only, 'policy_exact', `exact policy match on ${only.policy}`);
  }
  if (candidates.length > 1) {
    return review(db, candidates, `policy identifier resolves to ${candidates.length} accounts`);
  }

  // --- 2. exact normalized name (names seen in the reply body only) ---
  let nameCandidates = [];
  for (const n of names.filter(Boolean)) {
    for (const r of lookupByName(db, n)) nameCandidates.push({ ...r, via: 'name_exact', matchedName: n });
  }
  nameCandidates = dedupe(nameCandidates);

  if (nameCandidates.length === 1) {
    return accept(nameCandidates[0], 'name_exact', `exact normalized name match on "${nameCandidates[0].matchedName}"`);
  }

  // --- 3. ZIP disambiguates candidates that were already eligible ---
  if (nameCandidates.length > 1 && zips.length) {
    const narrowed = nameCandidates.filter((c) => zips.includes(c.zip));
    if (narrowed.length === 1) {
      return accept(narrowed[0], 'zip_disambiguated',
        `name matched ${nameCandidates.length} accounts; ZIP ${narrowed[0].zip} identified one`);
    }
  }

  // --- 4. stop ---
  if (nameCandidates.length > 1) {
    return review(db, nameCandidates, `name matches ${nameCandidates.length} accounts and ZIP did not disambiguate`);
  }

  // A name that appears only inside a quoted chain is not the current subject's
  // account by itself. It is offered as a review candidate instead.
  const quoted = dedupe(quotedOnlyNames.flatMap((n) => lookupByName(db, n).map((r) => ({ ...r, via: 'quoted_only', matchedName: n }))));
  if (quoted.length) {
    return review(db, quoted, 'account name appeared only inside a quoted chain');
  }

  return { method: 'none', accountId: null, contactId: null, requiresReview: true,
    candidates: [], reason: reasons.concat('no policy or exact name match').join('; ') };
}

function lookupByName(db, name) {
  const norm = normalizeName(name);
  if (!norm) return [];
  const direct = db.prepare(`SELECT account_id, legal_name, contact_id, zip, aliases_json
    FROM qq_accounts WHERE normalized_name = ?`).all(norm);
  const byAlias = db.prepare('SELECT account_id, legal_name, contact_id, zip, aliases_json FROM qq_accounts').all()
    .filter((r) => JSON.parse(r.aliases_json || '[]').some((a) => normalizeName(a) === norm));
  return dedupe([...direct, ...byAlias]);
}

function dedupe(rows) {
  const seen = new Map();
  for (const r of rows) if (!seen.has(r.account_id)) seen.set(r.account_id, r);
  return [...seen.values()];
}

function accept(row, method, reason) {
  return {
    method,
    accountId: row.account_id,
    contactId: row.contact_id ?? null,
    legalName: row.legal_name,
    requiresReview: false,
    candidates: [row],
    reason,
  };
}

function review(db, candidates, reason) {
  const ranked = dedupe(candidates)
    .map((c) => ({ ...c, rank: rankScore(c.legal_name, c.matchedName || c.legal_name) }))
    .sort((a, b) => b.rank - a.rank);
  return { method: 'none', accountId: null, contactId: null, requiresReview: true, candidates: ranked, reason };
}

/** Persists the resolution with every candidate considered. */
function record(db, clock, messageId, resolution) {
  const id = derivedId('ares', messageId);
  db.prepare(`INSERT OR REPLACE INTO account_resolutions
    (id, message_id, method, chosen_account_id, chosen_contact_id, candidates_json, requires_review, reason, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    id, messageId, resolution.method, resolution.accountId, resolution.contactId,
    JSON.stringify(resolution.candidates), resolution.requiresReview ? 1 : 0, resolution.reason, clock.nowISO(),
  );
  return id;
}

module.exports = { resolve, record, lookupByName };
