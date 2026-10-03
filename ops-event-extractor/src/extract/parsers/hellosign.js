'use strict';
const C = require('./common');

/** HelloSign / Dropbox Sign signature requests. */
module.exports = {
  family: 'hellosign',
  version: 'hellosign-parser-v1',
  parse(msg, blocks, ctx) {
    const h = C.hints(blocks);
    const doc = C.locate(blocks, /sent a document to sign:? (.+?)(?:\.|$)/i);
    if (!doc) return C.result([], 'no signature request pattern matched');
    const by = C.locate(blocks, /(?:requested|required) by ([0-9/]{8,10})/i);
    const d = C.dateFrom(by, ctx.zone);
    const fields = [C.field('obligation', doc.match[1].slice(0, 120), doc)];
    if (d) fields.push(C.field('stated_deadline', d.iso, by));
    return C.result([C.mkEvent({
      kind: 'signature_required',
      obligation: `Obtain signature: ${doc.match[1].slice(0, 140)}`,
      responsible: 'agency',
      objectKey: `document:${doc.match[1].toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48)}`,
      deadline: d ? d.iso : null, hints: h, fields, anchor: doc,
    })]);
  },
};
