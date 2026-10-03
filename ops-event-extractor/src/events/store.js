'use strict';
const { derivedId } = require('../core/hash');
const { audit } = require('../db/db');
const { identityKey, findLinkCandidates, revisionReason } = require('./identity');

/**
 * Writes accepted candidates into the obligation model.
 *
 * Nothing here ever overwrites an earlier fact. A changed amount or date
 * becomes a new version with a supersession link and a reason, so the history
 * of what the carrier said, and when, survives reprocessing.
 */
function acceptCandidate(db, clock, {
  candidateId, message, event, resolution, gateResult, confidence, source, parserVersion,
}) {
  const accountId = resolution.accountId || null;
  const policyRef = (event.account_hints.policy_refs || [])[0] || null;

  // An exact identity hit wins; otherwise look for a related obligation to link.
  const key = identityKey(event, { accountId, policyRef, termRef: null, messageId: message.id });
  let obligation = db.prepare('SELECT * FROM obligations WHERE identity_key = ?').get(key);
  let linkReason = 'original';
  let ambiguousLink = false;

  if (!obligation && accountId) {
    const { candidates, ambiguous } = findLinkCandidates(db, event, { accountId, policyRef });
    if (candidates.length === 1 || (candidates.length > 1 && !ambiguous)) {
      obligation = candidates[0].obligation;
      linkReason = 'cross_thread';
    } else if (candidates.length > 1) {
      ambiguousLink = true;
    }
  }

  const now = clock.nowISO();
  let created = false;

  if (!obligation) {
    const id = key;
    db.prepare(`INSERT INTO obligations
      (id, identity_key, account_id, policy_ref, term_ref, kind, obligation_subject, object_key, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,'active',?)`).run(
      id, key, accountId, policyRef, null, event.kind, event.obligation, event.object_key, now,
    );
    obligation = db.prepare('SELECT * FROM obligations WHERE id = ?').get(id);
    created = true;
  }

  const prevVersion = db.prepare(
    'SELECT * FROM event_versions WHERE obligation_id = ? ORDER BY version DESC LIMIT 1',
  ).get(obligation.id);
  const prevPayload = prevVersion ? JSON.parse(prevVersion.payload_json) : null;

  // A later message that is silent about a field does not retract it. The
  // original notice stated a premium; a colleague forwarding that notice says
  // nothing about the premium, and treating silence as a correction would
  // quietly erase the figure the carrier actually sent. Carry established
  // facts forward, along with the evidence that established them, and let only
  // a stated value overwrite a stated value.
  const CARRIED = ['stated_deadline', 'amount', 'currency', 'object_key'];
  const carriedForward = [];
  const merged = { ...event };
  if (prevPayload) {
    for (const f of CARRIED) {
      if ((merged[f] === null || merged[f] === undefined) && prevPayload[f] !== null && prevPayload[f] !== undefined) {
        merged[f] = prevPayload[f];
        carriedForward.push(f);
      }
    }
  }
  const diffs = prevPayload ? revisionReason(prevPayload, merged) : [];
  // Keep the wording that is already on file when nothing material changed.
  if (prevPayload && !diffs.length && prevPayload.obligation) merged.obligation = prevPayload.obligation;

  let versionRow = prevVersion;
  if (!prevVersion || diffs.length) {
    const version = prevVersion ? prevVersion.version + 1 : 1;
    const vid = derivedId('ver', obligation.id, String(version));
    db.prepare(`INSERT INTO event_versions
      (id, obligation_id, version, payload_json, supersedes_id, reason, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      vid, obligation.id, version, JSON.stringify(merged), prevVersion ? prevVersion.id : null,
      prevVersion ? `revised fields: ${diffs.join(', ')}` : 'initial extraction',
      source === 'parser' ? `parser:${parserVersion}` : `model:${parserVersion}`, now,
    );
    db.prepare('UPDATE obligations SET current_version_id = ? WHERE id = ?').run(vid, obligation.id);
    versionRow = db.prepare('SELECT * FROM event_versions WHERE id = ?').get(vid);

    // Evidence for a carried-forward field is copied from the version that
    // established it, keeping its original source message. The new version is
    // therefore still fully substantiated, and the trail points at the message
    // that actually said it.
    for (const f of carriedForward) {
      const prior = db.prepare(`SELECT * FROM evidence WHERE event_version_id = ? AND field_path = ?`)
        .get(prevVersion.id, f);
      if (!prior) continue;
      db.prepare(`INSERT OR REPLACE INTO evidence
        (id, event_version_id, field_path, nature, source_message_id, block_id, part_ref, quote,
         start_offset, end_offset, canon_version, derivation_rule, lookup_provenance, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        derivedId('evd', vid, f), vid, f, prior.nature, prior.source_message_id, prior.block_id,
        prior.part_ref, prior.quote, prior.start_offset, prior.end_offset, prior.canon_version,
        prior.derivation_rule, prior.lookup_provenance, now,
      );
    }

    for (const ev of gateResult.evidence) {
      db.prepare(`INSERT INTO evidence
        (id, event_version_id, field_path, nature, source_message_id, block_id, part_ref, quote,
         start_offset, end_offset, canon_version, derivation_rule, lookup_provenance, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        derivedId('evd', vid, ev.path), vid, ev.path, ev.nature, message.id, ev.span.blockId, null,
        ev.span.quote, ev.span.start, ev.span.end, ev.span.canonVersion,
        ev.path === 'stated_deadline' ? `date_phrase_to_iso@${clock.zone}` : null, null, now,
      );
    }
    // The resolved account is a lookup result, not something the email said.
    if (resolution.accountId) {
      db.prepare(`INSERT INTO evidence
        (id, event_version_id, field_path, nature, source_message_id, quote, canon_version, lookup_provenance, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(
        derivedId('evd', vid, 'account_id'), vid, 'account_id', 'derived', message.id, null, null,
        `qq_index:${resolution.method}: ${resolution.reason}`, now,
      );
    }
  }

  db.prepare(`INSERT OR IGNORE INTO source_links (id, obligation_id, message_id, link_reason, created_at)
    VALUES (?,?,?,?,?)`).run(
    derivedId('slnk', obligation.id, message.id), obligation.id, message.id,
    created ? 'original' : (diffs.length ? 'revision' : linkReason === 'cross_thread' ? 'cross_thread' : 'forward'), now,
  );

  db.prepare('UPDATE candidate_events SET status = ?, confidence = ? WHERE id = ?')
    .run('accepted', confidence.score, candidateId);

  // Denormalized onto the obligation so the review queue can select on it.
  // A later message that raises confidence updates it; nothing lowers a
  // reviewer's own decision, which is recorded separately.
  db.prepare(`UPDATE obligations SET confidence = ?, band = COALESCE(?, band), account_name = COALESCE(?, account_name),
      stated_deadline = COALESCE(?, stated_deadline), updated_at = ?
    WHERE id = ?`).run(
    confidence.score, confidence.band, resolution.accountName || null,
    merged.stated_deadline || null, now, obligation.id,
  );

  audit(db, {
    at: now, actor: source === 'parser' ? `parser:${parserVersion}` : `model:${parserVersion}`,
    action: created ? 'obligation_created' : (diffs.length ? 'obligation_revised' : 'obligation_source_linked'),
    subjectType: 'obligation', subjectId: obligation.id,
    detail: { messageId: message.id, kind: event.kind, diffs, carriedForward, confidence: confidence.score, ambiguousLink },
  });

  return { obligationId: obligation.id, versionId: versionRow.id, created, revised: diffs.length > 0, ambiguousLink };
}

function quarantineCandidate(db, clock, { candidateId, message, event, gateResult, urgency }) {
  const now = clock.nowISO();
  db.prepare('UPDATE candidate_events SET status = ?, reject_reason = ? WHERE id = ?')
    .run('quarantined', gateResult.failures.map((f) => f.gate).join(','), candidateId);
  const id = derivedId('qtn', candidateId);
  db.prepare(`INSERT OR REPLACE INTO quarantine
    (id, candidate_id, message_id, reason, diagnostic, urgent, created_at) VALUES (?,?,?,?,?,?,?)`).run(
    id, candidateId, message.id, gateResult.failures.map((f) => f.gate).join(','),
    JSON.stringify({ failures: gateResult.failures, warnings: gateResult.warnings, event }),
    urgency.urgent ? 1 : 0, now,
  );
  audit(db, {
    at: now, actor: 'gates', action: 'candidate_quarantined', subjectType: 'quarantine', subjectId: id,
    detail: { messageId: message.id, kind: event.kind, gates: gateResult.failures.map((f) => f.gate), urgent: urgency.urgent },
  });
  return { quarantineId: id };
}

function recordCandidate(db, clock, { message, event, source, routeFamily }) {
  const id = derivedId('cand', message.id, source, event.kind, event.obligation, event.object_key || '');
  db.prepare(`INSERT OR REPLACE INTO candidate_events
    (id, message_id, source, route_family, kind, payload_json, status, created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    id, message.id, source, routeFamily, event.kind, JSON.stringify(event), 'pending', clock.nowISO(),
  );
  return id;
}

module.exports = { acceptCandidate, quarantineCandidate, recordCandidate };
