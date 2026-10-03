'use strict';

/**
 * CSV export.
 *
 * Cells that begin with =, +, -, @, tab or carriage return are prefixed with a
 * single quote. A carrier subject line that happens to start with "=" would
 * otherwise be executed as a formula the moment someone opens the file in
 * Excel, which is exactly what an attacker would aim for and also what an
 * ordinary quoting quirk can cause by accident.
 */
const RISKY = /^[=+\-@\t\r]/;

function cell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (RISKY.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows, columns) {
  const head = columns.map(cell).join(',');
  const body = rows.map((r) => columns.map((c) => cell(r[c])).join(','));
  return `${[head, ...body].join('\n')}\n`;
}

function exportTasks(db) {
  const rows = db.prepare(`SELECT t.id AS task_id, t.kind, t.status, t.urgent, t.first_action_at, t.escalation_at,
      t.critical_at, o.account_id, o.account_name, o.policy_ref, o.obligation_subject, o.stated_deadline,
      o.confidence, o.band,
      (SELECT COUNT(*) FROM source_links s WHERE s.obligation_id = o.id) AS source_messages,
      (SELECT GROUP_CONCAT(level) FROM task_escalations e WHERE e.task_id = t.id) AS escalations
    FROM tasks t JOIN obligations o ON o.id = t.obligation_id ORDER BY t.first_action_at`).all();
  return toCsv(rows, ['task_id', 'kind', 'status', 'urgent', 'account_id', 'account_name', 'policy_ref',
    'obligation_subject', 'stated_deadline', 'first_action_at', 'escalation_at', 'critical_at',
    'confidence', 'band', 'source_messages', 'escalations']);
}

module.exports = { toCsv, cell, exportTasks };
