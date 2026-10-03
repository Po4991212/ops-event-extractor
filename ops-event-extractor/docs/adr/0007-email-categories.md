# 0007. The agency's eighteen email categories, as a label beside event kinds

Status: accepted

## Context

The agency sorts its mailbox into 18 categories, from new business inquiries to
marketing and suspicious mail. The system already had 16 event kinds, but those
describe *obligations* and each carries an SLA. Many categories hold mail with
no obligation at all, such as carrier announcements, newsletters and staff
handoffs.

## Decision

Every processed email gets exactly one category (or none, for a person to sort).
It is stored in `message_categories`, because message rows are immutable source
records. Event kinds and their SLAs are unchanged.

The category is decided without a model call, in this order:

1. **Suspicious.** A sender that contains a known carrier domain without being
   it, instruction-like text, a request to change bank or payment details,
   credential phishing, or a risky attachment type. This check runs first so a
   fraudulent invoice never sits in Billing looking routine.
2. **Event kind.** If an obligation was extracted, its kind maps to a category
   (`KIND_TO_CATEGORY`). Payments from a premium finance sender, or with
   installment wording, go to Premium financing instead of Billing. For the two
   generic kinds (`uw_question`, `client_commitment`), a category named in the
   subject wins, because "Need payroll figures for the audit" is an audit email.
3. **Noise route.** Known benign templates go to category 18.
4. **Keywords.** Subject first, then body, trying categories narrowest first.

## Consequences

- Learned patterns carry the category of the kind they learned, and
  `patterns` lists them grouped by category.
- Nothing is learned from a suspicious email. The first build learned a
  pattern from the lookalike TWIA sender in the corpus.
- The keyword lists were written from the agency's category descriptions and
  checked against 18 hand-written samples and the 36-message synthetic corpus.
  They have not been measured on real mail, and the order of categories
  decides ties. Expect to tune both once live mail is visible.
- A "suspicious" label is a warning for a person, not a block. The email is
  still processed and its obligations still appear.
