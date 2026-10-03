'use strict';
const { SCHEMA_VERSION } = require('../schema');
const { parseDatePhrase, parseAmount } = require('../dates');

const BODY_KINDS = ['reply', 'table'];
const ALL_KINDS = ['reply', 'table', 'quoted', 'attachment', 'signature', 'disclaimer'];

/**
 * Finds a regex match and returns the whole line containing it as a quotable
 * span. Deterministic parsers are held to the same evidence standard as the
 * model: if a parser cannot point at a line, it does not get to claim a field.
 */
function locate(blocks, re, kinds = BODY_KINDS) {
  for (const b of blocks) {
    if (!kinds.includes(b.kind)) continue;
    const m = new RegExp(re.source, re.flags.replace('g', '')).exec(b.canonical_text);
    if (!m) continue;
    const start = b.canonical_text.lastIndexOf('\n', m.index) + 1;
    let end = b.canonical_text.indexOf('\n', m.index + m[0].length);
    if (end === -1) end = b.canonical_text.length;
    return { blockSeq: b.seq, quote: b.canonical_text.slice(start, end).trim(), match: m, kind: b.kind };
  }
  return null;
}

function locateAll(blocks, re, kinds = BODY_KINDS) {
  const out = [];
  for (const b of blocks) {
    if (!kinds.includes(b.kind)) continue;
    const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let m;
    while ((m = rx.exec(b.canonical_text)) !== null) {
      const start = b.canonical_text.lastIndexOf('\n', m.index) + 1;
      let end = b.canonical_text.indexOf('\n', m.index + m[0].length);
      if (end === -1) end = b.canonical_text.length;
      out.push({ blockSeq: b.seq, quote: b.canonical_text.slice(start, end).trim(), match: m, kind: b.kind });
    }
  }
  return out;
}

const POLICY_RE = /\b([A-Z]{2,6}(?:-[A-Z]{2,6}){0,2}-\d{4,9})\b/g;
const NAME_RE = /\b([A-Z][A-Za-z&.'\-]+(?:[ ][A-Z][A-Za-z&.'\-]+){0,5}[ ](?:LLC|L\.L\.C\.|Inc\.?|PLLC|LP|Ltd\.?|Co\.?|HOA|Homeowners Association))/g;
const ZIP_RE = /\b(\d{5})(?:-\d{4})?\b/g;

function hints(blocks) {
  const bodyText = blocks.filter((b) => BODY_KINDS.includes(b.kind)).map((b) => b.canonical_text).join('\n');
  const quotedText = blocks.filter((b) => b.kind === 'quoted' || b.kind === 'attachment').map((b) => b.canonical_text).join('\n');
  const uniq = (a) => [...new Set(a)];
  const grab = (text, re) => uniq([...text.matchAll(new RegExp(re.source, re.flags))].map((m) => m[1]));

  const bodyNames = grab(bodyText, NAME_RE);
  const quotedNames = grab(quotedText, NAME_RE).filter((n) => !bodyNames.includes(n));
  return {
    policy_refs: uniq([...grab(bodyText, POLICY_RE), ...grab(quotedText, POLICY_RE)]),
    names: bodyNames,
    zips: grab(bodyText, ZIP_RE),
    quoted_only_names: quotedNames,
  };
}

function field(path, value, loc) {
  return { path, value, block_seq: loc.blockSeq, quote: loc.quote };
}

/**
 * Builds an event and guarantees that every claim it makes carries a span.
 * `anchor` is the line the obligation was read from; any claimed field without
 * its own evidence entry inherits it. That is not a free pass: the support gate
 * still checks whether the inherited line actually substantiates the value, and
 * rejects the field if it does not.
 */
function mkEvent({
  kind, obligation, responsible = 'unknown', objectKey = null, deadline = null,
  amount = null, currency = null, hints: h, fields = [], confidence = 1, anchor = null,
}) {
  const present = new Set(fields.map((f) => f.path));
  if (anchor) {
    for (const [path, value] of [['obligation', obligation], ['stated_deadline', deadline],
      ['amount', amount], ['object_key', objectKey]]) {
      if (value !== null && value !== undefined && !present.has(path)) fields.push(field(path, value, anchor));
    }
  }
  return {
    kind,
    obligation,
    responsible_party: responsible,
    object_key: objectKey,
    stated_deadline: deadline,
    amount,
    currency,
    model_confidence: confidence,
    account_hints: h || { policy_refs: [], names: [], zips: [], quoted_only_names: [] },
    fields,
  };
}

function result(events, reason = null, signals = []) {
  return { payload: { schema_version: SCHEMA_VERSION, events, no_obligation_reason: events.length ? null : reason }, signals };
}

/** Convenience: pull a date and its evidence out of a located line. */
function dateFrom(loc, zone) {
  if (!loc) return null;
  const d = parseDatePhrase(loc.quote, zone);
  return d ? { ...d, loc } : null;
}

function amountFrom(loc) {
  if (!loc) return null;
  const a = parseAmount(loc.quote);
  return a ? { ...a, loc } : null;
}

module.exports = { locate, locateAll, hints, field, mkEvent, result, dateFrom, amountFrom, BODY_KINDS, ALL_KINDS, POLICY_RE };
