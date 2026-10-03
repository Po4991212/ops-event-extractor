'use strict';
const { DateTime } = require('luxon');
const { SLA, MISSING_SLA_KINDS, anchorOf } = require('../config/sla');

/**
 * Turns an SLA row into concrete times.
 *
 * Two rules that are easy to get backwards:
 *
 *   Negative offsets count calendar days back from a contractual deadline. If
 *   the result lands on a weekend or holiday it moves EARLIER. Moving it later
 *   would quietly shorten the agency's own runway on the carrier's deadline.
 *
 *   Positive offsets count business days forward from first receipt. Forwarding
 *   or reprocessing a message does not restart that clock - the anchor is the
 *   first supported receipt of the obligation, which is stored once.
 */
function isWeekend(dt) { return dt.weekday === 6 || dt.weekday === 7; }
function isHoliday(dt, holidays) { return holidays.has(dt.toISODate()); }
function isBusinessDay(dt, holidays) { return !isWeekend(dt) && !isHoliday(dt, holidays); }

function addBusinessDays(start, days, holidays) {
  let dt = start;
  let remaining = Math.abs(days);
  const step = days >= 0 ? 1 : -1;
  while (remaining > 0) {
    dt = dt.plus({ days: step });
    if (isBusinessDay(dt, holidays)) remaining -= 1;
  }
  return dt;
}

/** Calendar arithmetic, then pull back to the nearest earlier business day. */
function subtractCalendarDaysNeverLater(dueDate, days, holidays) {
  let dt = dueDate.minus({ days: Math.abs(days) });
  let guard = 0;
  while (!isBusinessDay(dt, holidays) && guard < 14) { dt = dt.minus({ days: 1 }); guard += 1; }
  return dt;
}

function computeTimes(kind, { dueDateISO, receiptISO }, cfg) {
  const zone = cfg.timezone;
  const holidays = cfg.holidays;
  const receipt = DateTime.fromISO(receiptISO, { zone });

  if (MISSING_SLA_KINDS.includes(kind)) {
    return {
      firstActionAt: receipt.toUTC().toISO({ suppressMilliseconds: true }),
      escalationAt: null,
      criticalAt: null,
      missingSla: true,
      needsDateReview: false,
      note: 'no agency SLA defined for this kind; visible ownership task created at receipt',
    };
  }

  const row = SLA[kind];
  if (!row) {
    return { firstActionAt: receipt.toUTC().toISO({ suppressMilliseconds: true }), escalationAt: null,
      criticalAt: null, missingSla: true, needsDateReview: false, note: `unknown kind ${kind}` };
  }

  const anchor = anchorOf(kind);
  if (anchor === 'due_date') {
    if (!dueDateISO) {
      // The offset needs a date we do not have. The task is still created and
      // is explicitly flagged for date review; it is never silently dropped.
      return {
        firstActionAt: receipt.toUTC().toISO({ suppressMilliseconds: true }),
        escalationAt: null, criticalAt: null, missingSla: false, needsDateReview: true,
        note: 'deadline-relative SLA with no confirmed due date; date review requested at receipt',
      };
    }
    const due = DateTime.fromISO(dueDateISO, { zone }).startOf('day');
    const at = (n) => subtractCalendarDaysNeverLater(due, n, holidays).set({ hour: 9 }).toUTC().toISO({ suppressMilliseconds: true });
    return {
      firstActionAt: at(row.first), escalationAt: at(row.escalation), criticalAt: at(row.critical),
      missingSla: false, needsDateReview: false,
      note: 'calendar-day offsets before the confirmed due date, pulled earlier off weekends and holidays',
    };
  }

  const at = (n) => (n === 0
    ? receipt.toUTC().toISO({ suppressMilliseconds: true })
    : addBusinessDays(receipt, n, holidays).set({ hour: 9 }).toUTC().toISO({ suppressMilliseconds: true }));
  return {
    firstActionAt: at(row.first), escalationAt: at(row.escalation), criticalAt: at(row.critical),
    missingSla: false, needsDateReview: false,
    note: 'business-day offsets from first supported receipt',
  };
}

/** Ordering check used by tests and by the config validator. */
function timesOrdered(t) {
  const v = [t.firstActionAt, t.escalationAt, t.criticalAt].filter(Boolean).map((x) => new Date(x).getTime());
  return v.every((x, i) => i === 0 || v[i - 1] <= x);
}

module.exports = { computeTimes, addBusinessDays, subtractCalendarDaysNeverLater, isBusinessDay, timesOrdered };
