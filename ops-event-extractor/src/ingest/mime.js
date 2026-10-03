'use strict';

/**
 * Minimal RFC 822 / MIME reader.
 *
 * The rule this file exists to enforce: damaged content is never silently
 * replaced with something that looks fine. If a part cannot be decoded, the
 * part is kept with decoded_ok = 0 and the reason recorded, and the message is
 * marked incomplete so it routes to review instead of being treated as
 * exactly-grounded text.
 */

function splitHeadersBody(buf) {
  const s = buf.toString('latin1'); // byte-preserving scan for the blank line
  const idx = s.search(/\r?\n\r?\n/);
  if (idx === -1) return { headerText: s, body: Buffer.alloc(0) };
  const sep = s.slice(idx).startsWith('\r\n\r\n') ? 4 : 2;
  return { headerText: s.slice(0, idx), body: buf.subarray(idx + sep) };
}

function parseHeaders(headerText) {
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, ' ');
  const headers = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const m = line.match(/^([!-9;-~]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (headers[key] === undefined) headers[key] = m[2];
    else headers[key] = `${headers[key]}, ${m[2]}`;
  }
  return headers;
}

function parseContentType(value = '') {
  const [typePart, ...paramParts] = value.split(';');
  const params = {};
  for (const p of paramParts) {
    const m = p.match(/\s*([\w-]+)\s*=\s*"?([^";]*)"?/);
    if (m) params[m[1].toLowerCase()] = m[2].trim();
  }
  return { mimeType: (typePart || 'text/plain').trim().toLowerCase(), params };
}

function decodeQuotedPrintable(buf) {
  const s = buf.toString('latin1').replace(/=\r?\n/g, '');
  const out = [];
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(s.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(out);
}

function decodeTransfer(buf, encoding) {
  const enc = (encoding || '7bit').toLowerCase().trim();
  if (enc === 'base64') return Buffer.from(buf.toString('latin1').replace(/\s+/g, ''), 'base64');
  if (enc === 'quoted-printable') return decodeQuotedPrintable(buf);
  return buf;
}

/** Decode bytes using the declared charset; report rather than guess on failure. */
function decodeCharset(buf, charset) {
  const cs = (charset || 'utf-8').toLowerCase().replace(/^["']|["']$/g, '');
  try {
    const text = new TextDecoder(cs, { fatal: true }).decode(buf);
    return { text, ok: true, error: null, charsetUsed: cs };
  } catch (e) {
    // Keep something readable for a human, but flag it: this text is NOT
    // suitable as exact evidence and its message is marked incomplete.
    const text = new TextDecoder(cs === 'utf-8' ? 'windows-1252' : 'utf-8', { fatal: false }).decode(buf);
    return { text, ok: false, error: `charset ${cs} failed: ${e.message}`, charsetUsed: `${cs}(lossy)` };
  }
}

/** RFC 2047 encoded-word decoding for header values such as Subject. */
function decodeHeaderWords(value = '') {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (full, cs, enc, data) => {
    try {
      const raw = enc.toUpperCase() === 'B'
        ? Buffer.from(data, 'base64')
        : decodeQuotedPrintable(Buffer.from(data.replace(/_/g, ' '), 'latin1'));
      return decodeCharset(raw, cs).text;
    } catch { return full; }
  });
}

function walkParts(body, contentType, headers, prefix, out, limits) {
  const { mimeType, params } = contentType;
  if (mimeType.startsWith('multipart/') && params.boundary) {
    const marker = `--${params.boundary}`;
    const segments = body.toString('latin1').split(marker);
    let childIndex = 0;
    for (const seg of segments.slice(1)) {
      if (seg.startsWith('--')) break; // closing boundary
      childIndex += 1;
      const segBuf = Buffer.from(seg.replace(/^\r?\n/, ''), 'latin1');
      const { headerText, body: childBody } = splitHeadersBody(segBuf);
      const childHeaders = parseHeaders(headerText);
      const childCt = parseContentType(childHeaders['content-type'] || 'text/plain');
      walkParts(childBody, childCt, childHeaders, prefix ? `${prefix}.${childIndex}` : String(childIndex), out, limits);
    }
    return out;
  }

  const index = prefix || '1';
  const disposition = headers['content-disposition'] || '';
  const filenameMatch = disposition.match(/filename\*?=(?:"([^"]+)"|([^;]+))/i)
    || (params.name ? [null, params.name] : null);
  const filename = filenameMatch ? decodeHeaderWords((filenameMatch[1] || filenameMatch[2] || '').trim()) : null;

  const transferred = decodeTransfer(body, headers['content-transfer-encoding']);
  const isText = mimeType.startsWith('text/');
  const oversized = transferred.length > limits.maxPartBytes;

  const part = {
    index,
    mimeType,
    charset: params.charset || null,
    filename,
    sizeBytes: transferred.length,
    bytes: transferred,
    decodedOk: true,
    decodeError: null,
    extractedText: null,
    provenance: filename ? `attachment:${filename}` : `part:${index}`,
  };

  if (oversized) {
    part.decodedOk = false;
    part.decodeError = `part exceeds ${limits.maxPartBytes} bytes; not extracted`;
  } else if (isText) {
    const dec = decodeCharset(transferred, params.charset);
    part.extractedText = dec.text;
    part.decodedOk = dec.ok;
    part.decodeError = dec.error;
    part.charset = dec.charsetUsed;
  } else if (mimeType === 'application/pdf' || mimeType.startsWith('image/')) {
    // No text extractor is wired up for these. This is recorded as incomplete
    // processing rather than assumed to contain no obligation. OCR is not
    // implemented and is not claimed anywhere as complete.
    part.decodedOk = false;
    part.decodeError = `no text extractor implemented for ${mimeType}`;
  } else if (mimeType === 'message/rfc822') {
    const inner = parseMessage(transferred, limits);
    part.extractedText = inner.parts.map((p) => p.extractedText).filter(Boolean).join('\n\n');
  } else {
    part.decodedOk = false;
    part.decodeError = `unsupported content type ${mimeType}`;
  }

  out.push(part);
  return out;
}

function parseMessage(raw, limits = { maxPartBytes: 5 * 1024 * 1024 }) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
  const { headerText, body } = splitHeadersBody(buf);
  const headers = parseHeaders(headerText);
  const ct = parseContentType(headers['content-type'] || 'text/plain; charset=utf-8');
  const parts = walkParts(body, ct, headers, '', [], limits);
  const incomplete = parts.filter((p) => !p.decodedOk);
  return {
    headers,
    subject: decodeHeaderWords(headers.subject || ''),
    from: headers.from || '',
    to: headers.to || '',
    date: headers.date || null,
    messageId: (headers['message-id'] || '').trim() || null,
    inReplyTo: (headers['in-reply-to'] || '').trim() || null,
    references: (headers.references || '').trim() || null,
    parts,
    processingComplete: incomplete.length === 0,
    incompleteReason: incomplete.length
      ? incomplete.map((p) => `${p.index}:${p.decodeError}`).join('; ')
      : null,
  };
}

module.exports = { parseMessage, parseHeaders, parseContentType, decodeCharset, decodeTransfer, decodeHeaderWords };
