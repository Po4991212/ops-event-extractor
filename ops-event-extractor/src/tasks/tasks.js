'use strict';
const { derivedId } = require('../core/hash');
const { audit } = require('../db/db');
const { computeTimes } = require('./scheduler');

/**
 * Task lifecycle. A task is never deleted by reprocessing: it is superseded or
 * cancelled by a recorded human decision, and completion requires linked
 * evidence.
 */
const OPEN_STATES = ['open', 'awaiting_response', 'escalated', 'pending_fulfillment_review'];

function upsertTask(db, cfg, clock, { obligationId, kind, event, receiptISO, owner = null, urgent, reviewOnly = false }) {
  const id = derivedId('task', obligationId);
  const times = computeTimes(kind, { dueDateISO: event.stated_deadline, receiptISO }, cfg);
  const now = clock.nowISO();
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);

  if (!existing) {
    db.prepare(`INSERT INTO tasks (id, obligation_id, kind, status, owner, due_date, first_action_at,
        escalation_at, critical_at, missing_sla, needs_date_review, urgent, urgent_reason, version, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).run(
      id, obligationId, kind, reviewOnly ? 'pending_fulfillment_review' : 'open', owner,
      event.stated_deadline, times.firstActionAt, times.escalationAt, times.criticalAt,
      times.missingSla ? 1 : 0, times.needsDateReview ? 1 : 0, urgent.urgent ? 1 : 0, urgent.reason, now, now,
    );
    audit(db, { at: now, actor: 'scheduler', action: 'task_created', subjectType: 'task', subjectId: id,
      detail: { kind, times, urgent: urgent.urgent, missingSla: times.missingSla } });
    return { id, created: true, times };
  }

  // The receipt clock is not restarted by a forward; only the deadline-derived
  // times move when a revised due date arrives.
  const changed = existing.due_date !== event.stated_deadline;
  if (changed) {
    db.prepare(`UPDATE tasks SET due_date = ?, first_action_at = ?, escalation_at = ?, critical_at = ?,
        needs_date_review = ?, version = version + 1, updated_at = ? WHERE id = ?`).run(
      event.stated_deadline, times.firstActionAt, times.escalationAt, times.criticalAt,
      times.needsDateReview ? 1 : 0, now, id,
    );
    audit(db, { at: now, actor: 'scheduler', action: 'task_dates_revised', subjectType: 'task', subjectId: id,
      detail: { from: existing.due_date, to: event.stated_deadline } });
  }
  if (urgent.urgent && !existing.urgent) markUrgent(db, clock, id, urgent.reason);
  return { id, created: false, times, changed };
}

function markUrgent(db, clock, taskId, reason) {
  db.prepare('UPDATE tasks SET urgent = 1, urgent_reason = ?, updated_at = ? WHERE id = ?')
    .run(reason, clock.nowISO(), taskId);
  audit(db, { at: clock.nowISO(), actor: 'rules', action: 'task_marked_urgent', subjectType: 'task',
    subjectId: taskId, detail: { reason } });
}

function setStatus(db, clock, taskId, status, { actor, reason, evidenceId = null }) {
  if (status === 'completed' && !evidenceId) {
    throw new Error('completion requires linked fulfillment evidence');
  }
  db.prepare('UPDATE tasks SET status = ?, version = version + 1, updated_at = ? WHERE id = ?')
    .run(status, clock.nowISO(), taskId);
  audit(db, { at: clock.nowISO(), actor, action: `task_${status}`, subjectType: 'task', subjectId: taskId,
    detail: { reason, evidenceId } });
}

function openTasks(db) {
  return db.prepare(`SELECT t.*, o.account_id, o.policy_ref, o.obligation_subject, o.object_key
    FROM tasks t JOIN obligations o ON o.id = t.obligation_id
    WHERE t.status IN (${OPEN_STATES.map(() => '?').join(',')})
    ORDER BY t.urgent DESC, COALESCE(t.critical_at, t.first_action_at)`).all(...OPEN_STATES);
}

module.exports = { upsertTask, setStatus, markUrgent, openTasks, OPEN_STATES };
