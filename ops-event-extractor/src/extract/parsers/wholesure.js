'use strict';
const C = require('./common');

/** Wholesure declinations, nonrenewals and underwriting questions. */
module.exports = {
  family: 'wholesure',
  version: 'wholesure-parser-v1',
  parse(msg, blocks, ctx) {
    const h = C.hints(blocks);
    const events = [];

    const nonrenew = C.locate(blocks, /will not be renewed at expiration on ([0-9/]{8,10})/i);
    if (nonrenew) {
      const d = C.dateFrom(nonrenew, ctx.zone);
      events.push(C.mkEvent({
        kind: 'nonrenewal_notice',
        obligation: `Remarket ${h.policy_refs[0] || 'policy'} ahead of nonrenewal`,
        responsible: 'agency', deadline: d ? d.iso : null, hints: h,
        fields: d ? [C.field('stated_deadline', d.iso, nonrenew)] : [C.field('obligation', 'nonrenewal notice', nonrenew)], anchor: nonrenew,
      }));
    }

    const decline = C.locate(blocks, /(?:we are )?declin(?:ing|ed) to quote ([^.]+)/i);
    if (decline) {
      events.push(C.mkEvent({
        kind: 'declination', obligation: `Declination received: ${decline.match[1].trim().slice(0, 120)}`,
        responsible: 'carrier', hints: h,
        fields: [C.field('obligation', decline.match[1].trim().slice(0, 120), decline)], anchor: decline,
      }));
    }

    const question = C.locate(blocks, /^([^\n]*\?[^\n]*)$/m);
    if (question && !nonrenew && !decline) {
      events.push(C.mkEvent({
        kind: 'uw_question', obligation: question.quote.slice(0, 160), responsible: 'agency', hints: h,
        fields: [C.field('obligation', question.quote.slice(0, 120), question)], anchor: question,
      }));
    }

    return C.result(events, 'no Wholesure obligation pattern matched');
  },
};
