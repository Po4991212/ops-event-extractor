'use strict';
const C = require('./common');

/** Progressive cancellation, lapse, claim and premium notices. */
module.exports = {
  family: 'progressive',
  version: 'progressive-parser-v1',
  parse(msg, blocks, ctx) {
    const h = C.hints(blocks);
    const events = [];

    const cancel = C.locate(blocks, /will be cancell?ed[^.]*effective ([0-9/]{8,10})/i);
    if (cancel) {
      const d = C.dateFrom(cancel, ctx.zone);
      const fields = [C.field('obligation', 'cancellation effective date', cancel)];
      if (d) fields.push(C.field('stated_deadline', d.iso, cancel));
      events.push(C.mkEvent({
        kind: 'cancellation_notice',
        obligation: `Prevent cancellation of ${h.policy_refs[0] || 'policy'} effective ${d ? d.iso : 'stated date'}`,
        responsible: 'agency', deadline: d ? d.iso : null, hints: h, fields, anchor: cancel,
      }));
    }

    const lapse = C.locate(blocks, /will lapse on ([0-9/]{8,10})/i);
    if (lapse && !cancel) {
      const d = C.dateFrom(lapse, ctx.zone);
      events.push(C.mkEvent({
        kind: 'lapse_warning',
        obligation: `Prevent lapse of ${h.policy_refs[0] || 'policy'}`,
        responsible: 'agency', deadline: d ? d.iso : null, hints: h,
        fields: d ? [C.field('stated_deadline', d.iso, lapse)] : [C.field('obligation', 'lapse warning', lapse)], anchor: lapse,
      }));
    }

    const claim = C.locate(blocks, /claim ([0-9-]+)[^.]*assigned to adjuster ([^.]+)/i);
    if (claim) {
      events.push(C.mkEvent({
        kind: 'claim_activity',
        obligation: `Claim ${claim.match[1]} assigned to ${claim.match[2].trim()}`,
        responsible: 'carrier', objectKey: `claim:${claim.match[1]}`, hints: h,
        fields: [C.field('object_key', `claim:${claim.match[1]}`, claim)], anchor: claim,
      }));
    }

    const premium = C.locate(blocks, /premium is [^\n]*due ([0-9/]{8,10})/i);
    if (premium) {
      const d = C.dateFrom(premium, ctx.zone);
      const amt = C.amountFrom(premium);
      const fields = [];
      if (d) fields.push(C.field('stated_deadline', d.iso, premium));
      if (amt) fields.push(C.field('amount', amt.value, premium));
      events.push(C.mkEvent({
        kind: 'payment_due',
        obligation: `Renewal premium due on ${h.policy_refs[0] || 'policy'}`,
        responsible: 'client', deadline: d ? d.iso : null,
        amount: amt ? amt.value : null, currency: amt ? 'USD' : null, hints: h, fields, anchor: premium,
      }));
    }

    return C.result(events, 'no Progressive obligation pattern matched');
  },
};
