const INSURED_RE = /\binsured\s*(?:name)?\s*[:\-]\s*([^\n]{2,120})/i;
const EXPIRY_DAYS_RE = /expir(?:es|ing) in\s*(\d{1,3})\s*days?/i;

export default {
  name: 'coisolution',
  match: (msg) => /@mycoisolution(-example)?\.com/i.test(msg.from_addr || '') || /@mycoitracking(-example)?\.com/i.test(msg.from_addr || ''),

  parse(msg) {
    const body = msg.body_full || '';
    const insured = INSURED_RE.exec(body);
    const expiryDays = EXPIRY_DAYS_RE.exec(body);

    return [{
      kind: 'coi_request',
      obligation: expiryDays
        ? `Issue a renewed certificate before it expires in ${expiryDays[1]} days.`
        : 'Issue the requested certificate of insurance.',
      due_date: null,
      due_date_basis: 'absent',
      account_name_raw: insured ? insured[1].trim() : null,
      carrier: null,
      policy_no: null,
      amount_cents: null,
      raw_span: expiryDays?.[0] || insured?.[0] || msg.subject || 'COI tracking notice',
      extractor: 'parser',
      extractor_ref: 'coisolution'
    }];
  }
};
