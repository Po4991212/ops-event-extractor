'use strict';
const { storeMessage } = require('./store');
const { audit } = require('../db/db');
const { GmailHistoryExpired, GmailNotFound, withRetry } = require('./gmail-client');

/**
 * Backfill + incremental sync that survives concurrent arrivals.
 *
 * Order matters and is the whole point:
 *   1. capture a history anchor BEFORE the backfill starts
 *   2. run the backfill
 *   3. replay history from the anchor (catches anything that arrived during 2)
 *   4. only then advance the durable checkpoint
 *
 * A crash anywhere before step 4 replays safely, because message storage is
 * idempotent on (mailbox, gmail id) and the checkpoint still points at the
 * last fully-committed position.
 *
 * History ids are opaque strings throughout. They exceed what a JS number can
 * represent exactly, and comparing them numerically is a bug waiting to happen.
 */

function upsertMailbox(db, clock, mailbox) {
  const existing = db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(mailbox.id);
  if (existing) return existing;
  db.prepare(`INSERT INTO mailboxes (id, address, label, configured, created_at) VALUES (?,?,?,?,?)`)
    .run(mailbox.id, mailbox.address, mailbox.label || null, mailbox.configured ? 1 : 0, clock.nowISO());
  return db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(mailbox.id);
}

async function backfill(db, cfg, clock, mailboxId, transport, { query = null, log } = {}) {
  let pageToken = null;
  let pages = 0;
  let stored = 0;
  let reused = 0;
  const unavailable = [];

  do {
    const page = await withRetry(() => transport.listMessages({ pageToken, q: query, includeSpamTrash: true }));
    pages += 1;
    for (const ref of page.messages || []) {
      try {
        const full = await withRetry(() => transport.getMessageRaw(ref.id));
        const res = storeMessage(db, cfg, clock, {
          mailboxId,
          gmailMessageId: ref.id,
          gmailThreadId: full.threadId || ref.threadId || null,
          raw: full.raw,
          labels: full.labelIds || [],
          direction: (full.labelIds || []).includes('SENT') ? 'outbound' : 'inbound',
        });
        if (res.reused) reused += 1; else stored += 1;
      } catch (err) {
        if (err instanceof GmailNotFound) {
          // The message went away between listing and fetching. Record it once
          // and move on; do not retry forever and do not delete anything local.
          unavailable.push(ref.id);
          audit(db, { at: clock.nowISO(), actor: 'sync', action: 'message_unavailable',
            subjectType: 'message', subjectId: `${mailboxId}:${ref.id}`, detail: { phase: 'backfill' } });
          continue;
        }
        throw err;
      }
    }
    pageToken = page.nextPageToken || null;
  } while (pageToken);

  if (log) log.info('backfill_complete', { mailboxId, pages, stored, reused, unavailable: unavailable.length });
  return { pages, stored, reused, unavailable };
}

async function replayHistory(db, cfg, clock, mailboxId, transport, startHistoryId, { log } = {}) {
  let pageToken = null;
  let pages = 0;
  let stored = 0;
  let reused = 0;
  let latest = startHistoryId;
  const removed = [];
  const unavailable = [];

  do {
    const page = await withRetry(() => transport.listHistory({ startHistoryId, pageToken }));
    pages += 1;
    for (const record of page.history || []) {
      for (const added of record.messagesAdded || []) {
        const ref = added.message;
        try {
          const full = await withRetry(() => transport.getMessageRaw(ref.id));
          const res = storeMessage(db, cfg, clock, {
            mailboxId,
            gmailMessageId: ref.id,
            gmailThreadId: full.threadId || ref.threadId || null,
            raw: full.raw,
            labels: full.labelIds || [],
            direction: (full.labelIds || []).includes('SENT') ? 'outbound' : 'inbound',
          });
          if (res.reused) reused += 1; else stored += 1;
        } catch (err) {
          if (err instanceof GmailNotFound) { unavailable.push(ref.id); continue; }
          throw err;
        }
      }
      for (const del of record.messagesDeleted || []) {
        // A message moving or being deleted in Gmail does not erase a local
        // obligation or its evidence. The disappearance is only audited.
        removed.push(del.message.id);
        audit(db, { at: clock.nowISO(), actor: 'sync', action: 'source_message_removed_upstream',
          subjectType: 'message', subjectId: `${mailboxId}:${del.message.id}`, detail: {} });
      }
      if (record.id) latest = String(record.id);
    }
    if (page.historyId) latest = String(page.historyId);
    pageToken = page.nextPageToken || null;
  } while (pageToken);

  if (log) log.info('history_replayed', { mailboxId, pages, stored, reused, removed: removed.length });
  return { pages, stored, reused, removed, unavailable, latestHistoryId: String(latest) };
}

/**
 * `resyncAttempt` bounds the recovery. One full resync is the documented answer
 * to an aged-out history id. A second expiry in a row means the history
 * endpoint is not going to help, and recursing again would spin forever
 * against a permanently unhealthy upstream. The backfill has already stored
 * the mail either way, so the honest outcome is: return what was synchronized
 * and mark the incremental position as stale for an operator to look at.
 */
async function syncMailbox(db, cfg, clock, mailbox, transport,
  { query = null, log, forceFullResync = false, resyncAttempt = 0 } = {}) {
  const row = upsertMailbox(db, clock, mailbox);
  const result = { mailboxId: mailbox.id, backfilled: null, replayed: null, fullResync: false };

  let anchor = row.history_anchor;
  let backfillComplete = Boolean(row.backfill_complete) && !forceFullResync;

  if (!backfillComplete) {
    // Step 1: anchor BEFORE any listing, so concurrent arrivals land in history.
    const profile = await withRetry(() => transport.getProfile());
    anchor = String(profile.historyId);
    db.prepare('UPDATE mailboxes SET history_anchor = ?, backfill_complete = 0 WHERE id = ?').run(anchor, mailbox.id);

    // Step 2: backfill.
    result.backfilled = await backfill(db, cfg, clock, mailbox.id, transport, { query, log });
    db.prepare('UPDATE mailboxes SET backfill_complete = 1 WHERE id = ?').run(mailbox.id);
  }

  // Step 3: replay from the checkpoint if we have one, otherwise from the anchor.
  const fresh = db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(mailbox.id);
  const start = fresh.checkpoint_history_id || fresh.history_anchor;
  try {
    result.replayed = await replayHistory(db, cfg, clock, mailbox.id, transport, start, { log });
    // Step 4: advance the checkpoint only after the message writes committed.
    db.prepare('UPDATE mailboxes SET checkpoint_history_id = ?, last_sync_at = ? WHERE id = ?')
      .run(result.replayed.latestHistoryId, clock.nowISO(), mailbox.id);
  } catch (err) {
    if (err instanceof GmailHistoryExpired) {
      // Documented fallback: the history window no longer covers our position,
      // so re-run a full synchronization. Local data is kept, not truncated.
      audit(db, { at: clock.nowISO(), actor: 'sync', action: 'history_expired_full_resync',
        subjectType: 'mailbox', subjectId: mailbox.id, detail: { attemptedStart: start } });
      if (log) log.warn('history_expired', { mailboxId: mailbox.id });
      db.prepare('UPDATE mailboxes SET backfill_complete = 0, checkpoint_history_id = NULL WHERE id = ?').run(mailbox.id);

      if (resyncAttempt >= 1) {
        audit(db, { at: clock.nowISO(), actor: 'sync', action: 'history_unavailable_after_resync',
          subjectType: 'mailbox', subjectId: mailbox.id, detail: { attemptedStart: start } });
        if (log) log.error('history_unavailable_after_resync', { mailboxId: mailbox.id });
        result.fullResync = true;
        result.historyStale = true;
        result.note = 'full resync completed, but the history endpoint reported expiry again; '
          + 'incremental position is stale and the next run will backfill again';
        return result;
      }

      const retried = await syncMailbox(db, cfg, clock, mailbox, transport,
        { query, log, forceFullResync: true, resyncAttempt: resyncAttempt + 1 });
      retried.fullResync = true;
      return retried;
    }
    throw err;
  }

  return result;
}

module.exports = { syncMailbox, backfill, replayHistory, upsertMailbox };
