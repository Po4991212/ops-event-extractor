'use strict';
const { MAILBOXES, ACCOUNTS, POLICIES, QQ_ACTIVITY, MESSAGES } = require('./corpus-data');
const { GmailNotFound, GmailHistoryExpired } = require('../ingest/gmail-client');
const { storeMessage } = require('../ingest/store');
const { sha256 } = require('../core/hash');

function mimeDate(iso) { return new Date(iso).toUTCString().replace('GMT', '+0000'); }

function encodePlain(spec) {
  if (spec.rawBytesPlain) return Buffer.from(spec.rawBytesPlain);
  return Buffer.from(spec.plain || '', spec.plainCharset === 'windows-1252' ? 'latin1' : 'utf8');
}

/** Assembles an RFC 822 message from a corpus spec. */
function buildRaw(spec) {
  const boundary = `BND${sha256(spec.key).slice(0, 16)}`;
  const headers = [
    `From: ${spec.from}`,
    `To: ${spec.to}`,
    `Subject: ${spec.subject}`,
    `Date: ${mimeDate(spec.date)}`,
    `Message-ID: <${spec.key}@synthetic.example.test>`,
    'MIME-Version: 1.0',
  ];
  const hasHtml = Boolean(spec.html);
  const hasAttachments = Boolean(spec.attachments && spec.attachments.length);
  const plainCharset = spec.plainCharset || 'utf-8';

  if (!hasHtml && !hasAttachments) {
    headers.push(`Content-Type: text/plain; charset=${plainCharset}`);
    return Buffer.concat([Buffer.from(`${headers.join('\r\n')}\r\n\r\n`, 'utf8'), encodePlain(spec)]);
  }

  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const chunks = [Buffer.from(`${headers.join('\r\n')}\r\n\r\n`, 'utf8')];

  const part = (hdrs, body) => {
    chunks.push(Buffer.from(`--${boundary}\r\n${hdrs.join('\r\n')}\r\n\r\n`, 'utf8'));
    chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  };

  part([`Content-Type: text/plain; charset=${plainCharset}`], encodePlain(spec));
  if (hasHtml) part([`Content-Type: text/html; charset=${plainCharset}`], spec.html);
  for (const a of spec.attachments || []) {
    part([
      `Content-Type: ${a.mimeType}; name="${a.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${a.filename}"`,
    ], Buffer.from(a.content).toString('base64'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

/**
 * Gmail-shaped transport over the synthetic corpus. It reproduces the parts of
 * the real API that the sync logic has to survive: paging, a history feed,
 * messages that arrive during a backfill, messages that vanish before they can
 * be fetched, and a history id that has aged out.
 */
class SyntheticTransport {
  constructor({ mailboxId, messages, pageSize = 5, arriveDuringBackfill = [], vanishing = [], historyExpired = false } = {}) {
    this.mailboxId = mailboxId;
    this.pageSize = pageSize;
    this.vanishing = new Set(vanishing);
    this.historyExpired = historyExpired;
    this.calls = { list: 0, get: 0, history: 0, profile: 0 };
    this.startHistory = 900000000000001n;

    this.store = new Map();     // gmail id -> { raw, threadId, labelIds }
    this.listOrder = [];
    this.history = [];          // { id, messagesAdded: [...] }
    this.pendingArrivals = arriveDuringBackfill.slice();

    let h = this.startHistory;
    for (const spec of messages) {
      const id = `g_${sha256(spec.key).slice(0, 14)}`;
      this.store.set(id, {
        raw: buildRaw(spec),
        threadId: `th_${sha256(spec.thread).slice(0, 12)}`,
        labelIds: spec.labels || ['INBOX'],
        key: spec.key,
      });
      this.listOrder.push(id);
      h += 7n;
    }
    this.currentHistory = h;
    this.arrivalsDelivered = false;
  }

  idFor(key) { return `g_${sha256(key).slice(0, 14)}`; }

  async getProfile() {
    this.calls.profile += 1;
    return { emailAddress: this.mailboxId, historyId: String(this.startHistory) };
  }

  async listMessages({ pageToken = null } = {}) {
    this.calls.list += 1;
    const start = pageToken ? Number(pageToken) : 0;
    const slice = this.listOrder.slice(start, start + this.pageSize);
    const next = start + this.pageSize < this.listOrder.length ? String(start + this.pageSize) : null;

    // A message arriving mid-backfill is NOT appended to the list being paged;
    // it lands in the history feed, exactly like the real API.
    if (this.pendingArrivals.length && start > 0 && !this.arrivalsDelivered) {
      for (const spec of this.pendingArrivals) {
        const id = this.idFor(spec.key);
        this.store.set(id, {
          raw: buildRaw(spec),
          threadId: `th_${sha256(spec.thread).slice(0, 12)}`,
          labelIds: spec.labels || ['INBOX'],
          key: spec.key,
        });
        this.currentHistory += 3n;
        this.history.push({ id: String(this.currentHistory), messagesAdded: [{ message: { id, threadId: this.store.get(id).threadId } }] });
      }
      this.arrivalsDelivered = true;
    }

    return { messages: slice.map((id) => ({ id, threadId: this.store.get(id).threadId })), nextPageToken: next };
  }

  async getMessageRaw(id) {
    this.calls.get += 1;
    if (this.vanishing.has(id)) throw new GmailNotFound('message vanished', 'GMAIL_404');
    const m = this.store.get(id);
    if (!m) throw new GmailNotFound('unknown message', 'GMAIL_404');
    return { id, threadId: m.threadId, labelIds: m.labelIds, raw: m.raw };
  }

  async listHistory({ startHistoryId, pageToken = null }) {
    this.calls.history += 1;
    if (this.historyExpired) throw new GmailHistoryExpired('history id expired', 'GMAIL_HISTORY_EXPIRED');
    const after = this.history.filter((r) => BigInt(r.id) > BigInt(startHistoryId));
    const start = pageToken ? Number(pageToken) : 0;
    const slice = after.slice(start, start + this.pageSize);
    const next = start + this.pageSize < after.length ? String(start + this.pageSize) : null;
    return { history: slice, nextPageToken: next, historyId: String(this.currentHistory) };
  }
}

function seedReferenceData(db, clock) {
  const now = clock.nowISO();
  const insAcct = db.prepare(`INSERT OR REPLACE INTO qq_accounts
    (account_id, contact_id, legal_name, normalized_name, zip, aliases_json, fetched_at) VALUES (?,?,?,?,?,?,?)`);
  const { normalizeName } = require('../resolve/normalize-name');
  for (const a of ACCOUNTS) {
    insAcct.run(a.account_id, a.contact_id, a.legal_name, normalizeName(a.legal_name), a.zip,
      JSON.stringify(a.aliases || []), now);
  }
  const insPol = db.prepare(`INSERT OR REPLACE INTO qq_policies
    (policy_number, account_id, carrier, term_start, term_end) VALUES (?,?,?,?,?)`);
  for (const p of POLICIES) insPol.run(p.policy_number, p.account_id, p.carrier, p.term_start, p.term_end);

  const insAct = db.prepare(`INSERT OR REPLACE INTO qq_activity
    (id, account_id, policy_number, type, amount, currency, term_start, term_end, object_key, text, generated_by, occurred_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const a of QQ_ACTIVITY) {
    insAct.run(a.id, a.account_id, a.policy_number || null, a.type, a.amount ?? null, a.currency || null,
      a.term_start || null, a.term_end || null, a.object_key || null, a.text || null, a.generated_by || null, a.occurred_at);
  }
  return { accounts: ACCOUNTS.length, policies: POLICIES.length, activity: QQ_ACTIVITY.length };
}

/** Direct seed used by tests and the offline workflow (no transport involved). */
function seedMessages(db, cfg, clock, { upTo = null, only = null } = {}) {
  const { upsertMailbox } = require('../ingest/sync');
  for (const mb of MAILBOXES) upsertMailbox(db, clock, mb);
  let stored = 0;
  for (const spec of MESSAGES) {
    if (only && !only.includes(spec.key)) continue;
    if (upTo && new Date(spec.date) > new Date(upTo)) continue;
    const raw = buildRaw(spec);
    storeMessage(db, cfg, clock, {
      mailboxId: spec.mailbox,
      gmailMessageId: `g_${sha256(spec.key).slice(0, 14)}`,
      gmailThreadId: `th_${sha256(spec.thread).slice(0, 12)}`,
      raw,
      labels: spec.labels || ['INBOX'],
      direction: spec.direction || 'inbound',
      observedAt: spec.date,
    });
    stored += 1;
  }
  return { stored };
}

/**
 * Maps each label key to the message id it will be stored under. The eval needs
 * this because the corpus key is a property of the fixture, not of a message -
 * a real mailbox has no such field and the schema should not pretend otherwise.
 */
function keyToMessageId() {
  const map = {};
  for (const spec of MESSAGES) map[spec.key] = `${spec.mailbox}:g_${sha256(spec.key).slice(0, 14)}`;
  return map;
}

function messagesFor(mailboxId) { return MESSAGES.filter((m) => m.mailbox === mailboxId); }
function specByKey(key) { return MESSAGES.find((m) => m.key === key); }

module.exports = { buildRaw, SyntheticTransport, seedReferenceData, seedMessages, messagesFor, specByKey, keyToMessageId, MESSAGES, MAILBOXES };
