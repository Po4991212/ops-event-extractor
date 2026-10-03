'use strict';
/**
 * The agency's eighteen email categories.
 *
 * A category describes a whole email ("this is a renewal email"). An event kind
 * (src/config/sla.js) describes one obligation inside it ("renewal due by
 * 06/01"). They are kept apart on purpose: kinds carry agreed SLAs, and
 * stretching them to cover newsletters or carrier announcements would mean
 * inventing deadlines for mail that owes nobody anything.
 *
 * `cues` are matched against the subject first and then the body. They are a
 * starting list written from the agency's category descriptions, not measured
 * against real mail; the order of CATEGORIES is the order they are tried, so
 * narrow categories come before broad ones.
 */
const CATEGORIES = [
  { id: 'cancellation', n: 12, label: 'Cancellation, nonrenewal, and reinstatement',
    cues: [/\bcancel(?:l?ation|l?ed|ing)?\b/i, /\bnon-?renew/i, /\breinstat/i, /\bnotice of intent to cancel/i, /\bwill lapse\b/i, /\breplacement coverage\b/i] },
  { id: 'premium_financing', n: 11, label: 'Premium financing',
    cues: [/\bpremium financ/i, /\bfinance (?:agreement|company|charge)/i, /\bdown payment\b/i, /\binstall?ment (?:schedule|plan|\d)/i, /\bautomatic draft\b|\bauto-?draft\b|\bACH (?:draft|setup)\b/i] },
  { id: 'premium_audits', n: 15, label: 'Premium audits',
    cues: [/\bpremium audit/i, /\baudit\b/i, /\baudit (?:request|appointment|results?|dispute|worksheet)/i, /\bpayroll (?:records|audit)\b/i, /\bsubcontractor (?:records|certificates)\b/i, /\badditional premium\b/i] },
  { id: 'claims', n: 13, label: 'Claims and loss runs',
    cues: [/\bclaim\b|\bclaims\b/i, /\bloss runs?\b/i, /\badjuster\b/i, /\bfirst notice of loss\b|\bFNOL\b/, /\bdate of loss\b/i] },
  { id: 'inspections', n: 14, label: 'Inspections and loss control',
    cues: [/\binspection\b/i, /\bloss control\b/i, /\bsafety recommendation/i, /\brecommendations? (?:completed|compliance)\b/i, /\brequired repairs?\b/i] },
  { id: 'certificates', n: 8, label: 'Certificates and evidence of insurance',
    cues: [/\bcertificate of insurance\b|\bCOI\b/, /\bcertificates?\b/i, /\bevidence of (?:property )?insurance\b|\bEOI\b/, /\badditional insured\b/i, /\bmortgagee\b|\bloss payee\b/i] },
  { id: 'billing', n: 10, label: 'Billing, payments, and refunds',
    cues: [/\binvoice\b/i, /\bpremium (?:notice|due|reminder)\b/i, /\bpayment (?:due|confirmation|received|instructions|reminder)\b/i, /\boutstanding balance\b|\bpast due\b/i, /\breturned (?:payment|check)\b|\bNSF\b/, /\brefund\b/i, /\bbilling\b/i, /\bamount due\b/i] },
  { id: 'policy_changes', n: 7, label: 'Policy changes and endorsements',
    cues: [/\bendorse(?:ment)?\b/i, /\bplease (?:add|remove|delete)\b/i, /\b(?:add|remove|delete) (?:a |the )?(?:vehicle|driver|location|insured|equipment)\b/i, /\bchange (?:of )?(?:address|limits?|deductible)\b/i, /\bpolicy change\b/i] },
  { id: 'binding_issuance', n: 5, label: 'Binding and new policy issuance',
    cues: [/\bbind(?:er|ing)?\b/i, /\bauthori[sz](?:e|ation) to bind\b/i, /\bsubject to\b/i, /\bpolicy (?:delivery|issued|issuance)\b/i, /\bsigned (?:forms?|application)\b/i, /\bplease sign\b|\bsent (?:you )?a document to sign\b/i] },
  { id: 'renewals', n: 6, label: 'Renewals and remarketing',
    cues: [/\brenewal\b/i, /\bremarket/i, /\bexpir(?:es|ing|ation)\b/i, /\bshop(?:ping)? (?:the|this|our) (?:renewal|account|policy)\b/i] },
  { id: 'quotes', n: 4, label: 'Quotes and proposals',
    cues: [/\bquote[sd]?\b/i, /\bproposal\b/i, /\bindication\b/i, /\brevised pricing\b/i, /\bdeclin(?:e|ed|ing) to (?:quote|offer)\b/i] },
  { id: 'underwriting', n: 3, label: 'Underwriting requests',
    cues: [/\bunderwrit/i, /\bmissing information\b/i, /\bsupplemental (?:application|questionnaire)\b/i, /\bplease (?:provide|confirm|clarify)\b/i, /\brepair evidence\b|\bproof of repairs?\b/i] },
  { id: 'applications', n: 2, label: 'Applications and exposure information',
    cues: [/\bapplication\b|\bACORD\b/i, /\b(?:vehicle|driver|equipment) (?:list|schedule)\b/i, /\bstatement of values\b|\bSOV\b/, /\bpayroll\b/i, /\bexposure\b/i] },
  { id: 'coverage_questions', n: 9, label: 'Coverage questions and contract review',
    cues: [/\bam I covered\b|\bis (?:this|that|it) covered\b|\bwould (?:this|that) be covered\b/i, /\bexclusion/i, /\b(?:lease|vendor|subcontract) (?:agreement|requirements?)\b/i, /\binsurance requirements\b/i, /\bcontract review\b/i] },
  { id: 'new_business', n: 1, label: 'New business inquiries',
    cues: [/\bnew business\b/i, /\breferr(?:al|ed)\b/i, /\b(?:looking for|need|want) (?:a )?(?:insurance|coverage)\b/i, /\bdo you (?:insure|write|cover)\b/i, /\bwebsite (?:lead|inquiry|form)\b/i] },
  { id: 'carrier_admin', n: 16, label: 'Carrier/MGA relationships and agency administration',
    cues: [/\bappointment\b/i, /\bcommission/i, /\bproduction report\b/i, /\b(?:market )?appetite\b/i, /\bproduct (?:announcement|launch|update)\b/i, /\bportal\b/i, /\btraining\b|\bwebinar\b/i] },
  { id: 'internal_ops', n: 17, label: 'Internal operations and business administration',
    cues: [/\bhandoff\b|\bhand-off\b|\breassign/i, /\bstaff\b|\bPTO\b|\bout of office\b/i, /\bE&O\b|\berrors and omissions\b/i, /\blicens(?:e|ing) renewal\b|\bCE credits\b/i, /\bsoftware\b|\bIT support\b/i] },
  { id: 'marketing_suspicious', n: 18, label: 'Marketing, unrelated mail, and suspicious messages',
    cues: [/\bnewsletter\b/i, /\bunsubscribe\b/i, /\bwebinar invitation\b|\bspecial offer\b|\blimited time\b/i] },
];

const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

/**
 * Which category an obligation's kind puts its email in. A grounded obligation
 * is better evidence than any keyword, so this wins when an event exists.
 * `other` has no category of its own and falls through to keywords.
 */
const KIND_TO_CATEGORY = {
  renewal_due: 'renewals',
  payment_due: 'billing',          // premium_financing when the sender or text says so
  lapse_warning: 'cancellation',
  nonrenewal_notice: 'cancellation',
  cancellation_notice: 'cancellation',
  signature_required: 'binding_issuance',
  condition_precedent: 'binding_issuance',
  coi_request: 'certificates',
  audit_request: 'premium_audits',
  quote_received: 'quotes',
  declination: 'quotes',
  uw_question: 'underwriting',
  client_commitment: 'policy_changes',
  endorsement_request: 'policy_changes',
  claim_activity: 'claims',
};

/**
 * Kinds that say *someone owes an answer* but not what the email is about. For
 * these, a subject line naming a category is the better signal: "Need payroll
 * figures for the audit" is an audit email even though its obligation is an
 * underwriting-style question.
 */
const GENERIC_KINDS = ['uw_question', 'client_commitment'];

function validateCategories() {
  const problems = [];
  const ns = CATEGORIES.map((c) => c.n).sort((a, b) => a - b);
  if (ns.join(',') !== Array.from({ length: 18 }, (_, i) => i + 1).join(',')) problems.push('categories must be numbered 1..18 once each');
  for (const [kind, cat] of Object.entries(KIND_TO_CATEGORY)) if (!BY_ID.has(cat)) problems.push(`${kind}: unknown category ${cat}`);
  return problems;
}

module.exports = { CATEGORIES, BY_ID, KIND_TO_CATEGORY, GENERIC_KINDS, validateCategories };
