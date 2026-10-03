'use strict';

/**
 * Ground truth for the synthetic corpus.
 *
 * These labels say what a competent broker reading the message would conclude,
 * and they were written from the message text rather than from whatever the
 * extractors happen to produce. Where the correct answer is "hold this back",
 * the label says so - a system that quietly accepts a fabricated span is worse
 * than one that extracts nothing, and the scoreboard has to be able to express
 * that.
 *
 * expect: list of obligations that should exist after processing, each with the
 *   fields that matter for correctness. account: null means "must not be
 *   resolved to an account".
 * disposition: accepted | held | none | noise
 * mergesWith: the label key whose obligation this message should join rather
 *   than creating a new one.
 */
const LABELS = {
  twia_renewal: {
    disposition: 'accepted',
    expect: [{ kind: 'renewal_due', account: 'acct_sabine', policy: 'TWIA-8841207', deadline: '2026-06-01', amount: 18412 }],
    notes: 'S1/S2: a March message carrying a June obligation. The renewal premium appears only inside the '
      + 'HTML table, so extracting it proves the table survived normalization.',
  },
  twia_fwd1: { disposition: 'accepted', mergesWith: 'twia_renewal', expect: [], notes: 'S3: a forward is another source link, not another obligation.' },
  twia_fwd2: { disposition: 'accepted', mergesWith: 'twia_renewal', expect: [] },
  twia_fwd3_other_mailbox: { disposition: 'accepted', mergesWith: 'twia_renewal', expect: [], notes: 'S3: same obligation arriving in a second mailbox.' },
  twia_distinct_signature: {
    disposition: 'accepted',
    expect: [{ kind: 'signature_required', account: 'acct_sabine', policy: 'TWIA-8841207', deadline: '2026-05-15' }],
    notes: 'S3: same thread and same policy, genuinely different obligation - must not be folded into the renewal.',
  },
  fq_quote: {
    disposition: 'accepted',
    expect: [{ kind: 'quote_received', account: 'acct_pecan' },
      { kind: 'condition_precedent', account: 'acct_pecan', deadline: '2026-04-15' }],
  },
  fq_question_newthread: { disposition: 'accepted', mergesWith: 'fq_quote', expect: [], notes: 'S4: new thread, links on corroborating identity.' },
  fq_decoy_other_account: {
    disposition: 'accepted',
    expect: [{ kind: 'quote_received', account: 'acct_marfa' }],
    notes: 'S4: same subject line, different account. Must not link to the Pecan Grove quote.',
  },
  fq_bind_confirmation: {
    disposition: 'none', expect: [],
    notes: 'S4: a bind confirmation creates no obligation of its own. It raises a signal that makes the '
      + 'still-unsatisfied condition urgent, which is asserted directly rather than through counts.',
  },
  rc_call_summary: {
    disposition: 'accepted',
    expect: [{ kind: 'client_commitment', account: 'acct_bluebonnet', object: 'vehicle' },
      { kind: 'coi_request', account: 'acct_bluebonnet' }],
  },
  same_day_commitments: {
    disposition: 'accepted',
    expect: [{ kind: 'client_commitment', account: 'acct_comal', deadline: '2026-04-02' },
      { kind: 'client_commitment', account: 'acct_comal', deadline: '2026-04-02' }],
    notes: 'Two commitments, same account, same day. Distinct obligations.',
  },
  ipfs_installment: { disposition: 'accepted', expect: [{ kind: 'payment_due', account: 'acct_bluebonnet', deadline: '2026-04-15', amount: 1240 }] },
  hellosign_sig: { disposition: 'accepted', expect: [{ kind: 'signature_required', account: 'acct_ironwood', deadline: '2026-04-10' }] },
  coi_request: { disposition: 'accepted', expect: [{ kind: 'coi_request', account: 'acct_comal', deadline: '2026-04-06' }] },
  audit_request: { disposition: 'accepted', expect: [{ kind: 'audit_request', account: 'acct_ironwood', deadline: '2026-04-24' }] },
  declination: { disposition: 'accepted', expect: [{ kind: 'declination', account: 'acct_marfa' }], notes: 'No SLA defined - must still surface with that stated.' },
  claim_activity: { disposition: 'accepted', expect: [{ kind: 'claim_activity', account: 'acct_bluebonnet' }], notes: 'No SLA defined.' },
  endorsement_request: { disposition: 'accepted', expect: [{ kind: 'endorsement_request', account: 'acct_pecan' }], notes: 'No SLA defined.' },
  general_other: { disposition: 'accepted', expect: [{ kind: 'other', account: null }], notes: 'Marketing update with no obligation; acceptable as "other" or as noise, but never as a deadline.' },
  cancellation: { disposition: 'accepted', expect: [{ kind: 'cancellation_notice', account: 'acct_bluebonnet', deadline: '2026-05-05', urgent: true }] },
  lapse_warning: { disposition: 'accepted', expect: [{ kind: 'lapse_warning', account: 'acct_sabine', deadline: '2026-06-01', urgent: true }] },
  nonrenewal: { disposition: 'accepted', expect: [{ kind: 'nonrenewal_notice', account: 'acct_comal', deadline: '2026-09-01' }] },
  uw_question: { disposition: 'accepted', expect: [{ kind: 'uw_question', account: 'acct_comal' }] },
  agency_outbound_question: { disposition: 'accepted', expect: [{ kind: 'uw_question', account: 'acct_ironwood' }], notes: 'S9: the thing the silence sweep watches.' },
  unrelated_reply: { disposition: 'none', expect: [], notes: 'S9: a reply in the thread that does not answer the question must not stop the clock.' },
  grounding_fabricated: { disposition: 'held', expect: [], notes: 'S5: quoted span does not appear in the message.' },
  grounding_empty: { disposition: 'held', expect: [], notes: 'S5: empty span.' },
  grounding_unrelated_span: { disposition: 'held', expect: [], notes: 'S5: real span about an office closure cannot substantiate a renewal deadline.' },
  injection: { disposition: 'none', expect: [], notes: 'S6: instructions in content are data.' },
  charset_win1252: { disposition: 'accepted', expect: [{ kind: 'payment_due', account: 'acct_bluebonnet', deadline: '2026-05-01', amount: 4210 }] },
  damaged_charset: { disposition: 'none', expect: [], notes: 'Undecodable content must not produce a confident obligation.' },
  pdf_attachment: { disposition: 'accepted', expect: [{ kind: 'audit_request', account: null }], notes: 'Attachment cannot be read; obligation surfaces with processing marked incomplete.' },
  ambiguous_account: { disposition: 'accepted', expect: [{ kind: 'coi_request', account: null }], notes: 'Two accounts share the name and no ZIP disambiguates. Must stop at unresolved.' },
  lookalike_sender: { disposition: 'accepted', expect: [{ kind: 'renewal_due', account: null }], notes: 'Lookalike domain must not inherit TWIA parser trust or resolve an account.' },
  known_sender_new_template: { disposition: 'accepted', expect: [{ kind: 'other', account: 'acct_bluebonnet' }], notes: 'Known sender, unknown layout: fall back rather than mis-parse.' },
  progressive_login_alert: { disposition: 'noise', expect: [], notes: 'Benign template with no obligation cue.' },
};

function labelFor(key) { return LABELS[key] || null; }
function labelledKeys() { return Object.keys(LABELS); }

module.exports = { LABELS, labelFor, labelledKeys };
