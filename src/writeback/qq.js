import { config } from '../config.js';
import { createContactNote } from '../resolve/qqClient.js';

// ADR 0001 found no existing QQ client to reuse and no verified write
// contract; ADR 0001's 2026-08-29 addendum closed that second gap — the
// user's own QQ Catalyst API-developer console confirmed PUT
// v1/Contacts/Notes's full request/response schema (NoteDTO /
// ActionResultDTOOfNoteDTO), including a sample request/response. This
// module still defaults to dry-run (§0.1/§6.3): live writes require BOTH
// --live and QQ_LIVE_WRITES_APPROVED=true (the two-key pattern from ADR
// 0004), and additionally refuse per-task if the account hasn't been
// resolved to a real numeric QQ contact id (see accountIdAsInteger below)
// — sending a note to the wrong or a fabricated contact id is exactly the
// kind of silent-wrong-account mistake §0.5 exists to prevent.

/** NoteDTO shape per api.qqcatalyst.com/Help/Api/PUT-v1-Contacts-Notes. */
export function buildNotePayload(task) {
  const lines = [`[Ops Event Extractor] ${task.kind}: ${task.obligation ?? task.title}`];
  if (task.due_date) lines.push(`Due: ${task.due_date}`);
  if (task.policy_no) lines.push(`Policy: ${task.policy_no}`);
  lines.push(`(source event: ${task.event_key})`);
  return {
    AssignedContactId: accountIdAsInteger(task.account_id),
    Comment: lines.join(' — '),
    Important: task.kind === 'lapse_warning' || task.kind === 'cancellation_notice'
  };
}

/** A real QQ contact id is a positive integer (their EntityID); the synthetic index's "C-1001"-style ids are not. */
function accountIdAsInteger(accountId) {
  const n = Number(accountId);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function dryRunLog(payload) {
  // Every write path logs the payload it would have sent (§0.1).
  // eslint-disable-next-line no-console
  console.log(`[qq:dry-run] would create note: ${JSON.stringify(payload)}`);
  return { ok: true, dryRun: true, payload };
}

/**
 * §6.3: dry-run by default. Live writes require BOTH --live (via `live`
 * here) and QQ_LIVE_WRITES_APPROVED=true, AND a real numeric account id —
 * any one missing falls back to a logged dry-run rather than guessing or
 * silently no-op'ing.
 */
export async function pushTask(task, { live = false } = {}) {
  const payload = buildNotePayload(task);
  if (!live) return dryRunLog(payload);
  if (!config.qq.liveWritesApproved || !config.qq.apiClientId || !config.qq.apiClientSecret) {
    return dryRunLog({ ...payload, blockedReason: 'QQ_LIVE_WRITES_APPROVED is not true or QQ_API_CLIENT_ID/SECRET are unset' });
  }
  if (payload.AssignedContactId == null) {
    return dryRunLog({ ...payload, blockedReason: `account_id "${task.account_id}" is not a real QQ contact id (likely still the synthetic index — run refresh-client-index against the live API first)` });
  }
  const result = await createContactNote(payload);
  return { ok: !!result?.IsSuccess, dryRun: false, qqNoteId: result?.Result?.Id ?? null, response: result };
}
