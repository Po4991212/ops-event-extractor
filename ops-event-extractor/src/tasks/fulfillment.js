'use strict';
const { derivedId } = require('../core/hash');
const { audit } = require('../db/db');
const { setStatus } = require('./tasks');

/**
 * Pairs obligations with fulfillment evidence from the agency management
 * system.
 *
 * The whole point is the gap between saying and doing. "We will remove the
 * vehicle" is a promise. A bind confirmation is a conversation. Neither is an
 * endorsement document. A task closes when the AMS shows the thing actually
 * happened, for the right account, the right term, the right object and the
 * right amount - or it does not close.
 */
const EVIDENCE_FOR_KIND = {
  payment_due: ['payment_receipt'],
  coi_request: ['certificate'],
  client_commitment: ['endorsement_doc', 'certificate', 'activity_note'],
  endorsement_request: ['endorsement_doc'],
  condition_precedent: ['activity_note', 'endorsement_doc'],
  signature_required: ['activity_note', 'endorsement_doc'],
  audit_request: ['activity_note'],
};

function longTokens(s) {
  return new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 6));
}

function objectMatches(taskKey, activityKey) {
  if (!taskKey) return { ok: false, why: 'obligation has no object to match' };
  if (!activityKey) return { ok: false, why: 'activity has no object to match' };
  const [ta, va] = [String(taskKey).split(':')[0], String(taskKey).split(':').slice(1).join(':')];
  const [tb, vb] = [String(activityKey).split(':')[0], String(activityKey).split(':').slice(1).join(':')];
  if (ta !== tb) return { ok: false, why: `object types differ (${ta} vs ${tb})` };
  if (va.toLowerCase() === vb.toLowerCase()) return { ok: true, why: 'exact object match' };
  const A = longTokens(va); const B = longTokens(vb);
  for (const t of A) if (B.has(t)) return { ok: true, why: `shared identifier "${t}"` };
  return { ok: false, why: 'no shared identifier between objects' };
}

function termMatches(db, policyRef, activity) {
  if (!policyRef) return { ok: true, why: 'no policy term to compare' };
  const pol = db.prepare('SELECT term_start, term_end FROM qq_policies WHERE policy_number = ? LIMIT 1').get(policyRef);
  if (!pol || !activity.term_start) return { ok: true, why: 'term not available on both sides' };
  const ok = pol.term_start === activity.term_start && pol.term_end === activity.term_end;
  return { ok, why: ok ? 'policy term matches' : `activity term ${activity.term_start}..${activity.term_end} is not the obligation's term` };
}

function check(db, cfg, clock, { autoClose = true } = {}) {
  const out = { closed: [], candidates: [], reopened: [], rejected: [] };
  const tasks = db.prepare(`SELECT t.*, o.account_id, o.policy_ref, o.object_key, o.obligation_subject, o.current_version_id
    FROM tasks t JOIN obligations o ON o.id = t.obligation_id
    WHERE t.status IN ('open','awaiting_response','escalated','pending_fulfillment_review','completed')`).all();

  for (const t of tasks) {
    if (!t.account_id) continue;
    const version = t.current_version_id
      ? db.prepare('SELECT payload_json FROM event_versions WHERE id = ?').get(t.current_version_id) : null;
    const payload = version ? JSON.parse(version.payload_json) : {};
    const wanted = EVIDENCE_FOR_KIND[t.kind] || [];

    const firstSeen = db.prepare(`SELECT MIN(COALESCE(m.source_ts, m.observed_ts)) f FROM source_links sl
      JOIN messages m ON m.id = sl.message_id WHERE sl.obligation_id = ?`).get(t.obligation_id).f;

    // Only activity that has already happened at the current clock. Without
    // this bound a replay of March would close a task using an endorsement
    // filed in April, and the system would look far better at March than it
    // was.
    const activities = db.prepare(`SELECT * FROM qq_activity WHERE account_id = ? AND occurred_at <= ?
      ORDER BY occurred_at`).all(t.account_id, clock.nowISO());

    for (const a of activities) {
      // Status is re-read each time: a close decided earlier in this same loop
      // must be visible to a reversal that comes after it.
      const live = db.prepare('SELECT status FROM tasks WHERE id = ?').get(t.id).status;

      // Reversals can reopen a task that was closed on the strength of the
      // thing being reversed.
      if (a.type === 'reversal' && live === 'completed') {
        const matched = objectMatches(t.object_key || payload.object_key, a.object_key);
        if (matched.ok) {
          db.prepare("UPDATE tasks SET status = 'open', version = version + 1, updated_at = ? WHERE id = ?")
            .run(clock.nowISO(), t.id);
          recordLink(db, clock, t.id, a, 'reversal', { reason: a.text });
          audit(db, { at: clock.nowISO(), actor: 'fulfillment', action: 'task_reopened_after_reversal',
            subjectType: 'task', subjectId: t.id, detail: { activity: a.id } });
          out.reopened.push({ task: t.id, activity: a.id });
        }
        continue;
      }

      if (!wanted.includes(a.type)) continue;
      // A note this application wrote is not evidence that the work was done.
      if (a.generated_by === 'ops-event-extractor') {
        out.rejected.push({ task: t.id, activity: a.id, why: 'self-generated note cannot validate completion' });
        continue;
      }
      if (firstSeen && a.occurred_at < firstSeen) {
        out.rejected.push({ task: t.id, activity: a.id, why: 'activity predates the obligation' });
        continue;
      }

      const checks = {
        object: objectMatches(t.object_key || payload.object_key, a.object_key),
        term: termMatches(db, t.policy_ref, a),
        amount: payload.amount == null || a.amount == null
          ? { ok: payload.amount == null, why: payload.amount == null ? 'no amount claimed' : 'activity carries no amount' }
          : { ok: Math.abs(Number(a.amount) - Number(payload.amount)) < 0.005,
            why: `activity ${a.amount} vs obligation ${payload.amount}` },
      };
      const complete = checks.object.ok && checks.term.ok && checks.amount.ok;

      if (complete && autoClose && live !== 'completed') {
        const linkId = recordLink(db, clock, t.id, a, 'auto_close', checks);
        setStatus(db, clock, t.id, 'completed', {
          actor: 'fulfillment', reason: 'deterministic full match against AMS evidence', evidenceId: linkId,
        });
        out.closed.push({ task: t.id, activity: a.id, checks });
      } else if (!complete && (checks.object.ok || checks.amount.ok)) {
        const linkId = recordLink(db, clock, t.id, a, 'candidate', checks);
        if (live !== 'completed') {
          db.prepare("UPDATE tasks SET status = 'pending_fulfillment_review', updated_at = ? WHERE id = ?")
            .run(clock.nowISO(), t.id);
        }
        out.candidates.push({ task: t.id, activity: a.id, checks, linkId });
      } else {
        out.rejected.push({ task: t.id, activity: a.id, why: checks.object.why });
      }
    }
  }
  return out;
}

function recordLink(db, clock, taskId, activity, decision, matchDetail) {
  const id = derivedId('ful', taskId, activity.id, decision);
  db.prepare(`INSERT OR REPLACE INTO fulfillment_links
    (id, task_id, evidence_type, qq_activity_id, match_json, decision, created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(id, taskId, activity.type, activity.id, JSON.stringify(matchDetail), decision, clock.nowISO());
  return id;
}

module.exports = { check, objectMatches, termMatches };
