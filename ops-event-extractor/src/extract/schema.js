'use strict';
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { EVENT_KINDS } = require('../config/sla');

const SCHEMA_VERSION = 'event-schema-v1';

/**
 * The versioned extraction contract. Deterministic parsers and the model emit
 * exactly this shape, so downstream gating, scoring and storage cannot tell
 * them apart structurally - only by the recorded source.
 *
 * Written to satisfy strict Structured Outputs: every property is required,
 * additionalProperties is false everywhere, and optionality is expressed as a
 * nullable type rather than by omitting the key.
 */
const EVENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'events', 'no_obligation_reason'],
  properties: {
    schema_version: { type: 'string' },
    no_obligation_reason: { type: ['string', 'null'] },
    events: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'obligation', 'responsible_party', 'account_hints', 'object_key',
          'stated_deadline', 'amount', 'currency', 'fields', 'model_confidence'],
        properties: {
          kind: { type: 'string', enum: EVENT_KINDS },
          obligation: { type: 'string' },
          responsible_party: { type: 'string', enum: ['agency', 'carrier', 'client', 'unknown'] },
          object_key: { type: ['string', 'null'] },
          stated_deadline: { type: ['string', 'null'] },
          amount: { type: ['number', 'null'] },
          currency: { type: ['string', 'null'] },
          model_confidence: { type: 'number' },
          account_hints: {
            type: 'object',
            additionalProperties: false,
            required: ['policy_refs', 'names', 'zips', 'quoted_only_names'],
            properties: {
              policy_refs: { type: 'array', items: { type: 'string' } },
              names: { type: 'array', items: { type: 'string' } },
              zips: { type: 'array', items: { type: 'string' } },
              quoted_only_names: { type: 'array', items: { type: 'string' } },
            },
          },
          fields: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['path', 'value', 'block_seq', 'quote'],
              properties: {
                path: { type: 'string' },
                value: { type: ['string', 'number', 'null'] },
                block_seq: { type: 'integer' },
                quote: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
};

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateEventPayload = ajv.compile(EVENT_SCHEMA);

/** Shape handed to the Responses API `text.format`. */
function responsesTextFormat() {
  return {
    type: 'json_schema',
    name: 'ops_event_extraction',
    strict: true,
    schema: EVENT_SCHEMA,
  };
}

function emptyResult(reason) {
  return { schema_version: SCHEMA_VERSION, events: [], no_obligation_reason: reason };
}

module.exports = { EVENT_SCHEMA, SCHEMA_VERSION, validateEventPayload, responsesTextFormat, emptyResult };
