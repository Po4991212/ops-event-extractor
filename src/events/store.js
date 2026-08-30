import { route } from '../classify/route.js';
import { eventKey } from '../dedup/hash.js';
import { classify, extract, llmAllowedForMessage } from '../extract/llm.js';
import { RawExtraction } from '../extract/schema.js';
import { isoDate } from '../normalize/dates.js';
import { resolveAccount } from '../resolve/account.js';
import { routeStatus, score } from '../score/confidence.js';
import { computeSla } from './sla.js';
import {
  getEvent, insertEvent, insertEventSource, insertReviewQueue, insertRoutingLog, insertTask, supersedeEvent
} from '../db/queries.js';

function todayIsoFor(msg) {
  return isoDate(msg.internal_date);
}

/**
 * Finds an existing, non-superseded event for the *same policy and kind*
 * but a different due_date (§2.3: "the same policy and kind" — this is
 * intentionally narrower than account+kind. An account can legitimately
 * have several distinct concurrent obligations of the same kind (e.g. two
 * separate client_commitment tasks from one call); only a shared policy
 * number is a reliable enough signal that a later message is *updating*
 * the same obligation rather than describing a different one).
 */
function findSupersedeTarget(database, ev) {
  if (!ev.policy_no) return null;
  const rows = database.prepare(`
    SELECT * FROM events WHERE kind = ? AND status != 'superseded' AND event_key != ? AND policy_no = ?
  `).all(ev.kind, ev.event_key, ev.policy_no);
  return rows.find(r => (r.due_date || '') !== (ev.due_date || '')) || null;
}

async function rawEventsFor(database, msg, { today, allowLlm }) {
  const routing = route(msg);
  insertRoutingLog(database, { msg_id: msg.id, handler: routing.handler, parser_name: routing.parser?.name ?? null });

  if (routing.handler === 'noise') return { raw: [], routing };
  if (routing.handler === 'parser') return { raw: routing.parser.parse(msg), routing };

  // LLM path: classify first (cheap tier), extract only if flagged operational (§5.1).
  // `allowLlm` is a *third*, explicit opt-in on top of llmAllowedForMessage()
  // (which only checks whether it's *permitted* — synthetic data always is,
  // by design, per ADR 0004). Cost, not just privacy, needs its own gate:
  // having a working ANTHROPIC_API_KEY in .env must never be enough on its
  // own to make a routine `run`/`replay` silently spend real money. Callers
  // (cli.js) default this to false and require an explicit --llm flag.
  if (!allowLlm) return { raw: [], routing, llmDisabled: true };
  if (!llmAllowedForMessage(msg)) return { raw: [], routing, llmDisabled: true };
  try {
    const cls = await classify(msg, { database });
    if (!cls.is_operational) return { raw: [], routing };
    const raw = await extract(msg, { today, database });
    return { raw, routing };
  } catch (err) {
    // §8: one message's LLM failure (rate limit, transient API error) must
    // not crash a batch run. The failure is already logged to llm_calls
    // (see extract/llm.js callTool); the message is left for a retry pass.
    return { raw: [], routing, llmError: String(err?.message || err) };
  }
}

/**
 * Runs one message through routing → extraction → account resolution →
 * confidence scoring → event/task persistence. Idempotent: every insert is
 * keyed on event_key with INSERT OR IGNORE (§0.2).
 */
export async function processMessage(database, msg, { today = todayIsoFor(msg), allowLlm = false } = {}) {
  const { raw, routing, llmDisabled } = await rawEventsFor(database, msg, { today, allowLlm });
  const results = [];

  for (const r of raw) {
    // §5.2/§9: the LLM (and, as a cross-check, every parser) must emit
    // schema-valid events or fail loudly — never silently persist a
    // malformed row. Checked with safeParse (not .parse()+reassign) so a
    // valid-but-schema-stripped extra field like extractor_ref survives.
    const validation = RawExtraction.safeParse(r);
    if (!validation.success) {
      // eslint-disable-next-line no-console
      console.error(`[schema] discarding malformed extraction from ${r.extractor_ref || routing.parser?.name || 'llm'} on msg ${msg.id}: ${validation.error.message}`);
      results.push({ event_key: null, status: 'discarded', gate: 'schema_invalid' });
      continue;
    }

    const resolution = resolveAccount(r.account_name_raw, { policyNo: r.policy_no });
    const ev = {
      ...r,
      source_msg_id: msg.id,
      source_thread_id: msg.thread_id,
      account_id: resolution.id,
      extracted_at: today,
      extracted_at_date: today
    };
    ev.event_key = eventKey(ev);

    const subjectAndBody = `${msg.subject || ''}\n\n${msg.body_full || ''}`;
    const conf = score(ev, { today, resolution, body: subjectAndBody });
    const status = routeStatus(conf);

    const dbEvent = {
      event_key: ev.event_key,
      source_msg_id: ev.source_msg_id,
      source_thread_id: ev.source_thread_id,
      kind: ev.kind,
      obligation: ev.obligation,
      due_date: ev.due_date,
      due_date_basis: ev.due_date_basis,
      account_name_raw: ev.account_name_raw,
      account_id: ev.account_id,
      owner: null,
      carrier: ev.carrier ?? null,
      policy_no: ev.policy_no ?? null,
      amount_cents: ev.amount_cents ?? null,
      extractor: ev.extractor,
      extractor_ref: ev.extractor_ref,
      confidence: conf.total,
      confidence_parts: JSON.stringify(conf.parts),
      confidence_gate: conf.gate,
      raw_span: ev.raw_span,
      status,
      superseded_by: null,
      // The date this obligation became knowable, not wall-clock processing
      // time: `today` defaults to the message's own date (see
      // todayIsoFor), so a replay run today still reports when the
      // pipeline *would have* surfaced it, which is what the §7.3 recovery
      // tests assert against.
      extracted_at: Date.parse(today)
    };

    if (status === 'discarded') {
      results.push({ event_key: ev.event_key, status, gate: conf.gate });
      continue;
    }

    const alreadyExisted = !!getEvent(database, ev.event_key);
    insertEvent(database, dbEvent);
    insertEventSource(database, { event_key: ev.event_key, source_msg_id: msg.id });

    if (!alreadyExisted) {
      const supersedeTarget = findSupersedeTarget(database, ev);
      if (supersedeTarget) supersedeEvent(database, { oldKey: supersedeTarget.event_key, newKey: ev.event_key });

      if (status === 'queued') {
        insertReviewQueue(database, { event_key: ev.event_key, reason: conf.gate || `confidence ${conf.total.toFixed(2)}`, candidates: resolution.candidates });
      } else if (status === 'auto') {
        const sla = computeSla({ ...ev });
        insertTask(database, {
          event_key: ev.event_key,
          title: ev.obligation,
          due_date: ev.due_date,
          sla_first_action: sla.firstAction,
          sla_escalate: sla.escalate,
          sla_critical: sla.critical,
          owner: null,
          state: 'open',
          qq_note_id: null,
          created_at: Date.now()
        });
      }
    }

    results.push({ event_key: ev.event_key, status, confidence: conf.total });
  }

  return { routing: routing.handler, parser: routing.parser?.name ?? null, llmDisabled: !!llmDisabled, events: results };
}
