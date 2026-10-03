'use strict';
const { derivedId } = require('../core/hash');
const { audit } = require('../db/db');
const { route, loadSources } = require('./router');
const { byFamily } = require('./parsers');
const { runGates, urgencyOf } = require('./gates');
const { score, band } = require('./confidence');
const { resolve, record: recordResolution } = require('../resolve/account-resolver');
const { acceptCandidate, quarantineCandidate, recordCandidate } = require('../events/store');
const { upsertTask, markUrgent } = require('../tasks/tasks');
const { getMessage } = require('../ingest/store');
const learned = require('./learned/patterns');
const categories = require('./categorize');

/**
 * One message in, zero or more obligations out.
 *
 * The ordering is the safety property: extract, then ground, then resolve the
 * account, then decide. Nothing becomes a task before its evidence has been
 * checked against the source it claims to come from.
 */
function attempt(db, clock, messageId, stage, fields) {
  // An attempt is an event, not a fact about the message. Reprocessing appends
  // another one; it must never collide with the last. Keying these by content
  // made a second pass over the same mailbox throw instead of being a no-op.
  const seq = db.prepare('SELECT COUNT(*) c FROM processing_attempts WHERE message_id = ? AND stage = ?')
    .get(messageId, stage).c + 1;
  db.prepare(`INSERT INTO processing_attempts
    (id, message_id, stage, route_family, status, detail, parser_version, prompt_version, schema_version, input_hash, started_at, finished_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    derivedId('att', messageId, stage, String(seq)),
    messageId, stage, fields.family || null, fields.status, fields.detail || null,
    fields.parserVersion || null, fields.promptVersion || null, fields.schemaVersion || null,
    fields.inputHash || null, clock.nowISO(), clock.nowISO(),
  );
}

function earliestReceipt(db, obligationId, fallbackISO) {
  const row = db.prepare(`SELECT MIN(COALESCE(m.source_ts, m.observed_ts)) AS first_seen
    FROM source_links sl JOIN messages m ON m.id = sl.message_id WHERE sl.obligation_id = ?`).get(obligationId);
  return (row && row.first_seen) || fallbackISO;
}

function applySignals(db, clock, message, signals) {
  for (const s of signals) {
    const id = derivedId('sig', message.id, s.type);
    db.prepare(`INSERT OR REPLACE INTO signals
      (id, message_id, type, policy_ref, account_hint, detail_json, occurred_at, created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      id, message.id, s.type, s.policy_ref || null, s.account_hint || null,
      JSON.stringify(s.detail || {}), message.source_ts || message.observed_ts, clock.nowISO(),
    );

    if (s.type === 'bind_observed') {
      // A bind discussion does not close a condition and does not assert that
      // coverage is in force. It raises the priority of anything still open.
      const rows = db.prepare(`SELECT t.id FROM tasks t JOIN obligations o ON o.id = t.obligation_id
        WHERE o.kind = 'condition_precedent' AND t.status IN ('open','awaiting_response','escalated')
          AND (o.policy_ref = ? OR ? IS NULL)`).all(s.policy_ref || null, s.policy_ref || null);
      for (const r of rows) {
        markUrgent(db, clock, r.id, 'bind discussion observed while a binding condition is unanswered');
      }
    }
  }
}

function processEvents(db, cfg, clock, message, blocks, events, { source, version, family }) {
  const out = { accepted: [], quarantined: [], tasks: [] };

  for (const event of events) {
    const candidateId = recordCandidate(db, clock, { message, event, source, routeFamily: family });

    const hints = event.account_hints || {};
    const resolution = resolve(db, {
      policyRefs: hints.policy_refs, names: hints.names, zips: hints.zips,
      quotedOnlyNames: hints.quoted_only_names,
    });
    recordResolution(db, clock, message.id, resolution);

    const bindObserved = Boolean(db.prepare(
      "SELECT 1 FROM signals WHERE type='bind_observed' AND (policy_ref = ? OR ? IS NULL) LIMIT 1",
    ).get((hints.policy_refs || [])[0] || null, (hints.policy_refs || [])[0] || null));

    const gateResult = runGates(event, { blocks, message, resolution, zone: cfg.timezone });
    const urgency = urgencyOf(event, { bindObserved });

    if (!gateResult.ok) {
      const q = quarantineCandidate(db, clock, { candidateId, message, event, gateResult, urgency });
      out.quarantined.push({ ...q, kind: event.kind, gates: gateResult.failures.map((f) => f.gate), urgent: urgency.urgent });
      continue;
    }

    const conf = score(event, { resolution, gateResult, source, message });
    const b = band(conf.score, cfg.thresholds);

    const accepted = acceptCandidate(db, clock, {
      candidateId, message, event, resolution, gateResult,
      confidence: { ...conf, band: b }, source, parserVersion: version,
    });
    out.accepted.push({ ...accepted, kind: event.kind, confidence: conf.score, band: b, event });

    // Only a unique supported account match may create an automatic task.
    // Everything else still gets a visible task, in a review state.
    const reviewOnly = b !== 'auto' || resolution.requiresReview || !resolution.accountId || accepted.ambiguousLink;
    const receipt = earliestReceipt(db, accepted.obligationId, message.source_ts || message.observed_ts);
    const t = upsertTask(db, cfg, clock, {
      obligationId: accepted.obligationId, kind: event.kind, event, receiptISO: receipt,
      urgent: urgency, reviewOnly,
    });
    out.tasks.push({ ...t, reviewOnly, band: b, confidence: conf.score });
  }

  return out;
}

/**
 * Extracts, then files the email under one of the agency's eighteen categories.
 * Categorizing comes last because a grounded obligation is the best evidence
 * of what an email is about.
 */
async function processMessage(db, cfg, clock, messageId, opts = {}) {
  const out = await extractMessage(db, cfg, clock, messageId, opts);
  const message = getMessage(db, messageId);
  const c = categories.categorize(message, out, { sources: opts.sources || undefined });
  categories.record(db, clock, messageId, c);

  // Learn only from model answers that passed every evidence gate, and never
  // from a suspicious email: the first version learned a pattern from a
  // lookalike "TWIA" sender, which would have taught the system to trust it.
  if (cfg.learnedPatterns && cfg.learnedPatterns.enabled && out.modelStatus === 'ok' && !c.suspicious) {
    for (const a of out.accepted) learned.learn(db, cfg, clock, { message, event: a.event, family: out.routing.family });
  }
  return { ...out, category: c };
}

async function extractMessage(db, cfg, clock, messageId, { sources = null, modelExtractor = null, log } = {}) {
  const message = getMessage(db, messageId);
  if (!message) throw new Error(`unknown message ${messageId}`);
  const blocks = message.blocks;
  const src = sources || loadSources();

  const routing = route(message, blocks, src);
  attempt(db, clock, messageId, 'route', { status: 'ok', family: routing.family, detail: routing.reason });

  if (routing.route === 'noise') {
    audit(db, { at: clock.nowISO(), actor: 'router', action: 'message_filtered_as_noise',
      subjectType: 'message', subjectId: messageId, detail: { family: routing.family, reason: routing.reason } });
    return { routing, events: 0, accepted: [], quarantined: [], tasks: [], deferred: false };
  }

  let parsed = null;
  if (routing.route === 'family') {
    const parser = byFamily.get(routing.family);
    parsed = parser.parse(message, blocks, { zone: cfg.timezone, cfg });
    attempt(db, clock, messageId, 'parse', {
      status: parsed.payload.events.length ? 'ok' : 'no_match',
      family: routing.family, parserVersion: parser.version,
      schemaVersion: parsed.payload.schema_version,
      detail: parsed.payload.no_obligation_reason,
    });
    if (parsed.signals && parsed.signals.length) applySignals(db, clock, message, parsed.signals);
  }

  const parserFoundNothing = !parsed || parsed.payload.events.length === 0;
  const hasSignals = Boolean(parsed && parsed.signals && parsed.signals.length);

  if (parserFoundNothing && !hasSignals) {
    const lp = cfg.learnedPatterns && cfg.learnedPatterns.enabled;

    // An approved learned pattern that reads this message replaces the model
    // call, except on a periodic spot check, where the model reads it too and
    // its answer wins.
    let spotCheck = null;
    if (lp) {
      const hit = learned.approvedMatch(db, cfg, { message, blocks });
      if (hit) {
        const due = learned.countUse(db, clock, hit.pattern, cfg.learnedPatterns.spotCheckEvery);
        if (due && modelExtractor) {
          spotCheck = hit;
        } else {
          attempt(db, clock, messageId, 'learned', { status: 'ok', family: routing.family,
            detail: `approved pattern ${hit.pattern.id}; model call skipped` });
          const res = processEvents(db, cfg, clock, message, blocks, [hit.event],
            { source: 'learned', version: hit.pattern.id, family: routing.family });
          return { routing, events: 1, ...res, deferred: false, learnedPattern: hit.pattern.id };
        }
      }
    }

    if (!modelExtractor) {
      // Parser-only mode. A known sender with an unrecognized template is not
      // discarded: it is recorded as awaiting model extraction / review.
      attempt(db, clock, messageId, 'model', { status: 'deferred', family: routing.family,
        detail: 'parser produced no events and model extraction was not enabled' });
      return { routing, events: 0, accepted: [], quarantined: [], tasks: [], deferred: true };
    }
    const modelResult = await modelExtractor(message, blocks);
    attempt(db, clock, messageId, 'model', {
      status: modelResult.status, family: routing.family,
      promptVersion: modelResult.promptVersion, schemaVersion: modelResult.schemaVersion,
      inputHash: modelResult.inputHash, detail: modelResult.detail || null,
    });
    if (modelResult.status !== 'ok') {
      if (spotCheck) {
        // The check could not run; the approved pattern still stands for this one.
        const res = processEvents(db, cfg, clock, message, blocks, [spotCheck.event],
          { source: 'learned', version: spotCheck.pattern.id, family: routing.family });
        return { routing, events: 1, ...res, deferred: false, learnedPattern: spotCheck.pattern.id, modelStatus: modelResult.status };
      }
      return { routing, events: 0, accepted: [], quarantined: [], tasks: [], deferred: true, modelStatus: modelResult.status };
    }
    const modelEvents = modelResult.payload.events;
    if (spotCheck) {
      const c = learned.compare(spotCheck.event, modelEvents);
      const fresh = learned.recordTrial(db, clock, spotCheck.pattern, message, 'spot_check', c.agree ? 'agree' : 'disagree', c.detail);
      if (fresh && !c.agree) {
        learned.setStatus(db, clock, spotCheck.pattern, 'suspended',
          `spot check disagreed with the model on ${message.id}`, 'learned-patterns');
      }
    }
    if (lp) learned.shadowCompare(db, cfg, clock, { message, blocks, modelEvents });

    const res = processEvents(db, cfg, clock, message, blocks, modelEvents,
      { source: 'model', version: cfg.model.name, family: routing.family });

    return { routing, events: modelEvents.length, ...res, deferred: false, modelStatus: 'ok' };
  }

  const res = parsed.payload.events.length
    ? processEvents(db, cfg, clock, message, blocks, parsed.payload.events,
      { source: 'parser', version: byFamily.get(routing.family).version, family: routing.family })
    : { accepted: [], quarantined: [], tasks: [] };
  return { routing, events: parsed.payload.events.length, ...res, deferred: false };
}

async function processAll(db, cfg, clock, { modelExtractor = null, log, upToISO = null } = {}) {
  const sources = loadSources();
  const rows = upToISO
    ? db.prepare('SELECT id FROM messages WHERE COALESCE(source_ts, observed_ts) <= ? ORDER BY COALESCE(source_ts, observed_ts)').all(upToISO)
    : db.prepare('SELECT id FROM messages ORDER BY COALESCE(source_ts, observed_ts)').all();
  const summary = { messages: 0, events: 0, accepted: 0, quarantined: 0, tasks: 0, deferred: 0, noise: 0 };
  for (const r of rows) {
    const out = await processMessage(db, cfg, clock, r.id, { sources, modelExtractor, log });
    summary.messages += 1;
    summary.events += out.events || 0;
    summary.accepted += (out.accepted || []).length;
    summary.quarantined += (out.quarantined || []).length;
    summary.tasks += (out.tasks || []).length;
    if (out.deferred) summary.deferred += 1;
    if (out.routing.route === 'noise') summary.noise += 1;
  }
  return summary;
}

module.exports = { processMessage, processAll, processEvents, applySignals };
