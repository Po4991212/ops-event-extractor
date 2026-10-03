'use strict';
const C = require('./common');

/** IPFS premium finance installment notices. */
module.exports = {
  family: 'ipfs',
  version: 'ipfs-parser-v1',
  parse(msg, blocks, ctx) {
    const h = C.hints(blocks);
    // Prefer a sentence that names the installment, because it supports the
    // object key as well as the date and amount. A bare table row is used only
    // when there is no such sentence.
    const row = C.locate(blocks, /installment (\d+)[^.]*?\$([\d,]+\.\d{2}) is due ([0-9/]{8,10})/i)
      || C.locate(blocks, /\|\s*(\d+)\s*\|\s*([0-9]{2}\/[0-9]{2}\/[0-9]{4})\s*\|\s*(\$[\d,]+\.\d{2})\s*\|/);
    if (!row) return C.result([], 'no installment pattern matched');

    const d = C.dateFrom(row, ctx.zone);
    const amt = C.amountFrom(row);
    const installment = row.match[1];
    const fields = [C.field('object_key', `installment:${installment}`, row)];
    if (d) fields.push(C.field('stated_deadline', d.iso, row));
    if (amt) fields.push(C.field('amount', amt.value, row));
    if (h.policy_refs[0]) {
      const pl = C.locate(blocks, new RegExp(h.policy_refs[0].replace(/-/g, '\\-')));
      if (pl) fields.push(C.field('policy_ref', h.policy_refs[0], pl));
    }

    return C.result([C.mkEvent({
      kind: 'payment_due',
      obligation: `Installment ${installment} due on ${h.policy_refs[0] || 'finance account'}`,
      responsible: 'client',
      objectKey: `installment:${installment}`,
      deadline: d ? d.iso : null,
      amount: amt ? amt.value : null, currency: amt ? 'USD' : null,
      hints: h, fields, anchor: row,
    })]);
  },
};
