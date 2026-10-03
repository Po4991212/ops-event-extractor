'use strict';
const C = require('../parsers/common');
const { SCHEMA_VERSION } = require('../schema');
const { PROMPT_VERSION } = require('./prompt');

/**
 * Offline extraction stub.
 *
 * It exists so the whole workflow runs on a clean checkout with no API account
 * and no network, and so replay is reproducible. It is NOT a model and its
 * results say nothing about live extraction quality. Every metric produced with
 * this stub is labelled accordingly.
 *
 * Part of its job is to fail on purpose. Three fixtures make it emit evidence
 * that is fabricated, empty, or real-but-unrelated, because the grounding gates
 * are only meaningfully tested by something that actually tries to get past
 * them.
 */
const KIND_CUES = [
  [/will lapse on|coverage will lapse/i, 'lapse_warning'],
  [/will be cancell?ed|notice of cancellation/i, 'cancellation_notice'],
  [/will not be renewed|nonrenewal|non-renewal/i, 'nonrenewal_notice'],
  [/renewal notice|expires? on|renewal premium/i, 'renewal_due'],
  [/installment|premium finance|amount due|payment.*due/i, 'payment_due'],
  [/certificate of insurance|\bcoi\b|certificate/i, 'coi_request'],
  [/signature|please sign|signed .* required/i, 'signature_required'],
  [/premium audit|audit.*complete/i, 'audit_request'],
  [/declin(e|ing|ed) to quote/i, 'declination'],
  [/prior to bind|condition of bind|subject to/i, 'condition_precedent'],
  [/please add|please remove|endorse|add .* to (the )?policy/i, 'endorsement_request'],
  [/claim \d|adjuster/i, 'claim_activity'],
];

/**
 * Subject line first. A forwarded renewal notice whose body says "coverage will
 * lapse on ..." is still a renewal notice; reading only the body would classify
 * every forward of it as a lapse warning and split it off from the obligation
 * it belongs to.
 */
function classify(text, subject = '') {
  if (/final notice/i.test(subject)) return 'lapse_warning';
  if (/renewal notice/i.test(subject)) return 'renewal_due';
  if (/notice of cancellation/i.test(subject)) return 'cancellation_notice';
  if (/nonrenewal|non-renewal/i.test(subject)) return 'nonrenewal_notice';
  for (const [re, kind] of KIND_CUES) if (re.test(text)) return kind;
  return 'other';
}

const FAULT_FIXTURES = {
  'Policy update - Comal Valley HOA': (h) => ([{
    ...C.mkEvent({
      kind: 'renewal_due', obligation: 'Renew policy before the stated renewal deadline',
      responsible: 'agency', deadline: '2026-05-01', hints: h, confidence: 0.91,
    }),
    // Fabricated: this sentence is not in the message.
    fields: [
      { path: 'obligation', value: 'Renew policy before the stated renewal deadline', block_seq: 0,
        quote: 'Your renewal is due by 05/01/2026 and must be completed.' },
      { path: 'stated_deadline', value: '2026-05-01', block_seq: 0,
        quote: 'Your renewal is due by 05/01/2026 and must be completed.' },
    ],
  }]),
  'Policy update 2 - Comal Valley HOA': (h) => ([{
    ...C.mkEvent({
      kind: 'coi_request', obligation: 'Issue a certificate as requested',
      responsible: 'agency', deadline: '2026-05-02', hints: h, confidence: 0.88,
    }),
    // Empty span.
    fields: [
      { path: 'obligation', value: 'Issue a certificate as requested', block_seq: 0, quote: '' },
      { path: 'stated_deadline', value: '2026-05-02', block_seq: 0, quote: '   ' },
    ],
  }]),
  'Policy update 3 - Comal Valley HOA': (h, blocks) => {
    const office = C.locate(blocks, /office will be closed/i);
    return [{
      ...C.mkEvent({
        kind: 'renewal_due', obligation: 'Renew policy WS-2210045',
        responsible: 'agency', deadline: '2026-07-04', hints: h, confidence: 0.86,
      }),
      // Real span, genuinely present, about something else entirely.
      fields: [
        { path: 'obligation', value: 'Renew policy WS-2210045', block_seq: office ? office.blockSeq : 0,
          quote: office ? office.quote : '' },
        { path: 'stated_deadline', value: '2026-07-04', block_seq: office ? office.blockSeq : 0,
          quote: office ? office.quote : '' },
      ],
    }];
  },
};

function extract(message, blocks) {
  const h = C.hints(blocks);
  const subject = message.subject || '';

  if (FAULT_FIXTURES[subject]) {
    return {
      status: 'ok',
      payload: { schema_version: SCHEMA_VERSION, events: FAULT_FIXTURES[subject](h, blocks), no_obligation_reason: null },
    };
  }

  const bodyKinds = ['reply', 'table'];
  const bodyText = blocks.filter((b) => bodyKinds.includes(b.kind)).map((b) => b.canonical_text).join('\n');
  const quotedText = blocks.filter((b) => b.kind === 'quoted').map((b) => b.canonical_text).join('\n');
  const events = [];

  // Injected instructions are just text here. Nothing in this function can act
  // on them: it has no tools, no writes, and no way to select an account.
  const injectionish = /ignore (all )?previous instructions|system (instruction|override)|admin mode/i.test(
    `${subject}\n${bodyText}\n${quotedText}`,
  );

  // A forwarded notice still states the obligation. Quoted blocks are eligible.
  const anchor = C.locate(blocks, /\b(will lapse on|must be completed by|is due|due by|expires? on|valid until|effective|needed by|respond by|not be renewed at expiration on)\b[^\n]*/i,
    ['reply', 'table', 'quoted', 'attachment']);

  if (anchor && !injectionish) {
    const d = C.dateFrom(anchor, 'America/Chicago');
    const amt = C.amountFrom(anchor);
    const kind = classify(`${subject}\n${anchor.quote}`, subject);
    const fields = [C.field('obligation', anchor.quote.slice(0, 120), anchor)];
    if (d) fields.push(C.field('stated_deadline', d.iso, anchor));
    if (amt) fields.push(C.field('amount', amt.value, anchor));
    events.push(C.mkEvent({
      kind,
      obligation: anchor.quote.slice(0, 160),
      responsible: message.direction === 'outbound' ? 'client' : 'agency',
      deadline: d ? d.iso : null,
      amount: amt ? amt.value : null,
      currency: amt ? 'USD' : null,
      hints: h, fields, confidence: 0.78, anchor,
    }));
  }

  // An outbound question the agency asked is an obligation on someone else, and
  // it is the thing the silence sweep watches.
  if (message.direction === 'outbound' && !events.length) {
    const q = C.locate(blocks, /^([^\n]*\?[^\n]*)$/m);
    if (q) {
      events.push(C.mkEvent({
        kind: 'uw_question',
        obligation: q.quote.slice(0, 160),
        responsible: 'client',
        objectKey: `question:${q.quote.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48)}`,
        hints: h, fields: [], confidence: 0.72, anchor: q,
      }));
    }
  }

  // A request with no stated date is still an obligation.
  if (!events.length && !injectionish && message.direction !== 'outbound') {
    const req = C.locate(blocks, /^([^\n]*\b(please (add|remove|send|provide)|we need|needs?|requests?|required)\b[^\n]*)$/im);
    if (req) {
      const kind = classify(`${subject}\n${req.quote}`, subject);
      events.push(C.mkEvent({
        kind,
        obligation: req.quote.slice(0, 160),
        responsible: 'agency',
        hints: h, fields: [], confidence: 0.7, anchor: req,
      }));
    }
  }

  const reason = injectionish
    ? 'message contained instruction-like text and no supported obligation; treated as data'
    : (message.processing_complete === 0
      ? 'content could not be fully decoded; routed for human review'
      : 'no supported obligation found');

  return { status: 'ok', payload: { schema_version: SCHEMA_VERSION, events, no_obligation_reason: events.length ? null : reason } };
}

function meta(cfg) {
  return {
    modelRequested: 'offline-stub',
    modelReturned: 'offline-stub',
    snapshot: null,
    snapshotPinned: false,
    reasoningEffort: null,
    inputTokens: null,
    outputTokens: null,
    latencyMs: 0,
    promptVersion: PROMPT_VERSION,
    schemaVersion: SCHEMA_VERSION,
  };
}

module.exports = { extract, meta, classify };
