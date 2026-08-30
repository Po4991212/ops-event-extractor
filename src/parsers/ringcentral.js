import { loadClientIndex } from '../resolve/account.js';
import { addBusinessDays, addDays, isoDate, nextWeekday } from '../normalize/dates.js';

const WEEKDAY_RE = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i;

function section(text, label, stopLabels) {
  const re = new RegExp(`\\b${label}\\b([\\s\\S]*?)(?=\\b(${stopLabels.join('|')})\\b|$)`, 'i');
  return re.exec(text)?.[1]?.trim() ?? null;
}

function bullets(block) {
  return block
    .split(/\n?\s*[*•-]\s+/)
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(s => s.length > 15);
}

/** §4.2 phrase table: derives a due date from RingCentral's vague task phrasing. */
export function deriveDue(taskText, callDateIso) {
  const t = taskText.toLowerCase();
  if (/within the next few days/.test(t)) return { date: addBusinessDays(callDateIso, 3), basis: 'derived' };
  const wk = WEEKDAY_RE.exec(t);
  if (/\bby\b|\bon\b/.test(t) && wk) return { date: nextWeekday(callDateIso, wk[1]), basis: 'derived' };
  if (/\btoday\b|this afternoon/.test(t)) return { date: callDateIso, basis: 'derived' };
  if (/\bshortly\b|\bsoon\b|\basap\b/.test(t)) return { date: addBusinessDays(callDateIso, 1), basis: 'derived' };
  return { date: null, basis: 'absent' };
}

function firstPolicyNo(text) {
  const m = /\b([A-Z]{2,6}-?\d{4,10}(?:-[A-Z0-9]+)?)\b/.exec(text);
  return m ? m[1] : null;
}

function firstAmount(text) {
  const m = /\$([\d,]+(?:\.\d{2})?)/.exec(text);
  if (!m) return null;
  return Math.round(parseFloat(m[1].replace(/,/g, '')) * 100);
}

/**
 * Matches a client's name against the recap/body by substring containment
 * on normalized tokens (§4.2: "if exactly one client name appears in the
 * body, use it... do not have the parser guess").
 */
function guessAccount(body) {
  const lower = body.toLowerCase();
  const hits = loadClientIndex().filter(c => lower.includes(c._normName));
  const distinctIds = new Set(hits.map(h => h.id));
  if (distinctIds.size === 1) return hits[0].name;
  return null;
}

function parseCallDate(subject, internalDateMs) {
  // Subject: "Notes of your call with +1... on Friday, August 28, 2026 at 11:42 AM"
  const m = /on\s+\w+,\s+([A-Za-z]+ \d{1,2},\s*\d{4})/.exec(subject || '');
  if (m) {
    const d = new Date(m[1]);
    if (!Number.isNaN(d.getTime())) return isoDate(d.getTime());
  }
  return isoDate(internalDateMs);
}

export default {
  name: 'ringcentral-callnotes',
  match: (msg) => /service@ringcentral(-example)?\.com/i.test(msg.from_addr || '') && /^Notes of your call with/i.test(msg.subject || ''),

  parse(msg) {
    const body = msg.body_full || '';
    const tasksBlock = section(body, 'Tasks', ['Recap', 'Tasks', 'View transcript']);
    if (!tasksBlock) return [];

    const callDateIso = parseCallDate(msg.subject, msg.internal_date);
    const account = guessAccount(body);

    return bullets(tasksBlock).map(t => {
      const due = deriveDue(t, callDateIso);
      return {
        kind: 'client_commitment',
        obligation: t,
        due_date: due.date,
        due_date_basis: due.basis,
        account_name_raw: account,
        carrier: null,
        policy_no: firstPolicyNo(body),
        amount_cents: firstAmount(t),
        raw_span: t,
        extractor: 'parser',
        extractor_ref: 'ringcentral-callnotes'
      };
    });
  }
};
