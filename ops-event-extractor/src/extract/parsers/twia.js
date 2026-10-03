'use strict';
const C = require('./common');

/** TWIA renewal, lapse and form-return notices. */
module.exports = {
  family: 'twia',
  version: 'twia-parser-v1',
  parse(msg, blocks, ctx) {
    const h = C.hints(blocks);
    const events = [];

    const lapse = C.locate(blocks, /will lapse on ([0-9/]{8,10})/i);
    const expiry = C.locate(blocks, /\| *([0-9]{2}\/[0-9]{2}\/[0-9]{4}) *\|/) || C.locate(blocks, /expires? (?:on )?([0-9/]{8,10})/i);
    const isFinal = /final notice/i.test(msg.subject || '');

    const anchor = lapse || expiry;
    if (anchor) {
      const d = C.dateFrom(anchor, ctx.zone);
      const fields = [];
      if (d) fields.push(C.field('stated_deadline', d.iso, anchor));
      if (h.policy_refs[0]) {
        const pl = C.locate(blocks, new RegExp(h.policy_refs[0].replace(/[-]/g, '\\-')));
        if (pl) fields.push(C.field('policy_ref', h.policy_refs[0], pl));
      }
      const premium = C.amountFrom(C.locate(blocks, /\$\s?[\d,]+\.\d{2}/));
      if (premium) fields.push(C.field('amount', premium.value, premium.loc));

      events.push(C.mkEvent({
        kind: isFinal ? 'lapse_warning' : 'renewal_due',
        obligation: isFinal
          ? `Prevent lapse of policy ${h.policy_refs[0] || '(unknown)'} on ${d ? d.iso : 'stated date'}`
          : `Renew policy ${h.policy_refs[0] || '(unknown)'} before ${d ? d.iso : 'expiration'}`,
        responsible: 'agency',
        deadline: d ? d.iso : null,
        amount: premium ? premium.value : null,
        currency: premium ? 'USD' : null,
        hints: h,
        fields,
        anchor,
      }));
    }

    const form = C.locate(blocks, /signed ([A-Z]{2,4}-?\d{0,2}) (?:certificate|form) is required/i);
    if (form) {
      const by = C.locate(blocks, /before ([0-9/]{8,10})/i);
      const d = C.dateFrom(by, ctx.zone);
      const fields = [C.field('obligation', `signed ${form.match[1]} form required`, form)];
      if (d) fields.push(C.field('stated_deadline', d.iso, by));
      events.push(C.mkEvent({
        kind: 'signature_required',
        obligation: `Return signed ${form.match[1]} form for policy ${h.policy_refs[0] || '(unknown)'}`,
        responsible: 'agency',
        objectKey: `form:${form.match[1]}`,
        deadline: d ? d.iso : null,
        hints: h,
        fields,
        anchor: form,
      }));
    }

    return C.result(events, 'no TWIA obligation pattern matched');
  },
};
