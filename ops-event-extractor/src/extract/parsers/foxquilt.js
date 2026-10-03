'use strict';
const C = require('./common');

/** Foxquilt quotes, binding conditions, underwriting questions, bind confirmations. */
module.exports = {
  family: 'foxquilt',
  version: 'foxquilt-parser-v1',
  parse(msg, blocks, ctx) {
    const h = C.hints(blocks);
    const events = [];
    const signals = [];

    const bind = C.locate(blocks, /bind (?:is )?confirmed|confirming bind|bound effective/i);
    if (bind) {
      signals.push({
        type: 'bind_observed',
        policy_ref: h.policy_refs[0] || null,
        detail: { quote: bind.quote, block_seq: bind.blockSeq },
      });
      return C.result(events, 'bind confirmation carries no new obligation', signals);
    }

    const quote = C.locate(blocks, /quote ([A-Z0-9-]+) is attached|quote ([A-Z0-9-]+)/i);
    const cond = C.locate(blocks, /subject to:? (.+)$/im) || C.locate(blocks, /(.*required prior to bind(?:ing)?.*)/i);
    const valid = C.locate(blocks, /valid until ([0-9/]{8,10})/i);
    const premium = C.amountFrom(C.locate(blocks, /premium \$\s?[\d,]+\.\d{2}/i) || C.locate(blocks, /\$\s?[\d,]+\.\d{2}/));

    if (quote && !cond) {
      const d = C.dateFrom(valid, ctx.zone);
      const fields = [C.field('obligation', 'quote received', quote)];
      if (d) fields.push(C.field('stated_deadline', d.iso, valid));
      if (premium) fields.push(C.field('amount', premium.value, premium.loc));
      events.push(C.mkEvent({
        kind: 'quote_received', obligation: `Review and present quote ${h.policy_refs[0] || ''}`.trim(),
        responsible: 'agency', deadline: d ? d.iso : null,
        amount: premium ? premium.value : null, currency: premium ? 'USD' : null, hints: h, fields, anchor: quote,
      }));
    }

    if (cond) {
      const condText = (cond.match[1] || cond.match[0]).trim();
      const d = C.dateFrom(valid, ctx.zone);
      const fields = [C.field('obligation', condText.slice(0, 120), cond)];
      if (d) fields.push(C.field('stated_deadline', d.iso, valid));
      events.push(C.mkEvent({
        kind: 'condition_precedent',
        obligation: `Satisfy binding condition: ${condText.slice(0, 140)}`,
        responsible: 'agency',
        objectKey: `condition:${condText.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48)}`,
        deadline: d ? d.iso : null, hints: h, fields, anchor: cond,
      }));
      if (quote) {
        const fq = [C.field('obligation', 'quote received', quote)];
        if (premium) fq.push(C.field('amount', premium.value, premium.loc));
        if (d) fq.push(C.field('stated_deadline', d.iso, valid));
        events.push(C.mkEvent({
          kind: 'quote_received', obligation: `Review and present quote ${h.policy_refs[0] || ''}`.trim(),
          responsible: 'agency', deadline: d ? d.iso : null,
          amount: premium ? premium.value : null, currency: premium ? 'USD' : null, hints: h, fields: fq, anchor: quote,
        }));
      }
    }

    const question = C.locate(blocks, /^([^\n]*\?[^\n]*)$/m);
    if (question && !cond && !quote) {
      events.push(C.mkEvent({
        kind: 'uw_question', obligation: question.quote.slice(0, 160), responsible: 'agency',
        hints: h, fields: [C.field('obligation', question.quote.slice(0, 120), question)], anchor: question,
      }));
    }

    return C.result(events, 'no Foxquilt obligation pattern matched', signals);
  },
};
