'use strict';
const { htmlToMarkdown, splitTables } = require('./html-to-markdown');
const { sha256 } = require('../core/hash');

const CANON_VERSION = 'canon-v1';

/**
 * Canonical text is what evidence offsets index into. It is deliberately a
 * light touch: NFKC plus whitespace collapsing, nothing that would remove
 * content. Both the display form and the canonical form are stored so a quote
 * shown in the review UI can always be mapped back to the original source.
 */
function canonicalize(text) {
  return String(text)
    .normalize('NFKC')
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const QUOTE_MARKERS = [
  /^\s*On .{4,120} wrote:\s*$/i,
  /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^\s*-{3,}\s*Forwarded message\s*-{3,}\s*$/i,
  /^\s*_{10,}\s*$/,
  /^\s*From:\s*\S.*$/i,
  /^\s*>{1,}\s?/,
];

const DISCLAIMER_HINTS = [
  /confidentiality notice/i,
  /intended (only )?(solely )?for the (use|addressee)/i,
  /if you are not the intended recipient/i,
  /this (e-?mail|message) and any attachments/i,
];

const SIGNATURE_DELIM = /^\s*--\s*$/;
const SIGNATURE_HINTS = [
  /\b(office|direct|mobile|cell|fax)\s*[:.]/i,
  /\b(licensed|agent|producer|account manager|CSR)\b/i,
];

function classifySegment(text) {
  if (DISCLAIMER_HINTS.some((re) => re.test(text))) return 'disclaimer';
  return null;
}

/**
 * Splits a plain body into ordered segments. Nothing is discarded: a quote
 * marker starts a new labelled segment, it does not truncate the message.
 */
function segment(text) {
  const lines = text.split('\n');
  const segments = [];
  let current = { kind: 'reply', lines: [] };
  const push = () => {
    const joined = current.lines.join('\n').trim();
    if (joined) segments.push({ kind: current.kind, text: joined });
  };

  for (const line of lines) {
    if (SIGNATURE_DELIM.test(line) && current.kind === 'reply') {
      push();
      current = { kind: 'signature', lines: [] };
      continue;
    }
    const isQuoteStart = QUOTE_MARKERS.some((re) => re.test(line));
    if (isQuoteStart && current.kind !== 'quoted') {
      push();
      current = { kind: 'quoted', lines: [line] };
      continue;
    }
    current.lines.push(line);
  }
  push();

  // Reclassify disclaimers, and promote a trailing contact-detail tail in the
  // reply segment to a signature when there was no "--" delimiter.
  return segments.map((s) => {
    const forced = classifySegment(s.text);
    if (forced) return { ...s, kind: forced };
    if (s.kind === 'reply') {
      const tail = s.text.split('\n').slice(-6).join('\n');
      if (SIGNATURE_HINTS.filter((re) => re.test(tail)).length >= 2 && s.text.split('\n').length > 6) {
        const all = s.text.split('\n');
        const cut = all.length - 6;
        return [{ kind: 'reply', text: all.slice(0, cut).join('\n').trim() },
          { kind: 'signature', text: all.slice(cut).join('\n').trim() }];
      }
    }
    return s;
  }).flat().filter((s) => s.text);
}

function tokenSet(s) {
  return new Set(canonicalize(s).toLowerCase().split(/[^a-z0-9$.,/-]+/).filter((t) => t.length > 2));
}

/** Jaccard overlap, used only to decide whether plain and HTML say the same thing. */
function similarity(a, b) {
  const A = tokenSet(a); const B = tokenSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/**
 * Builds the ordered, labelled block list for a parsed message.
 * Both text/plain and text/html are retained in message_parts by the caller;
 * this function only decides which representation supplies the blocks, and
 * records the decision.
 */
function buildBlocks(parsed) {
  const plainPart = parsed.parts.find((p) => p.mimeType === 'text/plain' && p.extractedText);
  const htmlPart = parsed.parts.find((p) => p.mimeType === 'text/html' && p.extractedText);
  const notes = [];
  const raw = [];

  let bodySource = null;
  if (htmlPart && plainPart) {
    const md = htmlToMarkdown(htmlPart.extractedText);
    const sim = similarity(md, plainPart.extractedText);
    if (sim >= 0.6) {
      bodySource = { part: htmlPart, markdown: md };
      notes.push({ deduped: 'text/plain', similarity: Number(sim.toFixed(3)), kept: 'text/html' });
    } else {
      // They genuinely differ (a browser-view stub, or content only in one of
      // them). Keep both as blocks rather than picking a winner.
      bodySource = { part: htmlPart, markdown: md };
      raw.push({ kind: 'reply', text: plainPart.extractedText, partIndex: plainPart.index, note: 'divergent-plain' });
      notes.push({ deduped: null, similarity: Number(sim.toFixed(3)), kept: 'both' });
    }
  } else if (htmlPart) {
    bodySource = { part: htmlPart, markdown: htmlToMarkdown(htmlPart.extractedText) };
  } else if (plainPart) {
    bodySource = { part: plainPart, markdown: plainPart.extractedText };
  }

  const blocks = [];
  if (bodySource) {
    for (const piece of splitTables(bodySource.markdown)) {
      if (piece.kind === 'table') {
        blocks.push({ kind: 'table', text: piece.text, partIndex: bodySource.part.index });
      } else {
        for (const seg of segment(piece.text)) {
          blocks.push({ kind: seg.kind, text: seg.text, partIndex: bodySource.part.index });
        }
      }
    }
  }
  for (const extra of raw) {
    for (const seg of segment(extra.text)) blocks.push({ kind: seg.kind, text: seg.text, partIndex: extra.partIndex });
  }
  for (const p of parsed.parts) {
    if (p.filename && p.extractedText) {
      blocks.push({ kind: 'attachment', text: p.extractedText, partIndex: p.index, provenance: p.provenance });
    }
  }

  const withCanon = blocks
    .map((b, i) => ({ ...b, seq: i, canonicalText: canonicalize(b.text), canonVersion: CANON_VERSION }))
    .filter((b) => b.canonicalText.length > 0)
    .map((b, i) => ({ ...b, seq: i }));

  const replyText = withCanon.filter((b) => b.kind === 'reply' || b.kind === 'table')
    .map((b) => b.canonicalText).join('\n');

  return {
    blocks: withCanon,
    notes,
    normalizedHash: sha256(withCanon.map((b) => `${b.kind}:${b.canonicalText}`).join('\n\u0000')),
    // Useful for exact reprocessing checks. It cannot identify every forward of
    // the same notice - that is semantic obligation linking, done elsewhere.
    replyHash: sha256(replyText),
  };
}

module.exports = { canonicalize, segment, buildBlocks, similarity, CANON_VERSION };
