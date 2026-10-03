'use strict';
const { CATEGORIES, BY_ID, KIND_TO_CATEGORY, GENERIC_KINDS } = require('../config/categories');
const { addressOf, domainMatches, loadSources } = require('./router');

/**
 * Puts every email in one of the agency's eighteen categories, without a model
 * call. Four steps, first match wins:
 *
 *   1. suspicious  - lookalike sender, instruction-like text, a request to
 *                    change bank details, credential phishing, or a risky
 *                    attachment. Checked first so a fraudulent "invoice"
 *                    never lands in Billing looking legitimate.
 *   2. event_kind  - an obligation was extracted; its kind decides.
 *   3. noise_route - the router already dropped it as a known benign template.
 *   4. keywords    - subject first, then the body.
 *
 * If nothing fits, the category is null and a person sorts it. It never guesses.
 */

const SUSPICIOUS = [
  [/ignore (all )?previous instructions|system (instruction|override)|admin mode/i, 'contains instruction-like text aimed at software'],
  [/\b(?:updated|new|changed?|change (?:of|in|to) (?:our)?)\s*(?:bank|banking|wire|remittance|payment|ACH)\s*(?:details|information|instructions|account)\b/i,
    'asks to change where payments are sent (a common payment fraud)'],
  [/\b(?:verify|confirm|validate|update) your (?:password|account|login|credentials|mailbox)\b/i, 'asks for login details'],
  [/\b(?:account|mailbox) (?:will be |has been )?(?:suspended|locked|deactivated)\b/i, 'threatens account suspension'],
];
const RISKY_ATTACHMENT = /\.(?:exe|scr|js|vbs|bat|cmd|iso|img|hta|lnk|docm|xlsm|pptm)$/i;

function lookalikeOf(sender, sources) {
  if (!sender) return null;
  const domain = sender.split('@').pop();
  for (const spec of Object.values(sources.families)) {
    for (const d of spec.domains || []) {
      const dl = d.toLowerCase();
      if (domain.includes(dl) && !domainMatches(domain, dl)) return dl;
    }
  }
  return null;
}

function suspiciousReason(message, text, sources) {
  const look = lookalikeOf(addressOf(message.from_addr), sources);
  if (look) return `sender imitates ${look} without being it`;
  for (const [re, why] of SUSPICIOUS) if (re.test(text)) return why;
  const bad = (message.parts || []).find((p) => p.filename && RISKY_ATTACHMENT.test(p.filename));
  if (bad) return `risky attachment type: ${bad.filename}`;
  return null;
}

/** Category for one obligation kind, with the premium-finance refinement. */
function categoryForKind(kind, { family = null, text = '' } = {}) {
  const cat = KIND_TO_CATEGORY[kind] || null;
  if (cat === 'billing' && (family === 'ipfs' || /premium financ|finance (?:agreement|company)|installment/i.test(text))) {
    return 'premium_financing';
  }
  return cat;
}

function byKeywords(text) {
  for (const c of CATEGORIES) {
    const hit = c.cues.find((re) => re.test(text));
    if (hit) return { id: c.id, cue: hit.source };
  }
  return null;
}

function result(id, source, reason, suspicious = false) {
  const c = id ? BY_ID.get(id) : null;
  return { category: id, n: c ? c.n : null, label: c ? c.label : 'Uncategorized', source, reason, suspicious };
}

/**
 * @param message  row from getMessage (with blocks and parts)
 * @param outcome  what the pipeline produced: { routing, accepted, quarantined }
 */
function categorize(message, outcome, { sources = loadSources() } = {}) {
  const blocks = message.blocks || [];
  const body = blocks.filter((b) => ['reply', 'table', 'quoted', 'attachment'].includes(b.kind))
    .map((b) => b.canonical_text).join('\n');
  const subject = message.subject || '';
  const all = `${subject}\n${body}`;

  const sus = suspiciousReason(message, all, sources);
  if (sus) return result('marketing_suspicious', 'suspicious', sus, true);

  const family = outcome && outcome.routing ? outcome.routing.family : null;
  const kinds = [...((outcome && outcome.accepted) || []), ...((outcome && outcome.quarantined) || [])].map((e) => e.kind);
  for (const kind of kinds) {
    if (GENERIC_KINDS.includes(kind)) {
      const s = byKeywords(subject);
      if (s) return result(s.id, 'keywords', `subject matched /${s.cue}/, more specific than obligation kind ${kind}`);
    }
    const id = categoryForKind(kind, { family, text: all });
    if (id) return result(id, 'event_kind', `obligation of kind ${kind}`);
  }

  if (outcome && outcome.routing && outcome.routing.route === 'noise') {
    return result('marketing_suspicious', 'noise_route', outcome.routing.reason);
  }

  const s = byKeywords(subject);
  if (s) return result(s.id, 'keywords', `subject matched /${s.cue}/`);
  const b = byKeywords(body);
  if (b) return result(b.id, 'keywords', `body matched /${b.cue}/`);

  return result(null, 'none', 'no category rule matched; needs a person');
}

function record(db, clock, messageId, r) {
  db.prepare(`INSERT INTO message_categories (message_id, category, category_n, source, suspicious, reason, updated_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(message_id) DO UPDATE SET category = excluded.category, category_n = excluded.category_n,
      source = excluded.source, suspicious = excluded.suspicious, reason = excluded.reason, updated_at = excluded.updated_at`)
    .run(messageId, r.category, r.n, r.source, r.suspicious ? 1 : 0, r.reason, clock.nowISO());
}

module.exports = { categorize, categoryForKind, byKeywords, record, lookalikeOf };
