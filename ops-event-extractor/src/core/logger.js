'use strict';
/**
 * Redacting logger. Logs carry metadata and counts, never message bodies,
 * quotes, credentials or subjects. Anything resembling a secret or an address
 * is masked before it reaches a sink.
 */
const SECRETISH = [
  /\b(sk|rk|pk)-[A-Za-z0-9_-]{12,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{8,}/gi,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /\b\d{3}-\d{2}-\d{4}\b/g,
];
const BODY_FIELDS = new Set(['body', 'text', 'html', 'quote', 'subject', 'raw', 'snippet', 'apiKey', 'token', 'password', 'secret']);

function redactValue(v) {
  if (typeof v !== 'string') return v;
  let out = v;
  for (const re of SECRETISH) out = out.replace(re, '[redacted]');
  return out.length > 200 ? `${out.slice(0, 200)}…[truncated]` : out;
}

function redact(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = BODY_FIELDS.has(k) ? '[redacted]' : redact(v);
    }
    return out;
  }
  return redactValue(obj);
}

function make(level = 'info', sink = console) {
  const order = { debug: 10, info: 20, warn: 30, error: 40 };
  const emit = (lvl) => (event, fields = {}) => {
    if (order[lvl] < order[level]) return;
    const line = JSON.stringify({ at: new Date().toISOString(), level: lvl, event, ...redact(fields) });
    if (lvl === 'error') sink.error(line); else sink.log(line);
  };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error'), redact };
}

module.exports = { make, redact };
