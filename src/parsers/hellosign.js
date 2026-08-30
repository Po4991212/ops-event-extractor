const DOC_TITLE_RE = /"([^"]{3,120})"/;
const SIGNED_RE = /has (?:been )?(?:completed|signed)/i;
const PENDING_RE = /(?:awaiting|pending) (?:your )?signature|needs? (?:to be|your) sign/i;

export default {
  name: 'hellosign',
  match: (msg) => /@mail\.hellosign(-example)?\.com/i.test(msg.from_addr || ''),

  parse(msg) {
    const body = msg.body_full || '';
    const subject = msg.subject || '';
    const titleMatch = DOC_TITLE_RE.exec(subject) || DOC_TITLE_RE.exec(body);
    const docTitle = titleMatch ? titleMatch[1] : 'the document';
    const isSigned = SIGNED_RE.test(subject) || SIGNED_RE.test(body);
    const isPending = !isSigned && (PENDING_RE.test(subject) || PENDING_RE.test(body));

    if (!isSigned && !isPending) return [];

    // Doc titles in this carrier's templates conventionally read
    // "<Doc Type> - <Account Name>" (e.g. "Binding Documents - Acme LLC").
    // Take the segment after the last " - " as a candidate name; downstream
    // account resolution (§4.4) still decides whether it's usable — this
    // parser only reports what's written, never guesses.
    const nameParts = docTitle.split(/\s+-\s+/);
    const accountNameRaw = nameParts.length > 1 ? nameParts[nameParts.length - 1].trim() : null;

    return [{
      kind: 'signature_required',
      obligation: isSigned
        ? `Confirm ${docTitle} was fully executed and file it in QQ.`
        : `Obtain the outstanding signature on ${docTitle}.`,
      due_date: null,
      due_date_basis: 'absent',
      account_name_raw: accountNameRaw,
      carrier: null,
      policy_no: null,
      amount_cents: null,
      raw_span: titleMatch?.[0] || subject,
      extractor: 'parser',
      extractor_ref: 'hellosign'
    }];
  }
};
