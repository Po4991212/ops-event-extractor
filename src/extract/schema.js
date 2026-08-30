import { z } from 'zod';

export const EVENT_KINDS = [
  'renewal_due',
  'payment_due',
  'lapse_warning',
  'nonrenewal_notice',
  'cancellation_notice',
  'signature_required',
  'coi_request',
  'audit_request',
  'quote_received',
  'declination',
  'uw_question',
  'client_commitment',
  'endorsement_request',
  'claim_activity',
  'other'
];

export const EventKind = z.enum(EVENT_KINDS);
export const DueDateBasis = z.enum(['stated', 'derived', 'absent']);
export const Extractor = z.enum(['parser', 'llm', 'human']);

// The raw shape a parser or the LLM tool call produces, before event_key,
// confidence, and extracted_at are computed downstream.
export const RawExtraction = z.object({
  kind: EventKind,
  obligation: z.string().min(1).max(400),
  due_date: z.string().nullable(),
  due_date_basis: DueDateBasis,
  account_name_raw: z.string().nullable(),
  carrier: z.string().nullable().optional().default(null),
  policy_no: z.string().nullable().optional().default(null),
  amount_cents: z.number().int().nullable().optional().default(null),
  raw_span: z.string().nullable(),
  model_confidence: z.number().min(0).max(1).nullable().optional().default(null)
});

// zod v4: z.record requires an explicit key schema (see docs/adr/0002).
export const OpsEvent = z.object({
  event_key: z.string(),
  source_msg_id: z.string(),
  source_thread_id: z.string(),

  kind: EventKind,
  obligation: z.string().max(400),
  due_date: z.string().nullable(),
  due_date_basis: DueDateBasis,

  account_name_raw: z.string().nullable(),
  account_id: z.string().nullable(),
  owner: z.string().nullable(),
  carrier: z.string().nullable(),
  policy_no: z.string().nullable(),
  amount_cents: z.number().int().nullable(),

  extractor: Extractor,
  extractor_ref: z.string(),
  confidence: z.number().min(0).max(1),
  confidence_parts: z.record(z.string(), z.number()),
  extracted_at: z.string(),
  raw_span: z.string().nullable()
});

// The tool's JSON-schema `input_schema` for Anthropic strict tool use (§5.2).
// Mirrors RawExtraction; kept hand-written (not derived from the Zod schema)
// because Anthropic's tool input_schema is JSON Schema draft-2020-12-ish and
// zod-to-json-schema is not a dependency this repo takes on (see ADR 0002).
export const RECORD_OPS_EVENTS_TOOL = {
  name: 'record_ops_events',
  description: 'Record every operational obligation found in the email. Call this exactly once, even if the array is empty.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      events: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: EVENT_KINDS },
            obligation: { type: 'string', description: 'One imperative sentence describing what must be done.' },
            due_date: { type: ['string', 'null'], description: 'ISO yyyy-mm-dd. Null if the email states no date.' },
            due_date_basis: { type: 'string', enum: ['stated', 'derived', 'absent'] },
            account_name_raw: { type: ['string', 'null'], description: 'Business name exactly as written in the email. Do not infer.' },
            carrier: { type: ['string', 'null'] },
            policy_no: { type: ['string', 'null'] },
            amount_cents: { type: ['integer', 'null'] },
            raw_span: { type: 'string', description: 'The verbatim sentence this was extracted from.' },
            model_confidence: { type: 'number' }
          },
          required: ['kind', 'obligation', 'due_date', 'due_date_basis', 'account_name_raw', 'raw_span', 'model_confidence'],
          additionalProperties: false
        }
      }
    },
    required: ['events'],
    additionalProperties: false
  }
};
