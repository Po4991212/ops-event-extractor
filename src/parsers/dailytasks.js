import { isoDate, resolveShortDate } from '../normalize/dates.js';

// Not part of the routing registry (src/parsers/registry.js): this parser
// produces ground_truth rows for the eval set (§3.4), not OpsEvents for the
// production pipeline. It is invoked directly by `cli.js parse-daily-tasks`.

const SECTION_RE = /^\s*\*?(Completed|Pending\s*\/\s*Follow-?up)\*?\s*$/i;
const ITEM_RE = /^\s*[-•]\s*\*?(.+?)\*?\s*[–-]\s*(.+)$/;
const FOLLOWUP_RE = /Follow-?up scheduled for\s*\*?(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i;

const KIND_HINTS = [
  [/renewal payment|premium was paid|past-?due/i, 'payment_due'],
  [/pending signature|LPR|binding documents/i, 'signature_required'],
  [/issued the COI|certificate/i, 'coi_request'],
  [/uploaded .* to QQ|downloaded/i, 'other'],
  [/new business process/i, 'other'],
  [/claim/i, 'claim_activity'],
  [/cancellation/i, 'cancellation_notice'],
  [/renewal/i, 'renewal_due'],
  [/quote/i, 'quote_received']
];

function inferKind(text) {
  for (const [re, kind] of KIND_HINTS) if (re.test(text)) return kind;
  return 'other';
}

/** Joins wrapped continuation lines (indented, no leading bullet/section marker) onto the previous bullet. */
function unwrap(lines) {
  const out = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const isBullet = /^\s*[-•]/.test(line);
    const isSection = SECTION_RE.test(line);
    const isBlank = !line.trim();
    if (!isBullet && !isSection && !isBlank && out.length && /^\s{2,}\S/.test(line)) {
      out[out.length - 1] = `${out[out.length - 1]} ${line.trim()}`;
    } else if (!isBlank) {
      out.push(line);
    }
  }
  return out;
}

export function parseDailyTasks(msg) {
  const rows = [];
  let section = null;
  const lines = unwrap((msg.body_text || '').split('\n'));
  for (const line of lines) {
    const s = SECTION_RE.exec(line);
    if (s) { section = /Completed/i.test(s[1]) ? 'completed' : 'pending'; continue; }
    const m = ITEM_RE.exec(line);
    if (!m || !section) continue;
    const [, account, rest] = m;
    const fu = FOLLOWUP_RE.exec(rest);
    rows.push({
      source_msg_id: msg.id,
      source_line: line.trim(),
      section,
      account_name_raw: account.replace(/\*/g, '').trim(),
      obligation: rest.trim(),
      due_date: fu ? resolveShortDate(fu[1], msg.internal_date) : null,
      kind: inferKind(rest),
      observed_on: isoDate(msg.internal_date)
    });
  }
  return rows;
}
