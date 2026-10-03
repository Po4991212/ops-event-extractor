'use strict';
const http = require('../core/http');
const credentials = require('../core/credentials');
const { AppError } = require('../core/errors');

/**
 * QQ Catalyst note write-back.
 *
 * Scope is deliberately one operation: attach an activity note to an existing
 * policy or account. It never selects a contact, never creates an account,
 * never touches a transaction.
 *
 * Known unresolved issue: note creation against the live tenant currently
 * returns HTTP 417 with the credentials available during this build. The cause
 * has not been identified and nothing here should be read as a fix. The
 * adapter records 417 distinctly so the failure is visible rather than folded
 * into a generic error, and dispatch stays off by default.
 */
function buildNote(task, obligation, { generatedBy = 'ops-event-extractor' } = {}) {
  return {
    entityType: obligation.policy_ref ? 'Policy' : 'Account',
    entityRef: obligation.policy_ref || obligation.account_id,
    subject: `[ops] ${task.kind}: ${String(obligation.obligation_subject).slice(0, 80)}`,
    body: [
      `Obligation: ${obligation.obligation_subject}`,
      obligation.stated_deadline ? `Stated deadline: ${obligation.stated_deadline}` : null,
      `First action: ${task.first_action_at}`,
      `Source messages: ${task.source_count || 1}`,
      'Recorded automatically from agency email. Not a coverage confirmation.',
    ].filter(Boolean).join('\n'),
    generatedBy,
  };
}

function makeDispatcher(cfg, { requestImpl = http.request, tokenAccount = 'qq-access-token' } = {}) {
  return async function dispatch(row) {
    const payload = JSON.parse(row.payload_json);
    const token = credentials.get(tokenAccount);
    let res;
    try {
      res = await requestImpl('POST', `${cfg.qq.baseUrl}/activities`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
          'Idempotency-Key': row.idempotency_key },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      // No response at all. The note may or may not exist on the far side.
      const err = new AppError(`no response from QQ: ${e.message}`, 'UNKNOWN_OUTCOME');
      throw err;
    }
    if (res.status === 417) {
      throw new AppError('QQ returned 417 on activity create (known unresolved issue)', 'QQ_417', { body: res.text.slice(0, 300) });
    }
    if (res.status === 408 || res.status === 504) {
      throw new AppError(`QQ timed out (${res.status})`, 'UNKNOWN_OUTCOME');
    }
    if (!res.ok) throw new AppError(`QQ error ${res.status}`, 'QQ_HTTP', { body: res.text.slice(0, 300) });
    return JSON.parse(res.text);
  };
}

module.exports = { buildNote, makeDispatcher };
