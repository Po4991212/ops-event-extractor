'use strict';
const http = require('../core/http');
const { AppError } = require('../core/errors');
const credentials = require('../core/credentials');

/**
 * Read-only Gmail access.
 *
 * The scope list below is the whole scope list. Widening it is a deliberate,
 * separately approved change to a separate adapter, not an edit to this array.
 * Local draft text needs no Gmail write scope at all.
 */
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

class GmailAuthError extends AppError {}
class GmailNotFound extends AppError {}
class GmailHistoryExpired extends AppError {}

function jitteredBackoff(attempt) {
  const base = Math.min(1000 * 2 ** attempt, 16000);
  return base / 2 + Math.random() * (base / 2);
}

/**
 * Bounded retry. Transient conditions back off; authorization failures and
 * "gone" responses surface immediately so a sync never spins forever.
 */
async function withRetry(fn, { retries = 4, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onRetry } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try { return await fn(attempt); } catch (err) {
      if (err instanceof GmailAuthError || err instanceof GmailNotFound || err instanceof GmailHistoryExpired) throw err;
      lastErr = err;
      if (attempt === retries) break;
      if (onRetry) onRetry(attempt, err);
      await sleep(jitteredBackoff(attempt));
    }
  }
  throw lastErr;
}

/** Live transport. Every request passes through the capability allowlist. */
class GmailHttpTransport {
  constructor({ userId, accessTokenAccount = 'gmail-access-token', requestImpl = http.request } = {}) {
    this.userId = userId;
    this.accessTokenAccount = accessTokenAccount;
    this.requestImpl = requestImpl;
    this.base = 'https://gmail.googleapis.com/gmail/v1/users';
  }

  async #get(pathAndQuery) {
    const token = credentials.get(this.accessTokenAccount);
    const url = `${this.base}/${encodeURIComponent(this.userId)}${pathAndQuery}`;
    const res = await this.requestImpl('GET', url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401 || res.status === 403) throw new GmailAuthError(`Gmail auth failed (${res.status})`, 'GMAIL_AUTH');
    if (res.status === 404) throw new GmailNotFound('Gmail resource not found', 'GMAIL_404');
    if (!res.ok) throw new AppError(`Gmail request failed (${res.status})`, 'GMAIL_HTTP', { status: res.status });
    return JSON.parse(res.text);
  }

  async getProfile() { return this.#get('/profile'); }

  async listMessages({ pageToken = null, q = null, includeSpamTrash = true, maxResults = 100 } = {}) {
    const params = new URLSearchParams({ maxResults: String(maxResults), includeSpamTrash: String(includeSpamTrash) });
    if (pageToken) params.set('pageToken', pageToken);
    if (q) params.set('q', q);
    return this.#get(`/messages?${params}`);
  }

  async getMessageRaw(id) {
    const res = await this.#get(`/messages/${encodeURIComponent(id)}?format=raw`);
    return { ...res, raw: Buffer.from(res.raw, 'base64url') };
  }

  async listHistory({ startHistoryId, pageToken = null, maxResults = 100 }) {
    const params = new URLSearchParams({ startHistoryId: String(startHistoryId), maxResults: String(maxResults) });
    if (pageToken) params.set('pageToken', pageToken);
    try {
      return await this.#get(`/history?${params}`);
    } catch (err) {
      // Gmail returns 404 when the supplied history id is too old to serve.
      if (err instanceof GmailNotFound) throw new GmailHistoryExpired('history id expired', 'GMAIL_HISTORY_EXPIRED');
      throw err;
    }
  }
}

module.exports = { SCOPES, GmailHttpTransport, GmailAuthError, GmailNotFound, GmailHistoryExpired, withRetry, jitteredBackoff };
