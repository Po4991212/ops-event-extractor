'use strict';
const { derivedId } = require('../../core/hash');
const { audit } = require('../../db/db');
const C = require('../parsers/common');
const { parseDatePhrase, allDatePhrases, parseAmount } = require('../dates');
const { addressOf } = require('../router');
const { categoryForKind } = require('../categorize');

/**
 * Learned patterns.
 *
 * When the model reads an email from a sender and its answer passes every
 * evidence gate, this module writes down how to read that email again without
 * the model: a trigger phrase that identifies the template, and for each field
 * the few words that come right before the value ("due by", "Amount due:").
 *
 * The rule that matters: a learned pattern never decides anything on its own
 * say-so. It starts in shadow, where it runs next to the model and its answers
 * are only compared. It needs repeated agreement before a person can approve
 * it, and an approved pattern is still spot-checked against the model. A wrong
 * pattern fails silently by misreading every email of its template, which is
 * worse than a model call, so every step here leans towards calling the model.
 *
 * Patterns are data (phrases), never generated code, so nothing learned from an
 * email can execute anything.
 */

const LEARN_KINDS = ['reply', 'table', 'quoted', 'attachment'];
const ACTIVE = ['shadow', 'ready', 'approved'];
const MAX_TRIGGER_WORDS = 6;
const MAX_CUE_WORDS = 4;

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function wordsRe(words) { return words.map(escapeRe).join('\\s+'); }

/**
 * Words that belong to this email rather than to its template: anything with a
 * digit (dates, policy numbers) and any word of a client name the email
 * mentions. The first eval run learned "Policy TWIA-" as a trigger and "Marine
 * Supply Inc expires" as a cue; both would only ever match one client.
 */
function specificWords(event) {
  const h = event.account_hints || {};
  const out = new Set();
  for (const n of [...(h.names || []), ...(h.quoted_only_names || [])]) {
    for (const w of n.split(/\s+/)) out.add(norm(w));
  }
  return out;
}
function norm(w) { return w.toLowerCase().replace(/[^a-z0-9]/g, ''); }
function isSpecific(word, names) { return /\d/.test(word) || names.has(norm(word)); }

/** The opening words of the obligation line, up to the first specific word. */
function triggerFrom(quote, names) {
  const words = [];
  for (const w of quote.trim().split(/\s+/).filter(Boolean)) {
    if (isSpecific(w, names) || /\$/.test(w) || words.length >= MAX_TRIGGER_WORDS) break;
    words.push(w);
  }
  const letters = words.join('').replace(/[^A-Za-z]/g, '').length;
  // Two short words ("This is") would match half the mailbox.
  if (words.length < 2 || letters < 8) return null;
  return words;
}

/** The words immediately before a value, walking back to the first specific word. */
function cueBefore(quote, index, names) {
  const before = quote.slice(0, index).trim().split(/\s+/).filter(Boolean);
  const cue = [];
  for (let i = before.length - 1; i >= 0 && cue.length < MAX_CUE_WORDS; i -= 1) {
    if (isSpecific(before[i], names)) break;
    cue.unshift(before[i]);
  }
  return cue.some((w) => /[A-Za-z]{2,}/.test(w)) ? cue : null;
}

function fieldOf(event, path) { return (event.fields || []).find((f) => f.path === path); }

/**
 * Builds a pattern from one accepted model event, or says why it cannot.
 * Every claimed field must be learnable; a pattern that silently drops the
 * amount would produce events that look complete and are not.
 */
function induce(event, { zone }) {
  if (event.object_key !== null && event.object_key !== undefined) {
    return { ok: false, reason: 'object keys name one specific item and are not learnable' };
  }
  const ob = fieldOf(event, 'obligation');
  if (!ob || !ob.quote) return { ok: false, reason: 'no obligation evidence to learn a trigger from' };
  const names = specificWords(event);
  const trigger = triggerFrom(ob.quote, names);
  if (!trigger) return { ok: false, reason: 'obligation line has no distinctive opening words' };

  const rules = { trigger, fields: {} };

  if (event.stated_deadline !== null) {
    const f = fieldOf(event, 'stated_deadline');
    const phrase = f && allDatePhrases(f.quote, zone).find((d) => d.iso === event.stated_deadline);
    const cue = phrase && cueBefore(f.quote, phrase.index, names);
    if (!cue) return { ok: false, reason: 'no stable words before the deadline' };
    rules.fields.stated_deadline = { cue, type: 'date' };
  }
  if (event.amount !== null) {
    const f = fieldOf(event, 'amount');
    const a = f && parseAmount(f.quote);
    const cue = a && a.value === Number(event.amount) && cueBefore(f.quote, a.index, names);
    if (!cue) return { ok: false, reason: 'no stable words before the amount' };
    rules.fields.amount = { cue, type: 'amount' };
  }
  return { ok: true, rules };
}

/** Finds the cue's line and reads the value that follows the cue on it. */
function readField(blocks, rule, zone) {
  const cueRe = new RegExp(wordsRe(rule.cue), 'i');
  const loc = C.locate(blocks, cueRe, LEARN_KINDS);
  if (!loc) return null;
  const m = cueRe.exec(loc.quote);
  const after = loc.quote.slice(m.index + m[0].length);
  if (rule.type === 'date') {
    const d = parseDatePhrase(after, zone);
    return d ? { value: d.iso, loc } : null;
  }
  const a = parseAmount(after);
  return a ? { value: a.value, currency: a.currency, loc } : null;
}

/**
 * Runs a pattern over a message. It either reproduces every field the pattern
 * knows about, or reports no_match and the model is used instead.
 */
function apply(pattern, blocks, { zone }) {
  const rules = typeof pattern.rules_json === 'string' ? JSON.parse(pattern.rules_json) : pattern.rules;
  const trigger = C.locate(blocks, new RegExp(wordsRe(rules.trigger), 'i'), LEARN_KINDS);
  if (!trigger) return { matched: false, reason: 'trigger phrase not found' };

  const fields = [C.field('obligation', trigger.quote.slice(0, 120), trigger)];
  let deadline = null;
  let amount = null;
  let currency = null;
  if (rules.fields.stated_deadline) {
    const r = readField(blocks, rules.fields.stated_deadline, zone);
    if (!r) return { matched: false, reason: 'deadline cue not found or no date after it' };
    deadline = r.value;
    fields.push(C.field('stated_deadline', r.value, r.loc));
  }
  if (rules.fields.amount) {
    const r = readField(blocks, rules.fields.amount, zone);
    if (!r) return { matched: false, reason: 'amount cue not found or no amount after it' };
    amount = r.value;
    currency = r.currency;
    fields.push(C.field('amount', r.value, r.loc));
  }

  return {
    matched: true,
    event: C.mkEvent({
      kind: pattern.kind,
      obligation: trigger.quote.slice(0, 160),
      responsible: pattern.responsible_party,
      deadline, amount, currency,
      hints: C.hints(blocks), fields, confidence: 0.8, anchor: trigger,
    }),
  };
}

/**
 * Same kind, same deadline, same amount; wording is allowed to differ. The
 * model must also have found exactly one obligation: a pattern reads one, so
 * agreeing on an email that held two would teach it to drop the second.
 */
function compare(patternEvent, modelEvents) {
  if ((modelEvents || []).length > 1) {
    return { agree: false, detail: { reason: `model found ${modelEvents.length} obligations; a pattern reads one` } };
  }
  const same = (modelEvents || []).filter((e) => e.kind === patternEvent.kind);
  if (!same.length) return { agree: false, detail: { reason: `model found no ${patternEvent.kind}` } };
  const hit = same.find((e) => e.stated_deadline === patternEvent.stated_deadline
    && (e.amount === null ? null : Number(e.amount)) === patternEvent.amount);
  if (hit) return { agree: true, detail: { kind: patternEvent.kind } };
  return {
    agree: false,
    detail: {
      reason: 'fields differ',
      pattern: { stated_deadline: patternEvent.stated_deadline, amount: patternEvent.amount },
      model: same.map((e) => ({ stated_deadline: e.stated_deadline, amount: e.amount })),
    },
  };
}

// ---------------------------------------------------------------- storage --

function senderOf(message) { return addressOf(message.from_addr) || null; }

function activeFor(db, sender) {
  if (!sender) return [];
  return db.prepare(`SELECT * FROM learned_patterns WHERE sender = ? AND status IN ('shadow','ready','approved')
    ORDER BY created_at, id`).all(sender);
}

function internalDomains(cfg) {
  return new Set((cfg.mailboxes || []).filter((m) => m.address).map((m) => m.address.split('@').pop().toLowerCase()));
}

function get(db, id) { return db.prepare('SELECT * FROM learned_patterns WHERE id = ?').get(id); }

/** Grouped by the agency's category number, uncategorized last. */
function list(db) {
  const { BY_ID } = require('../../config/categories');
  const n = (p) => (BY_ID.get(p.category) || { n: 99 }).n;
  return db.prepare('SELECT * FROM learned_patterns ORDER BY sender, kind, created_at').all()
    .sort((a, b) => n(a) - n(b));
}

function setStatus(db, clock, pattern, status, reason, actor) {
  db.prepare('UPDATE learned_patterns SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?')
    .run(status, reason, clock.nowISO(), pattern.id);
  audit(db, { at: clock.nowISO(), actor, action: `learned_pattern_${status}`,
    subjectType: 'learned_pattern', subjectId: pattern.id, detail: { from: pattern.status, reason } });
}

/**
 * Stores a new shadow pattern from an accepted model event. Only one active
 * pattern per sender and kind: a second would compete with the first.
 */
function learn(db, cfg, clock, { message, event, family = null }) {
  const sender = senderOf(message);
  if (!sender) return { learned: false, reason: 'no sender address' };
  // Colleagues write in their own words every time; only machine-sent
  // templates repeat. Learning from the agency's own domain produced patterns
  // that could never match a second email.
  if (internalDomains(cfg).has(sender.split('@').pop())) {
    return { learned: false, reason: 'sender is inside the agency' };
  }
  const zone = cfg.timezone;
  if (activeFor(db, sender).some((p) => p.kind === event.kind)) {
    return { learned: false, reason: 'an active pattern already covers this sender and kind' };
  }
  const induced = induce(event, { zone });
  if (!induced.ok) return { learned: false, reason: induced.reason };

  const id = derivedId('lp', sender, event.kind, JSON.stringify(induced.rules));
  // A pattern a person retired, or that the model contradicted, is not quietly
  // learned again from the next email that happens to produce the same rules.
  if (get(db, id)) return { learned: false, reason: 'this exact pattern was learned before', id };

  const now = clock.nowISO();
  db.prepare(`INSERT INTO learned_patterns
    (id, sender, kind, category, responsible_party, rules_json, status, status_reason, learned_from_message_id, created_at, updated_at)
    VALUES (?,?,?,?,?,?,'shadow',?,?,?,?)`).run(
    id, sender, event.kind,
    categoryForKind(event.kind, { family, text: `${message.subject || ''}\n${(message.blocks || []).map((b) => b.canonical_text).join('\n')}` }),
    event.responsible_party || 'unknown', JSON.stringify(induced.rules),
    'learned from an accepted model extraction', message.id, now, now,
  );
  audit(db, { at: now, actor: 'learned-patterns', action: 'learned_pattern_created',
    subjectType: 'learned_pattern', subjectId: id, detail: { sender, kind: event.kind, messageId: message.id } });
  return { learned: true, id };
}

/**
 * Records one comparison. Returns false when this pattern was already compared
 * on this message, so a replay never double-counts agreement.
 */
function recordTrial(db, clock, pattern, message, mode, outcome, detail) {
  const r = db.prepare(`INSERT OR IGNORE INTO learned_pattern_trials
    (id, pattern_id, message_id, mode, outcome, detail_json, created_at) VALUES (?,?,?,?,?,?,?)`).run(
    derivedId('lpt', pattern.id, message.id, mode), pattern.id, message.id, mode, outcome,
    JSON.stringify(detail || {}), clock.nowISO(),
  );
  if (!r.changes) return false;
  const col = { agree: 'agreements', disagree: 'disagreements', no_match: 'no_matches' }[outcome];
  db.prepare(`UPDATE learned_patterns SET ${col} = ${col} + 1, updated_at = ? WHERE id = ?`).run(clock.nowISO(), pattern.id);
  return true;
}

/**
 * Shadow step: after the model has answered, every shadow or ready pattern for
 * this sender is run and compared. One disagreement suspends it.
 */
function shadowCompare(db, cfg, clock, { message, blocks, modelEvents }) {
  const out = [];
  for (const p of activeFor(db, senderOf(message)).filter((x) => x.status !== 'approved')) {
    if (p.learned_from_message_id === message.id) continue; // agreeing with itself proves nothing
    const r = apply(p, blocks, { zone: cfg.timezone });
    if (!r.matched) {
      recordTrial(db, clock, p, message, 'shadow', 'no_match', { reason: r.reason });
      out.push({ id: p.id, outcome: 'no_match' });
      continue;
    }
    const c = compare(r.event, modelEvents);
    const fresh = recordTrial(db, clock, p, message, 'shadow', c.agree ? 'agree' : 'disagree', c.detail);
    out.push({ id: p.id, outcome: c.agree ? 'agree' : 'disagree' });
    if (!fresh) continue;
    if (!c.agree) {
      setStatus(db, clock, p, 'suspended', `disagreed with the model on ${message.id}`, 'learned-patterns');
      continue;
    }
    const now = get(db, p.id);
    if (now.status === 'shadow' && now.agreements >= cfg.learnedPatterns.agreementsToReady && now.disagreements === 0) {
      setStatus(db, clock, now, 'ready', `agreed with the model on ${now.agreements} emails; waiting for a person to approve`, 'learned-patterns');
    }
  }
  return out;
}

/** The first approved pattern for this sender that reads the message, if any. */
function approvedMatch(db, cfg, { message, blocks }) {
  for (const p of activeFor(db, senderOf(message)).filter((x) => x.status === 'approved')) {
    const r = apply(p, blocks, { zone: cfg.timezone });
    if (r.matched) return { pattern: p, event: r.event };
  }
  return null;
}

/** Counts a use and says whether this use is one the model should double-check. */
function countUse(db, clock, pattern, spotCheckEvery) {
  db.prepare('UPDATE learned_patterns SET uses = uses + 1, updated_at = ? WHERE id = ?').run(clock.nowISO(), pattern.id);
  const uses = pattern.uses + 1;
  return Boolean(spotCheckEvery) && uses % spotCheckEvery === 0;
}

function approve(db, clock, id, { by }) {
  const p = get(db, id);
  if (!p) throw new Error(`no learned pattern ${id}`);
  if (!by) throw new Error('approving a pattern needs the name of the person approving it (--by=NAME)');
  if (p.status !== 'ready') {
    throw new Error(`pattern ${id} is ${p.status}; only a pattern that has agreed with the model enough times (ready) can be approved`);
  }
  db.prepare("UPDATE learned_patterns SET status = 'approved', status_reason = ?, approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?")
    .run(`approved by ${by}`, by, clock.nowISO(), clock.nowISO(), id);
  audit(db, { at: clock.nowISO(), actor: `person:${by}`, action: 'learned_pattern_approved',
    subjectType: 'learned_pattern', subjectId: id, detail: { agreements: p.agreements } });
  return get(db, id);
}

function retire(db, clock, id, { by = 'operator', reason = 'retired by a person' } = {}) {
  const p = get(db, id);
  if (!p) throw new Error(`no learned pattern ${id}`);
  setStatus(db, clock, p, 'retired', reason, `person:${by}`);
  return get(db, id);
}

module.exports = {
  induce, apply, compare, learn, shadowCompare, approvedMatch, countUse, recordTrial,
  approve, retire, setStatus, list, get, activeFor, senderOf, ACTIVE,
};
