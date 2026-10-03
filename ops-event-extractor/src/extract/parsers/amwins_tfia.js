'use strict';
const C = require('./common');

/** Amwins / TFIA premium audits. */
module.exports = {
  family: 'amwins_tfia',
  version: 'amwins-tfia-parser-v1',
  parse(msg, blocks, ctx) {
    const h = C.hints(blocks);
    const audit = C.locate(blocks, /premium audit for policy ([A-Z0-9-]+)[^.]*must be completed by ([0-9/]{8,10})/i)
      || C.locate(blocks, /audit[^.]*(?:due|completed) by ([0-9/]{8,10})/i);
    if (!audit) {
      const worksheet = C.locate(blocks, /audit worksheet is attached/i);
      if (worksheet) {
        return C.result([C.mkEvent({
          kind: 'audit_request', obligation: 'Complete attached premium audit worksheet',
          responsible: 'agency', hints: h,
          fields: [C.field('obligation', 'audit worksheet is attached', worksheet)], anchor: worksheet,
        })]);
      }
      return C.result([], 'no audit pattern matched');
    }
    const d = C.dateFrom(audit, ctx.zone);
    const fields = [C.field('obligation', 'premium audit must be completed', audit)];
    if (d) fields.push(C.field('stated_deadline', d.iso, audit));
    return C.result([C.mkEvent({
      kind: 'audit_request',
      obligation: `Complete premium audit for ${h.policy_refs[0] || 'policy'}`,
      responsible: 'agency', objectKey: 'audit:premium', deadline: d ? d.iso : null, hints: h, fields, anchor: audit,
    })]);
  },
};
