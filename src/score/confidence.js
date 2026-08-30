import { config } from '../config.js';
import { daysBetween, parseISO } from '../normalize/dates.js';

const KNOWN_POLICY_FORMATS = [
  /^FQ-?\d{6,10}$/, // Foxquilt
  /^\.\.\.\d{4,6}$/, // TWIA tail digits
  /^HX-\d{4}-[A-Z0-9]$/, // Hiscox-shaped
  /^PR-BOP-\d{5,9}$/, // Progressive BOP
  /^IPFS-\d{6,12}$/, // IPFS finance account
  /^WS-\d{5,9}$/, // Wholesure
  /^TFIA-?\d{6,9}$/ // Amwins TFIA
];

function matchesKnownFormat(policyNo) {
  return KNOWN_POLICY_FORMATS.some(re => re.test(policyNo));
}

function normalizeForCompare(s) {
  return (s || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/**
 * True only if the *complete* raw_span appears verbatim (after NFKC +
 * whitespace normalization) in the source. §5.4: comparing only a prefix
 * would miss a model that copies the opening of a real sentence and then
 * invents or transforms the rest.
 */
export function normalizedIncludes(haystack, needle) {
  if (!needle) return false;
  const h = normalizeForCompare(haystack);
  const n = normalizeForCompare(needle);
  if (!n) return false;
  return h.includes(n);
}

/**
 * Computed confidence (§0.4, §5.4): every part is something checkable, not
 * the model's self-report. `ctx.body` should be subject + body_full so a
 * span drawn from either grounds correctly. `ctx.today` is ISO
 * yyyy-mm-dd — during replay this is the *message's* date, not wall clock.
 */
export function score(ev, ctx) {
  const parts = {};

  if (ev.due_date_basis === 'absent') {
    parts.date = 0.6;
  } else {
    const d = parseISO(ev.due_date);
    if (!d.isValid) {
      parts.date = 0;
    } else {
      const days = daysBetween(ctx.today, ev.due_date);
      parts.date = (days < -400 || days > 800) ? 0.2 : (ev.due_date_basis === 'stated' ? 1.0 : 0.8);
    }
  }

  const accountScores = { policy: 1.0, name_exact: 0.95, name_fuzzy: 0.95, name_fuzzy_zip: 0.9, ambiguous_exact: 0.3, ambiguous: 0.3, none: 0.2 };
  parts.account = accountScores[ctx.resolution?.method] ?? 0.2;

  parts.policy = !ev.policy_no ? 0.6 : (matchesKnownFormat(ev.policy_no) ? 1.0 : 0.5);

  parts.grounding = ev.raw_span == null ? 0.6 : (normalizedIncludes(ctx.body, ev.raw_span) ? 1.0 : 0.0);

  parts.extractor = ev.extractor === 'parser' ? 1.0 : (ev.extractor === 'human' ? 1.0 : 0.85);

  parts.model = Math.min(1, Math.max(0, ev.model_confidence ?? 0.7));

  const weights = { date: 0.25, account: 0.30, policy: 0.10, grounding: 0.20, extractor: 0.10, model: 0.05 };
  const total = Object.entries(weights).reduce((s, [k, w]) => s + w * (parts[k] ?? 0), 0);

  if (ev.raw_span != null && parts.grounding === 0) return { total: 0, parts, gate: 'hallucinated_span' };
  if (ev.due_date_basis !== 'absent' && parts.date === 0) return { total: 0, parts, gate: 'unparseable_date' };

  return { total, parts, gate: null };
}

export function routeStatus({ total, gate }) {
  if (gate) return 'discarded';
  if (total >= config.confidence.auto) return 'auto';
  return 'queued';
}
