import { DateTime } from 'luxon';
import { ZONE } from '../normalize/dates.js';

const POLICY_TAIL_RE = /\bpolicy\s*(?:number|no\.?|#)?\s*(?:ending in|ending with)?\s*[:\-]?\s*(?:\*+)?(\d{4,6})\b/i;
const OFFER_DATE_RE = /renewal offer(?:\s*date)?\s*[:\-]?\s*([A-Za-z]+ \d{1,2},?\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/i;

function parseLooseDate(s) {
  const d = DateTime.fromFormat(s.replace(',', ''), 'LLLL d yyyy', { zone: ZONE });
  if (d.isValid) return d.toISODate();
  const d2 = DateTime.fromFormat(s, 'M/d/yyyy', { zone: ZONE });
  return d2.isValid ? d2.toISODate() : null;
}

export default {
  name: 'twia',
  match: (msg) => /@[\w.-]*twia(-example)?\.org/i.test(msg.from_addr || ''),

  parse(msg) {
    const body = msg.body_full || '';
    const tail = POLICY_TAIL_RE.exec(body);
    const offer = OFFER_DATE_RE.exec(body);
    const dueDate = offer ? parseLooseDate(offer[1]) : null;

    return [{
      kind: 'renewal_due',
      obligation: 'Confirm the TWIA renewal offer with the insured before the offer date.',
      due_date: dueDate,
      due_date_basis: dueDate ? 'stated' : 'absent',
      account_name_raw: null,
      carrier: 'TWIA',
      policy_no: tail ? `...${tail[1]}` : null,
      amount_cents: null,
      raw_span: offer?.[0] || tail?.[0] || msg.subject || 'TWIA renewal offer',
      extractor: 'parser',
      extractor_ref: 'twia'
    }];
  }
};
