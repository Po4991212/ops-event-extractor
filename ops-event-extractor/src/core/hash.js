'use strict';
const crypto = require('node:crypto');

function sha256(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Stable id derived from its parts, so replay produces identical ids. */
function derivedId(prefix, ...parts) {
  return `${prefix}_${sha256(parts.map((p) => String(p)).join('\u0000')).slice(0, 24)}`;
}

module.exports = { sha256, derivedId };
