import { DateTime } from 'luxon';
import { ZONE } from '../normalize/dates.js';

const POLICY_RE = /\bpolicy\s*(?:number|no\.?|#)?\s*[:\-]?\s*(FQ-?\d{6,10})/i;
const EXPIRY_RE = /\b(?:expir(?:es|ation|y)(?:\s*date)?|renews? on)\s*[:\-]?\s*([A-Za-z]+ \d{1,2},?\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/i;
const LAPSE_RE = /renewal (?:was )?unsuccessful|coverage has lapsed|policy has lapsed/i;

function parseLooseDate(s) {
  const d = DateTime.fromFormat(s.replace(',', ''), 'LLLL d yyyy', { zone: ZONE });
  if (d.isValid) return d.toISODate();
  const d2 = DateTime.fromFormat(s, 'M/d/yyyy', { zone: ZONE });
  if (d2.isValid) return d2.toISODate();
  const d3 = DateTime.fromFormat(s, 'M/d/yy', { zone: ZONE });
  return d3.isValid ? d3.toISODate() : null;
}

export default {
  name: 'foxquilt',
  // Matches the real vendor domain and its -example.com demo/synthetic
  // variant (§3.5, ADR 0006) so the committed synthetic corpus exercises
  // real parser routing without using a real vendor's literal domain there.
  match: (msg) => /@[\w.-]*foxquilt(-example)?\.com/i.test(msg.from_addr || ''),

  parse(msg) {
    const body = msg.body_full || '';
    const policyMatch = POLICY_RE.exec(body);
    const expiryMatch = EXPIRY_RE.exec(body);
    const isLapse = LAPSE_RE.test(body);
    const dueDate = expiryMatch ? parseLooseDate(expiryMatch[1]) : null;

    const spanSource = expiryMatch?.[0] || policyMatch?.[0] || msg.subject || 'Foxquilt notice';
    return [{
      kind: isLapse ? 'lapse_warning' : 'renewal_due',
      obligation: isLapse
        ? 'Coverage has lapsed or renewal was unsuccessful — contact the insured immediately.'
        : 'Shop and confirm the renewal before the policy expires.',
      due_date: dueDate,
      due_date_basis: dueDate ? 'stated' : 'absent',
      account_name_raw: null,
      carrier: 'Foxquilt',
      policy_no: policyMatch ? policyMatch[1] : null,
      amount_cents: null,
      raw_span: spanSource,
      extractor: 'parser',
      extractor_ref: 'foxquilt'
    }];
  }
};
