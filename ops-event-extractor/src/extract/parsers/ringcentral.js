'use strict';
const C = require('./common');

/**
 * RingCentral call recaps. One recap routinely holds several obligations, and
 * the three things that look alike have to stay apart:
 *   a promise the agency made     -> client_commitment
 *   a request the client made     -> its own kind (COI, endorsement, ...)
 *   a historical remark           -> not an obligation at all
 */
const NO_ACTION = /\(no action\)|no action (?:is )?(?:required|needed)/i;
const PROMISE = /\bwe will\b|\bwe'?ll\b|\bi will\b/i;
const REQUEST = /\b(client|insured) (?:requests?|asked for|needs?|wants?)\b/i;
const HISTORICAL = /\blast year\b|\bpreviously\b|\bhistorically\b|\bwe quoted\b/i;

module.exports = {
  family: 'ringcentral',
  version: 'ringcentral-parser-v1',
  parse(msg, blocks, ctx) {
    const h = C.hints(blocks);
    const events = [];
    const bullets = C.locateAll(blocks, /^- .+$/m);

    for (const b of bullets) {
      const line = b.quote.replace(/^- /, '');
      if (NO_ACTION.test(line)) continue;
      if (HISTORICAL.test(line) && !PROMISE.test(line)) continue;

      const d = C.dateFrom(b, ctx.zone);
      const vin = /VIN ([A-HJ-NPR-Z0-9]{11,17})/i.exec(line);
      const fields = [C.field('obligation', line.slice(0, 120), b)];
      if (d) fields.push(C.field('stated_deadline', d.iso, b));

      let kind = 'client_commitment';
      let responsible = 'agency';
      if (/certificate of insurance|\bCOI\b/i.test(line) && REQUEST.test(line)) { kind = 'coi_request'; responsible = 'agency'; }
      else if (REQUEST.test(line) && /add|remove|change|endors/i.test(line)) { kind = 'endorsement_request'; responsible = 'agency'; }
      else if (PROMISE.test(line)) { kind = 'client_commitment'; responsible = 'agency'; }

      // Distinct object keys keep two promises made on the same day apart.
      const objectKey = vin ? `vehicle:VIN ${vin[1]}`
        : `subject:${line.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48)}`;

      events.push(C.mkEvent({
        kind,
        obligation: line.slice(0, 160),
        responsible,
        objectKey,
        deadline: d ? d.iso : null,
        hints: h,
        fields,
        anchor: b,
      }));
    }
    return C.result(events, 'no actionable Tasks bullets in recap');
  },
};
