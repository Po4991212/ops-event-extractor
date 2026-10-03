'use strict';
const { DateTime } = require('luxon');
const { derivedId } = require('../core/hash');
const { audit } = require('../db/db');
const { addBusinessDays } = require('./scheduler');
const { contentTokens } = require('../events/identity');

/**
 * Scheduled sweep over timers and silence.
 *
 * The case this exists for: the agency asked a question and nothing came back.
 * No new email arrives, so an inbox-triggered system never notices. The sweep
 * runs on the clock instead, and persists one row per (task, level), so a
 * restart, a repeated run, or a clock that jumps cannot produce the same
 * reminder twice.
 */
const SILENCE_LEVELS = [
  { level: 'silence_1', businessDays: 3 },
  { level: 'silence_2', businessDays: 7 },
  { level: 'silence_3', businessDays: 14 },
];

const AWAITING_KINDS = new Set(['uw_question', 'client_commitment', 'condition_precedent', 'signature_required']);

function alreadyFired(db, taskId, level) {
  return Boolean(db.prepare('SELECT 1 FROM task_escalations WHERE task_id = ? AND level = ?').get(taskId, level));
}

function fire(db, clock, taskId, level, sweepId, detail) {
  try {
    db.prepare('INSERT INTO task_escalations (id, task_id, level, fired_at, sweep_id) VALUES (?,?,?,?,?)')
      .run(derivedId('esc', taskId, level), taskId, level, clock.nowISO(), sweepId);
  } catch (e) {
    if (/UNIQUE/.test(String(e.message))) return false; // another run got there first
    throw e;
  }
  audit(db, { at: clock.nowISO(), actor: 'sweep', action: 'escalation_fired', subjectType: 'task',
    subjectId: taskId, detail: { level, ...detail } });
  return true;
}

/** Did anything in the thread actually answer the question that was asked? */
function answeringReply(db, task) {
  const src = db.prepare(`SELECT m.* FROM source_links sl JOIN messages m ON m.id = sl.message_id
    WHERE sl.obligation_id = ? ORDER BY COALESCE(m.source_ts, m.observed_ts) LIMIT 1`).get(task.obligation_id);
  if (!src) return null;

  const replies = db.prepare(`SELECT * FROM messages
    WHERE mailbox_id = ? AND gmail_thread_id = ? AND direction = 'inbound'
      AND COALESCE(source_ts, observed_ts) > COALESCE(?, ?)`)
    .all(src.mailbox_id, src.gmail_thread_id, src.source_ts, src.observed_ts);

  const asked = contentTokens(`${task.obligation_subject} ${task.object_key || ''}`);
  for (const r of replies) {
    const blocks = db.prepare("SELECT canonical_text FROM message_blocks WHERE message_id = ? AND kind IN ('reply','table')").all(r.id);
    const said = contentTokens(blocks.map((b) => b.canonical_text).join(' '));
    let hit = 0;
    for (const t of asked) if (said.has(t)) hit += 1;
    const ratio = asked.size ? hit / asked.size : 0;
    // An unrelated reply in the same thread does not stop the clock.
    if (ratio >= 0.34) return { messageId: r.id, ratio: Number(ratio.toFixed(3)) };
  }
  return null;
}

function runSweep(db, cfg, clock, { name = 'default' } = {}) {
  const sweepId = derivedId('swp', name, clock.nowISO());
  const now = clock.now();
  const fired = [];
  const tasks = db.prepare(`SELECT t.*, o.obligation_subject, o.object_key, o.account_id
    FROM tasks t JOIN obligations o ON o.id = t.obligation_id
    WHERE t.status IN ('open','awaiting_response','escalated','pending_fulfillment_review')`).all();

  for (const t of tasks) {
    // Deadline timers. Overdue timers fire on first detection rather than being
    // skipped because their moment has already passed.
    for (const [level, at] of [['first_action', t.first_action_at], ['escalation', t.escalation_at], ['critical', t.critical_at]]) {
      if (!at) continue;
      if (DateTime.fromISO(at) <= now && !alreadyFired(db, t.id, level)) {
        if (fire(db, clock, t.id, level, sweepId, { kind: t.kind, at })) fired.push({ task: t.id, level });
        if (level !== 'first_action') {
          db.prepare("UPDATE tasks SET status = 'escalated', updated_at = ? WHERE id = ? AND status = 'open'")
            .run(clock.nowISO(), t.id);
        }
      }
    }

    // Silence. Only for obligations that are waiting on someone's answer.
    if (!AWAITING_KINDS.has(t.kind)) continue;
    const answered = answeringReply(db, t);
    if (answered) {
      db.prepare("UPDATE tasks SET status = 'open', updated_at = ? WHERE id = ? AND status = 'awaiting_response'")
        .run(clock.nowISO(), t.id);
      continue;
    }
    if (t.status === 'open') {
      db.prepare("UPDATE tasks SET status = 'awaiting_response', updated_at = ? WHERE id = ?").run(clock.nowISO(), t.id);
    }
    const anchor = DateTime.fromISO(t.first_action_at || t.created_at, { zone: cfg.timezone });
    for (const lvl of SILENCE_LEVELS) {
      const due = addBusinessDays(anchor, lvl.businessDays, cfg.holidays);
      if (due <= now && !alreadyFired(db, t.id, lvl.level)) {
        if (fire(db, clock, t.id, lvl.level, sweepId, { kind: t.kind, businessDays: lvl.businessDays })) {
          fired.push({ task: t.id, level: lvl.level });
        }
      }
    }
  }

  db.prepare(`INSERT INTO sweep_state (name, next_run_at, last_run_at) VALUES (?,?,?)
    ON CONFLICT(name) DO UPDATE SET next_run_at = excluded.next_run_at, last_run_at = excluded.last_run_at`)
    .run(name, now.plus({ hours: 6 }).toUTC().toISO({ suppressMilliseconds: true }), clock.nowISO());

  return { sweepId, fired, tasksExamined: tasks.length };
}

module.exports = { runSweep, answeringReply, SILENCE_LEVELS };
