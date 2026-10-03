'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parseMessage } = require('./mime');
const { buildBlocks } = require('./normalize');
const { sha256, derivedId } = require('../core/hash');
const { audit } = require('../db/db');

/**
 * Persists one message. Source records are immutable: re-ingesting the same
 * bytes reuses the existing row rather than rewriting it, which is what makes
 * crash/retry during sync safe.
 *
 * Raw MIME goes to a protected local store outside the repository. The database
 * keeps its hash and path, never the bytes.
 */
function storeMessage(db, cfg, clock, msg) {
  const {
    mailboxId, gmailMessageId, gmailThreadId, raw,
    labels = [], direction = 'inbound', observedAt = null,
  } = msg;

  const id = `${mailboxId}:${gmailMessageId}`;
  const rawBuf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
  const rawHash = sha256(rawBuf);

  const existing = db.prepare('SELECT id, raw_hash FROM messages WHERE id = ?').get(id);
  if (existing) return { id, reused: true, changed: existing.raw_hash !== rawHash };

  const dir = path.join(cfg.rawStore, mailboxId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const rawPath = path.join(dir, `${gmailMessageId}.eml`);
  fs.writeFileSync(rawPath, rawBuf, { mode: 0o600 });

  const parsed = parseMessage(rawBuf);
  const norm = buildBlocks(parsed);
  const now = observedAt || clock.nowISO();
  const sourceTs = parseDateHeader(parsed.date);

  db.transaction(() => {
    db.prepare(`INSERT INTO messages (
        id, mailbox_id, gmail_message_id, gmail_thread_id, rfc822_message_id, subject, from_addr,
        to_addrs, direction, gmail_labels, source_ts, observed_ts, raw_hash, raw_path,
        normalized_hash, reply_hash, processing_complete, incomplete_reason, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, mailboxId, gmailMessageId, gmailThreadId || null, parsed.messageId, parsed.subject,
      parsed.from, parsed.to, direction, JSON.stringify(labels), sourceTs, now, rawHash,
      path.relative(cfg.root, rawPath), norm.normalizedHash, norm.replyHash,
      parsed.processingComplete ? 1 : 0, parsed.incompleteReason, now,
    );

    const partIds = {};
    for (const p of parsed.parts) {
      const pid = derivedId('part', id, p.index);
      partIds[p.index] = pid;
      db.prepare(`INSERT INTO message_parts (
          id, message_id, part_index, mime_type, charset, filename, size_bytes,
          decoded_ok, decode_error, extracted_text, provenance)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        pid, id, p.index, p.mimeType, p.charset, p.filename, p.sizeBytes,
        p.decodedOk ? 1 : 0, p.decodeError, p.extractedText, p.provenance,
      );
    }

    for (const b of norm.blocks) {
      db.prepare(`INSERT INTO message_blocks (
          id, message_id, seq, kind, part_id, text, canonical_text, canon_version)
        VALUES (?,?,?,?,?,?,?,?)`).run(
        derivedId('blk', id, b.seq), id, b.seq, b.kind, partIds[b.partIndex] || null,
        b.text, b.canonicalText, b.canonVersion,
      );
    }

    audit(db, {
      at: now, actor: 'ingest', action: 'message_stored', subjectType: 'message', subjectId: id,
      detail: { blocks: norm.blocks.length, parts: parsed.parts.length, complete: parsed.processingComplete },
    });
  })();

  return { id, reused: false, changed: false, blocks: norm.blocks.length, complete: parsed.processingComplete };
}

function parseDateHeader(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function getMessage(db, id) {
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  if (!m) return null;
  m.blocks = db.prepare('SELECT * FROM message_blocks WHERE message_id = ? ORDER BY seq').all(id);
  m.parts = db.prepare('SELECT * FROM message_parts WHERE message_id = ?').all(id);
  return m;
}

module.exports = { storeMessage, getMessage };
