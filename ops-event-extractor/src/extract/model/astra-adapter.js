'use strict';
const http = require('../../core/http');
const credentials = require('../../core/credentials');
const { responsesTextFormat, SCHEMA_VERSION } = require('../schema');
const { toolDefinition, handleCall, TOOL_NAME } = require('./source-tool');
const { developerInstructions, PROMPT_VERSION } = require('./prompt');
const { AppError } = require('../../core/errors');

/**
 * OpenAI Responses API adapter.
 *
 * Verified against the vendor documentation on 2026-09-13:
 *   - the model is selected with model: "gpt-6-astra" on a Responses request
 *   - strict Structured Outputs go in text.format as
 *     { type, name, schema, strict } (Responses), not response_format (Chat)
 *   - reasoning effort is set per request with reasoning.effort
 *
 * Deliberately absent: temperature, top_p and top_logprobs, which do not belong
 * on this model's requests. Also absent: any configuration_update input item.
 * Changing reasoning.effort per request covers everything this application
 * needs, and inventing an input shape is how adapters break on the next
 * documentation change.
 *
 * Snapshot pinning: config.model.snapshot is empty by default. No snapshot
 * string is invented here. When it is empty the adapter records that no
 * immutable snapshot was pinned, which is a real reproducibility limitation and
 * is reported as one.
 */
function buildRequest(cfg, { messageId, stage = 'extract' }) {
  const effort = stage === 'classify' ? cfg.model.effortClassify : cfg.model.effortExtract;
  return {
    model: cfg.model.snapshot || cfg.model.name,
    reasoning: { effort },
    tools: [toolDefinition()],
    tool_choice: 'auto',
    text: { format: responsesTextFormat() },
    input: [
      { role: 'developer', content: developerInstructions() },
      { role: 'user', content: `Extract obligations from message_id ${messageId}. Call ${TOOL_NAME} first.` },
    ],
  };
}

function extractFunctionCalls(response) {
  return (response.output || []).filter((o) => o.type === 'function_call');
}

function extractOutputText(response) {
  if (typeof response.output_text === 'string' && response.output_text) return response.output_text;
  const parts = [];
  for (const item of response.output || []) {
    for (const c of item.content || []) {
      if (c.type === 'output_text' && typeof c.text === 'string') parts.push(c.text);
    }
  }
  return parts.join('');
}

function refusalOf(response) {
  for (const item of response.output || []) {
    for (const c of item.content || []) if (c.type === 'refusal') return c.refusal || 'refused';
  }
  return null;
}

async function post(cfg, body, { requestImpl = http.request, apiKeyAccount = 'openai-api-key' } = {}) {
  const key = credentials.get(apiKeyAccount);
  const res = await requestImpl('POST', `${cfg.model.baseUrl}/responses`, {
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new AppError(`Responses API error ${res.status}`, 'MODEL_HTTP', { status: res.status });
  return JSON.parse(res.text);
}

/**
 * Runs one extraction: request, satisfy the source-tool call, request again,
 * then parse the structured result.
 */
async function extract(cfg, { messageId, blocks, stage = 'extract', requestImpl, apiKeyAccount }) {
  const started = Date.now();
  const body = buildRequest(cfg, { messageId, stage });
  let response = await post(cfg, body, { requestImpl, apiKeyAccount });

  const calls = extractFunctionCalls(response);
  if (calls.length) {
    const followUp = { ...body, input: [...body.input] };
    for (const call of calls) {
      if (call.name !== TOOL_NAME) {
        followUp.input.push({ type: 'function_call_output', call_id: call.call_id,
          output: JSON.stringify({ error: 'unknown function' }) });
        continue;
      }
      const result = handleCall({ authorizedMessageId: messageId, blocks }, call.arguments);
      followUp.input.push({ type: 'function_call', call_id: call.call_id, name: call.name, arguments: call.arguments });
      followUp.input.push({ type: 'function_call_output', call_id: call.call_id, output: result.output });
    }
    response = await post(cfg, followUp, { requestImpl, apiKeyAccount });
  }

  const refusal = refusalOf(response);
  const latencyMs = Date.now() - started;
  const usage = response.usage || {};
  const meta = {
    modelRequested: body.model,
    modelReturned: response.model || null,
    snapshot: cfg.model.snapshot || null,
    snapshotPinned: Boolean(cfg.model.snapshot),
    reasoningEffort: body.reasoning.effort,
    inputTokens: usage.input_tokens ?? null,
    outputTokens: usage.output_tokens ?? null,
    latencyMs,
    promptVersion: PROMPT_VERSION,
    schemaVersion: SCHEMA_VERSION,
  };

  if (refusal) return { status: 'refusal', detail: refusal, meta };

  const text = extractOutputText(response);
  try {
    return { status: 'ok', payload: JSON.parse(text), meta };
  } catch (e) {
    return { status: 'invalid_schema', detail: `output was not valid JSON: ${e.message}`, meta };
  }
}

module.exports = { buildRequest, extract, extractOutputText, extractFunctionCalls, refusalOf, PROMPT_VERSION };
