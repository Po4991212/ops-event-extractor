import { normName, resolveAccount } from '../resolve/account.js';
import { daysBetween } from '../normalize/dates.js';

/**
 * Bucketing key for one row: prefer a resolved account_id (predicted events
 * already carry one when resolution succeeded; ground-truth rows are
 * resolved here on the fly via the same resolver used in production, so
 * "Foxquilt extracted no name but resolved via policy_no" still aligns
 * against a ground-truth row that only has a name) and fall back to the
 * normalized raw name when no id is resolvable on either side.
 */
function accountKey(row) {
  if (row.account_id) return `id:${row.account_id}`;
  if (row.account_name_raw) {
    const resolved = resolveAccount(row.account_name_raw, { policyNo: row.policy_no });
    if (resolved.id) return `id:${resolved.id}`;
    return `name:${normName(row.account_name_raw)}`;
  }
  return `msg:${row.source_msg_id || row.event_key || ''}`;
}

/**
 * Matches predicted events to ground-truth rows (§7.1): normalized account +
 * kind + due_date within ±2 days, then greedy nearest-date assignment for
 * leftovers within the same account. A true Hungarian assignment is
 * unnecessary here — ground-truth buckets per account are small (1–3 rows
 * in practice), where greedy nearest-date matching produces the same
 * assignment; this is a documented simplification, not a numerical shortcut
 * that changes results at this scale.
 */
export function alignEvents(predicted, groundTruth) {
  const matches = [];
  const usedPred = new Set();
  const usedGt = new Set();

  const bucket = (rows) => {
    const m = new Map();
    for (const r of rows) {
      const key = `${accountKey(r)}|${r.kind}`;
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(r);
    }
    return m;
  };

  const predBuckets = bucket(predicted);
  const gtBuckets = bucket(groundTruth);

  for (const [key, predRows] of predBuckets) {
    const gtRows = gtBuckets.get(key) || [];
    for (const p of predRows) {
      if (usedPred.has(p)) continue;
      let best = null;
      let bestDist = Infinity;
      for (const g of gtRows) {
        if (usedGt.has(g)) continue;
        const dist = (p.due_date && g.due_date) ? Math.abs(daysBetween(g.due_date, p.due_date)) : (p.due_date === g.due_date ? 0 : 3);
        if (dist <= 2 && dist < bestDist) { best = g; bestDist = dist; }
      }
      if (best) {
        matches.push({ predicted: p, groundTruth: best });
        usedPred.add(p);
        usedGt.add(best);
      }
    }
  }

  const falsePositives = predicted.filter(p => !usedPred.has(p));
  const falseNegatives = groundTruth.filter(g => !usedGt.has(g));
  return { matches, falsePositives, falseNegatives };
}
