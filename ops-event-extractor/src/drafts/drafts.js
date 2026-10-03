'use strict';
const { DateTime } = require('luxon');

/**
 * Drafting is not delivery. These functions return text. Nothing in this
 * repository can transmit it - there is no send path to reach - so a draft is
 * something a person reads, edits and sends from their own mail client.
 *
 * Two variants per obligation, because the choice of whether to lead with a
 * recommendation belongs to the person who owns the relationship:
 *   - "recommend": states a recommended action first
 *   - "options":   lays out the alternatives without steering
 */
function fmtDate(iso, zone) {
  if (!iso) return null;
  return DateTime.fromISO(iso, { zone }).toFormat('LLLL d, yyyy');
}

const TEMPLATES = {
  renewal_due: {
    subject: (o) => `Renewal coming up${o.policy_ref ? ` - ${o.policy_ref}` : ''}`,
    recommend: (o, d) => [
      `Your policy${o.policy_ref ? ` ${o.policy_ref}` : ''} comes up for renewal${d ? ` on ${d}` : ''}.`,
      'My recommendation is to start the renewal review now so there is time to market the account if the renewal terms come back unfavorably.',
      'To do that I need a few things confirmed:',
      '  - Any changes to operations, locations or payroll since last year',
      '  - Updated driver roster if autos are on the policy',
      '  - Current sprinkler / alarm status if that applies',
      '  - Confirmation that the listed services are still accurate',
      'Send those over and I will have terms to you before the deadline.',
    ].join('\n'),
    options: (o, d) => [
      `Your policy${o.policy_ref ? ` ${o.policy_ref}` : ''} comes up for renewal${d ? ` on ${d}` : ''}. A few ways to approach it:`,
      '  1. Renew as-is with the incumbent, fastest path, no market comparison',
      '  2. Renewal review with the incumbent only, moderate effort',
      '  3. Full remarket to the E&S market, most effort, most price discovery',
      'Whichever you prefer, I will need the following to move:',
      '  - Any changes to operations, locations or payroll since last year',
      '  - Updated driver roster if autos are on the policy',
      '  - Current sprinkler / alarm status if that applies',
      '  - Confirmation that the listed services are still accurate',
    ].join('\n'),
  },
  payment_due: {
    subject: (o) => `Payment due${o.policy_ref ? ` - ${o.policy_ref}` : ''}`,
    recommend: (o, d) => [
      `There is a premium payment${o.amount ? ` of $${Number(o.amount).toFixed(2)}` : ''} due${d ? ` on ${d}` : ''}${o.policy_ref ? ` on ${o.policy_ref}` : ''}.`,
      'My recommendation is to pay it before the due date rather than at the due date, because a late posting can trigger a cancellation notice even when the funds eventually clear.',
      'If you have already paid, send me the confirmation and I will match it against the account.',
    ].join('\n'),
    options: (o, d) => [
      `There is a premium payment${o.amount ? ` of $${Number(o.amount).toFixed(2)}` : ''} due${d ? ` on ${d}` : ''}${o.policy_ref ? ` on ${o.policy_ref}` : ''}.`,
      'Options:',
      '  1. Pay the installment directly to the finance company by the due date',
      '  2. Pay the balance in full and stop the finance charges',
      '  3. Send me the payment confirmation if it is already handled',
    ].join('\n'),
  },
  coi_request: {
    subject: () => 'Certificate request',
    recommend: (o, d) => [
      `I have a certificate request${d ? ` needed by ${d}` : ''}.`,
      'My recommendation is to send the certificate as requested once I confirm the holder wording, since a mismatch in the holder name is the most common reason a certificate gets bounced back.',
      'Please confirm the exact holder name and address, and whether any additional insured or waiver of subrogation wording is required by contract.',
    ].join('\n'),
    options: (o, d) => [
      `I have a certificate request${d ? ` needed by ${d}` : ''}. Before I issue it:`,
      '  1. Standard certificate with no additional wording',
      '  2. Certificate with additional insured endorsement, if the contract requires it',
      '  3. Certificate with additional insured and waiver of subrogation',
      'Confirm the exact holder name and address and which of the above the contract calls for.',
    ].join('\n'),
  },
  audit_request: {
    subject: (o) => `Premium audit${o.policy_ref ? ` - ${o.policy_ref}` : ''}`,
    recommend: (o, d) => [
      `The carrier has requested a premium audit${d ? `, due ${d}` : ''}.`,
      'My recommendation is to complete it before the deadline. An unreturned audit is usually estimated by the carrier at the highest reasonable exposure, and reversing that after the fact is far harder than filing on time.',
      'Please send payroll or sales records for the policy period and I will walk the worksheet through with you.',
    ].join('\n'),
    options: (o, d) => [
      `The carrier has requested a premium audit${d ? `, due ${d}` : ''}. How would you like to handle it?`,
      '  1. You complete the worksheet and I review before submission',
      '  2. You send me the records and I complete the worksheet',
      '  3. We request an extension from the carrier, if one is available',
    ].join('\n'),
  },
};

const GENERIC = {
  subject: (o) => `Follow-up${o.policy_ref ? ` - ${o.policy_ref}` : ''}`,
  recommend: (o, d) => [
    `Following up on this item: ${o.obligation_subject}`,
    `My recommendation is to address it${d ? ` before ${d}` : ' now'} so it does not become time-critical.`,
    'Let me know what you need from me to move it forward.',
  ].join('\n'),
  options: (o, d) => [
    `Following up on this item: ${o.obligation_subject}`,
    d ? `The stated deadline is ${d}.` : 'No deadline was stated in the source message.',
    'Options:',
    '  1. Handle it now',
    '  2. Give me the information and I will handle it',
    '  3. Tell me it is not needed and I will close it out with a note on file',
  ].join('\n'),
};

function draftsFor(obligation, cfg) {
  const t = TEMPLATES[obligation.kind] || GENERIC;
  const d = fmtDate(obligation.stated_deadline, cfg.timezone);
  return {
    subject: t.subject(obligation),
    variants: [
      { label: 'Leads with a recommendation', body: t.recommend(obligation, d) },
      { label: 'Presents options neutrally', body: t.options(obligation, d) },
    ],
    disclaimer: 'Draft only. This system cannot send mail and makes no statement about whether coverage is in force.',
  };
}

module.exports = { draftsFor };
