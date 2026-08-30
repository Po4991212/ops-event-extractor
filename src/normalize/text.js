import { parse as parseHtml } from 'node-html-parser';

// Ordered so the earliest-matching marker in a message wins (§3.3).
const QUOTE_MARKERS = [
  /^On .+ wrote:$/m,
  /^-{2,}\s*Forwarded message\s*-{2,}$/mi,
  /^_{5,}$/m,
  /^From:\s.+$/m,
  /^Vào (Th|CN).+ đã viết:$/m // Vietnamese Gmail quote header, high-volume in this mailbox
];

const SIG_MARKERS = [
  /^--\s*$/m,
  /\*{0,2}Ai Insurance Services, LLC\*{0,2}/,
  /\*{3}FLOOD INSURANCE FACT\*{3}/,
  /\*\*We have a new .living. life insurance policy/
];

/** Converts an HTML email body to plain text, preserving line breaks at block boundaries. */
export function htmlToText(html) {
  if (!html) return '';
  const root = parseHtml(html, { blockTextElements: { script: false, style: false } });
  for (const el of root.querySelectorAll('br')) el.replaceWith('\n');
  for (const tag of ['p', 'div', 'tr', 'li', 'table']) {
    for (const el of root.querySelectorAll(tag)) el.set_content(`${el.textContent}\n`);
  }
  const text = root.textContent || '';
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function cutAtFirstMarker(text, markers) {
  let cut = text.length;
  for (const re of markers) {
    const m = re.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  return text.slice(0, cut).trim();
}

/** Removes quoted reply/forward chains. Used to build body_text from body_full. */
export function stripQuoted(text) {
  return cutAtFirstMarker(text || '', QUOTE_MARKERS);
}

/** Removes the agency's signature/footer boilerplate. */
export function stripSignature(text) {
  return cutAtFirstMarker(text || '', SIG_MARKERS);
}

/** NFKC-normalizes and caps size — applied before anything is sent to the model (§0.8, §5.3). */
export function normalizeForModel(text, maxChars = 6000) {
  return (text || '').normalize('NFKC').slice(0, maxChars);
}

/**
 * Builds both body fields from a raw (already HTML-stripped-if-needed) message body.
 * body_full: quotes intact, signature stripped, for LLM context.
 * body_text: quotes AND signature stripped, for hashing/parsers.
 */
export function normalizeBody(rawText) {
  const withoutSig = stripSignature(rawText || '');
  const body_full = withoutSig;
  const body_text = stripSignature(stripQuoted(rawText || ''));
  return { body_full, body_text };
}
