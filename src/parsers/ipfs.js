import { DateTime } from 'luxon';
import { ZONE } from '../normalize/dates.js';

const ACCOUNT_RE = /\baccount\s*(?:number|no\.?|#)?\s*[:\-]?\s*(\d{6,12})/i;
const AMOUNT_RE = /\$([\d,]+(?:\.\d{2})?)/;
const DUE_RE = /due\s*(?:date)?\s*[:\-]?\s*([A-Za-z]+ \d{1,2},?\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/i;

function parseLooseDate(s) {
  const d = DateTime.fromFormat(s.replace(',', ''), 'LLLL d yyyy', { zone: ZONE });
  if (d.isValid) return d.toISODate();
  const d2 = DateTime.fromFormat(s, 'M/d/yyyy', { zone: ZONE });
  return d2.isValid ? d2.toISODate() : null;
}

export default {
  name: 'ipfs',
  match: (msg) => /@[\w.-]*ipfs(-example)?\.com/i.test(msg.from_addr || ''),

  parse(msg) {
    const body = msg.body_full || '';
    const account = ACCOUNT_RE.exec(body);
    const amount = AMOUNT_RE.exec(body);
    const due = DUE_RE.exec(body);
    const dueDate = due ? parseLooseDate(due[1]) : null;

    return [{
      kind: 'payment_due',
      obligation: 'Confirm the premium finance installment was paid before the due date.',
      due_date: dueDate,
      due_date_basis: dueDate ? 'stated' : 'absent',
      account_name_raw: null,
      carrier: 'IPFS',
      policy_no: account ? `IPFS-${account[1]}` : null,
      amount_cents: amount ? Math.round(parseFloat(amount[1].replace(/,/g, '')) * 100) : null,
      raw_span: due?.[0] || amount?.[0] || msg.subject || 'IPFS installment notice',
      extractor: 'parser',
      extractor_ref: 'ipfs'
    }];
  }
};
