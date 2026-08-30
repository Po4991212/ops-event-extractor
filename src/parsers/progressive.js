const POLICY_RE = /\bpolicy\s*(?:number|no\.?|#)?\s*[:\-]?\s*(\d{2}\s?\d{6,9}\s?-?\d?)/i;
const UW_QUESTION_RE = /underwrit(?:er|ing) (?:needs|requires|requests)|please (?:provide|respond)|additional information (?:is )?(?:needed|required)/i;
const ENDORSEMENT_RE = /endorsement|change request|policy change/i;

export default {
  name: 'progressive',
  match: (msg) => /@[\w.-]*progressive(-example)?\.com/i.test(msg.from_addr || ''),

  parse(msg) {
    const body = msg.body_full || '';
    const policy = POLICY_RE.exec(body);
    const isEndorsement = ENDORSEMENT_RE.test(body) || ENDORSEMENT_RE.test(msg.subject || '');
    const isUwQuestion = !isEndorsement && (UW_QUESTION_RE.test(body) || UW_QUESTION_RE.test(msg.subject || ''));
    if (!isEndorsement && !isUwQuestion) return [];

    return [{
      kind: isEndorsement ? 'endorsement_request' : 'uw_question',
      obligation: isEndorsement
        ? 'Review and process the requested policy endorsement.'
        : 'Respond to the underwriter question to keep the submission moving.',
      due_date: null,
      due_date_basis: 'absent',
      account_name_raw: null,
      carrier: 'Progressive',
      policy_no: policy ? policy[1].replace(/\s+/g, '') : null,
      amount_cents: null,
      raw_span: policy?.[0] || msg.subject || 'Progressive underwriting notice',
      extractor: 'parser',
      extractor_ref: 'progressive'
    }];
  }
};
