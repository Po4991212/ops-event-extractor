'use strict';
const { canonicalize, CANON_VERSION } = require('../ingest/normalize');
const { allDatePhrases, parseAmount } = require('./dates');

/**
 * Two separate questions, both of which have to be answered yes:
 *
 *   1. Does this quote actually exist in the source?  (validateSpan)
 *   2. Does it support the specific claim being made?  (supportsField)
 *
 * Copying a real sentence out of the message satisfies the first and fails the
 * second. That is the case this file exists for: an extractor that quotes
 * "Our office will be closed on 07/04/2026" as evidence for a renewal deadline
 * of 06/01/2026 is wrong in a way that a plain substring check cannot see.
 */
const EMPTY_QUOTE = 'empty or whitespace-only quote';

function validateSpan(blocks, blockSeq, quote) {
  const canonQuote = canonicalize(quote == null ? '' : quote);
  if (!canonQuote) return { ok: false, reason: EMPTY_QUOTE };

  const block = blocks.find((b) => b.seq === blockSeq);
  if (!block) return { ok: false, reason: `no block with seq ${blockSeq}` };

  const idx = block.canonical_text.indexOf(canonQuote);
  if (idx === -1) {
    // Fall back to a scan of every block: an extractor citing the wrong block
    // index is a lesser error than fabricating text, and the two should be
    // distinguishable in the diagnostic.
    const elsewhere = blocks.find((b) => b.canonical_text.includes(canonQuote));
    if (elsewhere) {
      return {
        ok: true, corrected: true, blockId: elsewhere.id, blockSeq: elsewhere.seq,
        start: elsewhere.canonical_text.indexOf(canonQuote),
        end: elsewhere.canonical_text.indexOf(canonQuote) + canonQuote.length,
        canonVersion: CANON_VERSION, quote: canonQuote,
        reason: `quote found in block ${elsewhere.seq}, not the cited ${blockSeq}`,
      };
    }
    return { ok: false, reason: 'quote does not appear in any normalized block of this message' };
  }

  return {
    ok: true, corrected: false, blockId: block.id, blockSeq: block.seq,
    start: idx, end: idx + canonQuote.length, canonVersion: CANON_VERSION, quote: canonQuote,
  };
}

function tokens(s) {
  return new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2));
}

const DEADLINE_CUES = /\b(due|by|before|no later than|deadline|expires?|expiration|lapse|effective|complete[ds]?|required|valid until|renewal|renew|cancel(?:led|lation)?|nonrenew)\b/i;

function supportsField(path, value, quote, zone, opts = {}) {
  const q = canonicalize(quote || '');
  if (!q) return { ok: false, reason: EMPTY_QUOTE };
  if (value === null || value === undefined) return { ok: true, reason: 'null value needs no support' };

  if (/date|deadline/.test(path)) {
    const found = allDatePhrases(q, zone);
    if (!found.length) return { ok: false, reason: 'quote contains no date phrase' };
    if (!found.some((f) => f.iso === String(value))) {
      return { ok: false, reason: `quote dates [${found.map((f) => f.iso).join(', ')}] do not include ${value}` };
    }
    // A date alone is not a deadline. "Our office will be closed on 07/04/2026"
    // contains a real date in a real sentence and substantiates nothing about
    // when an obligation is owed. Table rows are exempt because a schedule row
    // carries its meaning in the column header rather than in prose.
    if (opts.blockKind !== 'table' && !DEADLINE_CUES.test(q)) {
      return { ok: false, reason: 'quote contains the date but no deadline language; the span does not say this date is owed' };
    }
    return { ok: true, reason: `date phrase "${found.find((f) => f.iso === String(value)).phrase}" present with deadline language` };
  }

  if (/amount|premium|balance/.test(path)) {
    const amt = parseAmount(q);
    if (!amt) return { ok: false, reason: 'quote contains no monetary amount' };
    if (Math.abs(amt.value - Number(value)) > 0.005) {
      return { ok: false, reason: `quote amount ${amt.value} does not match claimed ${value}` };
    }
    return { ok: true, reason: `amount ${amt.phrase} present` };
  }

  if (/policy|quote_ref|account_ref/.test(path)) {
    if (!q.toLowerCase().includes(String(value).toLowerCase())) {
      return { ok: false, reason: 'quote does not contain the claimed identifier' };
    }
    return { ok: true, reason: 'identifier present in quote' };
  }

  // Object keys are structured ("installment:3", "vehicle:VIN ..."). The type
  // prefix is ours; what has to appear in the source is the value part.
  if (/object_key/.test(path)) {
    const tail = String(value).split(':').slice(1).join(':') || String(value);
    const toks = tail.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (!toks.length) return { ok: true, reason: 'object key has no comparable value part' };
    const lower = q.toLowerCase();
    const hit = toks.filter((t) => lower.includes(t)).length;
    if (hit / toks.length < 0.5) {
      return { ok: false, reason: `quote contains ${hit}/${toks.length} of the object key's terms` };
    }
    return { ok: true, reason: `object key terms present (${hit}/${toks.length})` };
  }

  // Free-text fields: require real lexical overlap so an arbitrary sentence
  // cannot be attached to an arbitrary obligation description.
  const V = tokens(value); const Q = tokens(q);
  if (!V.size) return { ok: true, reason: 'no comparable tokens in value' };
  let overlap = 0;
  for (const t of V) if (Q.has(t)) overlap += 1;
  const ratio = overlap / V.size;
  if (ratio < 0.3) return { ok: false, reason: `quote shares only ${overlap}/${V.size} content tokens with the claim` };
  return { ok: true, reason: `quote shares ${overlap}/${V.size} content tokens` };
}

module.exports = { validateSpan, supportsField, EMPTY_QUOTE };
