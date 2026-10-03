'use strict';
const C = require('./common');

/** COISolution certificate requests. */
module.exports = {
  family: 'coisolution',
  version: 'coisolution-parser-v1',
  parse(msg, blocks, ctx) {
    const h = C.hints(blocks);
    const req = C.locate(blocks, /certificate of insurance is requested for ([^,]+)/i);
    if (!req) return C.result([], 'no certificate request pattern matched');
    const holder = C.locate(blocks, /holder:? ([^.]+)/i);
    const by = C.locate(blocks, /needed by ([0-9/]{8,10})/i);
    const d = C.dateFrom(by, ctx.zone);
    const fields = [C.field('obligation', 'certificate of insurance requested', req)];
    if (d) fields.push(C.field('stated_deadline', d.iso, by));
    if (holder) fields.push(C.field('object_key', `holder:${holder.match[1].trim()}`, holder));
    return C.result([C.mkEvent({
      kind: 'coi_request',
      obligation: `Issue certificate for ${holder ? holder.match[1].trim() : 'requested holder'}`,
      responsible: 'agency',
      objectKey: holder ? `holder:${holder.match[1].trim()}` : null,
      deadline: d ? d.iso : null, hints: h, fields, anchor: req,
    })]);
  },
};
