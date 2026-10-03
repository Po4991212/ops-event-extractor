'use strict';
const { CapabilityError } = require('./errors');

/**
 * Central HTTP capability allowlist.
 *
 * OAuth scope alone is not a control: a read-only scope on a token does not
 * stop code from calling a delivery endpoint and getting a 403 that someone
 * later "fixes" by widening the scope. Every outbound request in this
 * application goes through here first, and anything not explicitly listed is
 * refused before a socket is opened.
 */
const ALLOW = [
  {
    id: 'gmail-read',
    host: 'gmail.googleapis.com',
    methods: ['GET'],
    pathPrefixes: ['/gmail/v1/users/'],
    // GET-only, so no delivery endpoint is reachable through this entry.
  },
  {
    id: 'google-oauth-token',
    host: 'oauth2.googleapis.com',
    methods: ['POST'],
    pathPrefixes: ['/token'],
  },
  {
    id: 'openai-responses',
    host: 'api.openai.com',
    methods: ['POST'],
    pathPrefixes: ['/v1/responses'],
  },
  {
    id: 'qq-catalyst',
    host: 'api.qqcatalyst.com',
    methods: ['GET', 'POST', 'PUT'],
    pathPrefixes: ['/v1/'],
    // Mutating verbs here are additionally gated by the two-switch write guard.
  },
];

/** Extra belt: refuse any path that names a delivery endpoint, whatever the host. */
const REFUSED_PATH_FRAGMENTS = require('../../policy/runtime-refused-paths.json').fragments;

function check(method, url, { allow = ALLOW } = {}) {
  let u;
  try { u = new URL(url); } catch { throw new CapabilityError(`Malformed URL refused: ${url}`, 'HTTP_BAD_URL'); }
  if (u.protocol !== 'https:') throw new CapabilityError(`Non-HTTPS refused: ${u.protocol}`, 'HTTP_NOT_HTTPS');

  const lowerPath = u.pathname.toLowerCase();
  for (const frag of REFUSED_PATH_FRAGMENTS) {
    if (lowerPath.includes(frag)) {
      throw new CapabilityError(`Refused outbound-delivery path fragment "${frag}"`, 'HTTP_DELIVERY_REFUSED', { url: u.pathname });
    }
  }

  const m = String(method).toUpperCase();
  const hit = allow.find((a) => a.host === u.hostname
    && a.methods.includes(m)
    && a.pathPrefixes.some((p) => u.pathname.startsWith(p)));
  if (!hit) {
    throw new CapabilityError(`No capability entry for ${m} ${u.hostname}${u.pathname}`, 'HTTP_NOT_ALLOWLISTED',
      { host: u.hostname, method: m });
  }
  return hit.id;
}

/** The only HTTP entry point the application uses. */
async function request(method, url, { headers = {}, body = null, timeoutMs = 60000, fetchImpl = globalThis.fetch } = {}) {
  const capability = check(method, url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method, headers, body: body === null ? undefined : body, signal: ctrl.signal,
    });
    const text = await res.text();
    return { capability, status: res.status, ok: res.ok, text, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { check, request, ALLOW };
