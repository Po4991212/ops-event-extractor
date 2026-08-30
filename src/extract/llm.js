import Anthropic from '@anthropic-ai/sdk';
import { config, llmLiveAllowed } from '../config.js';
import { insertLlmCall } from '../db/queries.js';
import { RECORD_OPS_EVENTS_TOOL } from './schema.js';
import { classificationSystemPrompt, extractionSystemPrompt, READ_EMAIL_TOOL, renderEmailForToolResult } from './prompt.js';

// $/MTok, confirmed 2026-08-29 against platform.claude.com/docs/en/models/overview
// (see docs/research-sources.md). Batch API is 50% off but not used here.
const PRICING = {
  'claude-haiku-4-5-20251001': { in: 1, out: 5 },
  'claude-sonnet-5': { in: 2, out: 10 }
};

function costCents(model, inputTokens, outputTokens) {
  const p = PRICING[model];
  if (!p) return null;
  return ((inputTokens / 1e6) * p.in + (outputTokens / 1e6) * p.out) * 100;
}

let _client = null;
function client() {
  if (!_client) {
    if (!config.anthropic.apiKey) throw new Error('ANTHROPIC_API_KEY is not set. See .env.example.');
    _client = new Anthropic({ apiKey: config.anthropic.apiKey });
  }
  return _client;
}

/**
 * §0.6/ADR 0004: a live-mail message may only reach Anthropic if the
 * mailbox is live AND the agency-approved retention arrangement is
 * confirmed (OPS_LLM_LIVE_APPROVED=true). Synthetic-sourced messages carry
 * no real client data, so they're always allowed — that's what exercises
 * this code path in the default synthetic vertical slice.
 */
export function llmAllowedForMessage(msg) {
  if (!config.anthropic.apiKey) return false;
  return msg.source === 'synthetic' || llmLiveAllowed();
}

/** tool_use/tool_result turn pair that delivers the email as untrusted data, not plain text (§5.3, ADR 0004). */
function buildEmailTurns(msg, todayIso) {
  const toolUseId = 'toolu_read_email_0';
  return [
    { role: 'user', content: 'Process the operational email available via the read_email tool.' },
    { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'read_email', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text: renderEmailForToolResult(msg, todayIso) }] }] }
  ];
}

async function callTool({ database, msg, purpose, model, system, tools, forcedTool, extraMessages = [] }) {
  const started = Date.now();
  let res;
  try {
    res = await client().messages.create({
      model,
      max_tokens: 2000,
      system,
      tools,
      tool_choice: { type: 'tool', name: forcedTool },
      messages: [...buildEmailTurns(msg, extraMessages.today), ...extraMessages.append]
    });
  } catch (err) {
    if (database) {
      insertLlmCall(database, {
        msg_id: msg.id, purpose, model, input_tokens: null, output_tokens: null,
        cost_cents: null, latency_ms: Date.now() - started, ok: 0, error: String(err?.message || err),
        created_at: Date.now()
      });
    }
    throw err;
  }
  const latency_ms = Date.now() - started;
  const inTok = res.usage?.input_tokens ?? 0;
  const outTok = res.usage?.output_tokens ?? 0;
  if (database) {
    insertLlmCall(database, {
      msg_id: msg.id, purpose, model, input_tokens: inTok, output_tokens: outTok,
      cost_cents: costCents(model, inTok, outTok), latency_ms, ok: 1, created_at: Date.now()
    });
  }
  const block = res.content.find(c => c.type === 'tool_use' && c.name === forcedTool);
  return block?.input ?? null;
}

const CLASSIFY_TOOL = {
  name: 'classify_email',
  description: 'Classifies whether an email states or implies an operational obligation.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      is_operational: { type: 'boolean' },
      kind_guess: { type: ['string', 'null'] }
    },
    required: ['is_operational', 'kind_guess'],
    additionalProperties: false
  }
};

/** Cheap tier (§5.1): is this operational, and roughly which kind? */
export async function classify(msg, { database } = {}) {
  const input = await callTool({
    database, msg, purpose: 'classify',
    model: config.anthropic.classificationModel,
    system: classificationSystemPrompt(),
    tools: [READ_EMAIL_TOOL, CLASSIFY_TOOL],
    forcedTool: 'classify_email',
    extraMessages: { today: undefined, append: [] }
  });
  return input ?? { is_operational: false, kind_guess: null };
}

/** Extraction tier (§5.1/§5.2): only for messages classification flagged operational and no parser claimed. */
export async function extract(msg, { today, database } = {}) {
  const input = await callTool({
    database, msg, purpose: 'extract',
    model: config.anthropic.extractionModel,
    system: extractionSystemPrompt(),
    tools: [READ_EMAIL_TOOL, RECORD_OPS_EVENTS_TOOL],
    forcedTool: 'record_ops_events',
    extraMessages: { today, append: [] }
  });
  return (input?.events ?? []).map(e => ({ ...e, extractor: 'llm', extractor_ref: config.anthropic.extractionModel }));
}
