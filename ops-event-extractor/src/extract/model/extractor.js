'use strict';
const { derivedId, sha256 } = require('../../core/hash');
const { validateEventPayload } = require('../schema');
const { assertModelTransmissionAllowed } = require('../../config');
const { selectBlocks } = require('./source-tool');
const stub = require('./stub');
const astra = require('./astra-adapter');

/**
 * Chooses the extraction runtime and records what actually happened for every
 * call: which model was requested, which came back, whether a snapshot was
 * pinned, tokens, latency and outcome. Stub results are recorded with the
 * runtime "offline-stub" so no metric built from them can be mistaken for a
 * live measurement.
 */
function makeExtractor(db, cfg, clock, { requestImpl, apiKeyAccount } = {}) {
  return async function modelExtractor(message, blocks) {
    const { kept, omitted } = selectBlocks(blocks);
    const inputHash = sha256(kept.map((b) => `${b.seq}:${b.canonical_text}`).join('\n'));

    let result;
    if (cfg.model.mode === 'astra') {
      assertModelTransmissionAllowed(cfg);
      result = await astra.extract(cfg, { messageId: message.id, blocks: kept, requestImpl, apiKeyAccount });
    } else {
      result = { ...stub.extract(message, kept), meta: stub.meta(cfg) };
    }

    const m = result.meta;
    db.prepare(`INSERT OR REPLACE INTO model_calls
      (id, message_id, stage, model_requested, model_returned, snapshot, reasoning_effort,
       input_tokens, output_tokens, cost_usd, latency_ms, status, prompt_version, schema_version, input_hash, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      derivedId('mc', message.id, inputHash), message.id, 'extract', m.modelRequested, m.modelReturned,
      m.snapshot, m.reasoningEffort, m.inputTokens, m.outputTokens, null, m.latencyMs,
      cfg.model.mode === 'astra' ? result.status : 'stubbed', m.promptVersion, m.schemaVersion,
      inputHash, clock.nowISO(),
    );

    if (result.status !== 'ok') {
      return { status: result.status, detail: result.detail, promptVersion: m.promptVersion,
        schemaVersion: m.schemaVersion, inputHash };
    }
    if (!validateEventPayload(result.payload)) {
      return { status: 'invalid_schema', detail: JSON.stringify(validateEventPayload.errors).slice(0, 300),
        promptVersion: m.promptVersion, schemaVersion: m.schemaVersion, inputHash };
    }
    return {
      status: 'ok', payload: result.payload, promptVersion: m.promptVersion,
      schemaVersion: m.schemaVersion, inputHash,
      omittedBlocks: omitted,
    };
  };
}

module.exports = { makeExtractor };
