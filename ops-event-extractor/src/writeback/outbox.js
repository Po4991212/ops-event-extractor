'use strict';
const { derivedId } = require('../core/hash');
const { audit, tx } = require('../db/db');
const { writeMode, assertExternalWrite } = require('./guard');

/**
 * Durable intent log for anything that would change an external system.
 *
 * Enqueue and dispatch are separate. The payload is written in the same
 * transaction as the state that justifies it, so a crash between deciding and
 * sending leaves a record of the decision rather than a silent gap. The
 * idempotency key is derived from content, so a retry after an unknown outcome
 * cannot create a second note.
 */
function enqueue(db, clock, { kind, target, payload, taskId = null, dedupe, contactProvenance = null }) {
  const key = derivedId('idem', kind, target, dedupe || JSON.stringify(payload));
  const id = derivedId('obx', key);
  const existing = db.prepare('SELECT * FROM outbox WHERE idempotency_key = ?').get(key);
  if (existing) return { ...existing, deduplicated: true };
  // contact_provenance records how the destination was chosen. A note attached
  // to a policy the obligation already names has a traceable target; anything
  // that would require picking a contact is out of scope and never enqueued.
  db.prepare(`INSERT INTO outbox (id, task_id, kind, payload_json, idempotency_key, contact_provenance, status, attempts, created_at)
    VALUES (?,?,?,?,?,?,'pending',0,?)`)
    .run(id, taskId, kind, JSON.stringify({ target, ...payload }), key,
      contactProvenance || `entity named by the obligation: ${target}`, clock.nowISO());
  audit(db, { at: clock.nowISO(), actor: 'outbox', action: 'enqueued', subjectType: 'outbox', subjectId: id,
    detail: { kind, target, taskId } });
  return db.prepare('SELECT * FROM outbox WHERE id = ?').get(id);
}

/**
 * Attempts pending entries. A network failure with no response is recorded as
 * "unknown", never as "failed": the request may well have landed, and the only
 * safe next step is a readback, not a blind retry.
 */
async function dispatch(db, cfg, clock, { live = false, dispatcher, limit = 50 } = {}) {
  const mode = writeMode(cfg, { live });
  // dry_run is not a terminal state - it means "built, withheld". When both
  // switches are later set, those same payloads are the ones that go.
  const rows = db.prepare(`SELECT * FROM outbox WHERE status IN ('pending','unknown','dry_run')
    ORDER BY created_at LIMIT ?`).all(limit);
  const out = { mode, dryRun: [], sent: [], unknown: [], failed: [] };

  for (const row of rows) {
    if (!mode.live) {
      const body = JSON.parse(row.payload_json);
      out.dryRun.push({ id: row.id, kind: row.kind, target: body.target, payload: body });
      db.prepare("UPDATE outbox SET status = 'dry_run' WHERE id = ?").run(row.id);
      audit(db, { at: clock.nowISO(), actor: 'outbox', action: 'dry_run', subjectType: 'outbox', subjectId: row.id,
        detail: { reason: mode.reason } });
      continue;
    }
    assertExternalWrite(db, cfg, clock, { live, operation: row.kind, target: row.id });
    db.prepare('UPDATE outbox SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    try {
      const res = await dispatcher(row);
      tx(db, () => {
        db.prepare("UPDATE outbox SET status = 'sent', last_status_code = 200, dispatched_at = ? WHERE id = ?")
          .run(clock.nowISO(), row.id);
      });
      out.sent.push({ id: row.id, res });
    } catch (e) {
      const unknown = e && e.code === 'UNKNOWN_OUTCOME';
      db.prepare('UPDATE outbox SET status = ?, last_error = ?, last_status_code = ? WHERE id = ?')
        .run(unknown ? 'unknown' : 'failed', String(e.message).slice(0, 400), e.details && e.details.status ? e.details.status : null, row.id);
      audit(db, { at: clock.nowISO(), actor: 'outbox', action: unknown ? 'unknown_outcome' : 'dispatch_failed',
        subjectType: 'outbox', subjectId: row.id, detail: { error: String(e.message).slice(0, 200) } });
      (unknown ? out.unknown : out.failed).push({ id: row.id, error: String(e.message) });
    }
  }
  return out;
}

/** Resolves unknown-outcome entries by reading the target system back. */
function reconcile(db, clock, { id, found }) {
  db.prepare('UPDATE outbox SET status = ?, dispatched_at = ? WHERE id = ?')
    .run(found ? 'sent' : 'pending', found ? clock.nowISO() : null, id);
  audit(db, { at: clock.nowISO(), actor: 'outbox', action: 'reconciled', subjectType: 'outbox', subjectId: id,
    detail: { found } });
}

module.exports = { enqueue, dispatch, reconcile };
