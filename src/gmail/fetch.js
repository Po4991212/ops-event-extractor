import { contentHash } from '../dedup/hash.js';
import { htmlToText, normalizeBody } from '../normalize/text.js';

function header(headers, name) {
  return headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
}

function decodeB64Url(data) {
  if (!data) return '';
  return Buffer.from(data, 'base64url').toString('utf8');
}

/** Recursively walks Gmail's MIME part tree, preferring text/plain and falling back to text/html. */
function extractBody(payload) {
  let plain = null;
  let html = null;
  const walk = (part) => {
    if (!part) return;
    if (part.mimeType === 'text/plain' && part.body?.data) plain ??= decodeB64Url(part.body.data);
    if (part.mimeType === 'text/html' && part.body?.data) html ??= decodeB64Url(part.body.data);
    for (const child of part.parts || []) walk(child);
  };
  walk(payload);
  if (plain) return plain;
  if (html) return htmlToText(html);
  return decodeB64Url(payload?.body?.data) || '';
}

function parseAddrList(headerValue) {
  if (!headerValue) return [];
  return headerValue.split(',').map(s => s.trim()).filter(Boolean);
}

function fromDomain(fromAddr) {
  const m = /@([^\s>]+)/.exec(fromAddr || '');
  return m ? m[1].toLowerCase() : '';
}

function attachmentNames(payload) {
  const names = [];
  const walk = (part) => {
    if (!part) return;
    if (part.filename) names.push(part.filename);
    for (const child of part.parts || []) walk(child);
  };
  walk(payload);
  return names;
}

/** Converts a Gmail API `users.messages.get(format=full)` response into a `messages` table row. */
export function toRecord(full) {
  const headers = full.payload?.headers || [];
  const fromAddr = header(headers, 'From') || '';
  const subject = header(headers, 'Subject') || '';
  const rawBody = extractBody(full.payload);
  const { body_full, body_text } = normalizeBody(rawBody);

  const record = {
    id: full.id,
    thread_id: full.threadId,
    history_id: full.historyId ? String(full.historyId) : null,
    internal_date: Number(full.internalDate),
    from_addr: fromAddr,
    from_domain: fromDomain(fromAddr),
    to_addrs: JSON.stringify(parseAddrList(header(headers, 'To'))),
    cc_addrs: JSON.stringify(parseAddrList(header(headers, 'Cc'))),
    subject,
    label_ids: JSON.stringify(full.labelIds || []),
    body_text,
    body_full,
    attachment_names: JSON.stringify(attachmentNames(full.payload)),
    source: 'gmail',
    fetched_at: Date.now()
  };
  record.content_hash = contentHash(record);
  return record;
}
