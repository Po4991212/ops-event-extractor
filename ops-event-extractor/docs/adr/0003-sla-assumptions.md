# 0003. The SLA table, and which parts of it the agency actually supplied

Status: accepted

## Context

Reminder timing is the product. Getting it wrong in either direction is
expensive: too early is noise a broker learns to ignore, too late is a lapse.

## Decision

One table, `src/config/sla.js`, is the only place timing is expressed. Every
row carries a provenance marker for each of its three offsets:

- `agency` — supplied by the agency
- `assumption` — interpolated during the build and awaiting confirmation

| kind | first action | escalation | critical |
|---|---|---|---|
| lapse_warning | 0 | assumption | 0 |
| cancellation_notice | 0 | assumption | +3 |
| coi_request | 0 | assumption | +2 |
| condition_precedent | +1 | assumption | +3 |
| payment_due | −10 | assumption | −1 |
| uw_question | +1 | assumption | +4 |
| client_commitment | +1 | assumption | +5 |
| signature_required | +1 | assumption | +7 |
| quote_received | +1 | assumption | +7 |
| audit_request | +2 | assumption | +14 |
| renewal_due | −45 | assumption | −7 |
| nonrenewal_notice | 0 | +2 | +5 |

Negative offsets are **calendar days before the due date**. Positive offsets
are **business days after first receipt**.

Two rules follow from that asymmetry and both are implemented:

1. A calendar-day offset that lands on a weekend or holiday moves **earlier**,
   never later. Pulling a reminder forward costs a day of attention; pushing it
   back can cost the coverage.
2. First receipt means the earliest message linked to the obligation. A
   colleague forwarding a notice three days later does not restart the clock.

**Every escalation midpoint is an assumption.** They were interpolated between
the first action and the critical date because the agency supplied those two
and not the middle. They are marked `assumption` in the source and must be
confirmed before the live run.

Four kinds — `declination`, `endorsement_request`, `claim_activity`, `other` —
have no agreed SLA at all. They do not get an invented one. They get a visible
task with `missing_sla = 1`, they appear in `status` under a heading that says
so, and a person decides. A silently invented deadline is worse than an
admitted gap.

## Consequences

- `config/holidays.json` covers 2026–27 and is itself flagged as an assumption.
- Changing timing means editing one table and rerunning `npm test`; the S1
  assertion pins the 45-day renewal rule specifically.
