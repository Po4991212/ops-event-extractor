# Status

Two separate questions, deliberately answered separately. A system can be
finished as a local artifact and nowhere near ready to touch a production
mailbox, and conflating the two is how a demo becomes an outage.

---

## Local release: ready

Everything below has been run on a clean checkout with no network, no
credentials and no API account.

| | |
|---|---|
| Tests | 52 passing (`npm test`) |
| Walkthrough | 13 steps, all passing (`bash scripts/walkthrough.sh`) |
| Corpus | 36 synthetic messages, 8 accounts, 6 policies, 6 AMS activity rows |
| Precision | 27/27 |
| Recall | 27/27 |
| Disposition accuracy | 36/36 |
| No-send scan | 64 files, 0 findings |
| Leakage scan | 94 files, 0 findings against public patterns |

Precision, recall and disposition were measured by replaying the corpus in
arrival order against labels written from the message text rather than from
extractor output. **They were produced with the offline extraction stub and
describe fixture behaviour, not model quality.**

### Acceptance scenarios

| | scenario | status |
|---|---|---|
| S1 | Renewal first action ≥45 days before lapse | pass |
| S2 | March obligation surfaces in March, detail from HTML table | pass |
| S3 | Three forwards → one obligation, four source links; distinct item stays separate | pass |
| S4 | Cross-thread link on corroborating identity; decoy does not link; bind leaves condition open and urgent | pass |
| S5 | Fabricated, empty, and real-but-unrelated spans all refused | pass |
| S6 | Injected instructions change nothing | pass |
| S7 | No-send scan clean, including comments | pass |
| S8 | Leakage check passes and discloses the unavailable private list | pass |
| S9 | Silence escalates with no new inbound; no duplicate after restart | pass |

### Failure stories

| story | status |
|---|---|
| Vehicle removal stays open until a real endorsement with the right VIN | pass |
| Unanswered audit escalates before its deadline | pass |
| Matching receipt prevents a duplicate chase | pass |
| Receipt for another term or amount does not close | pass |
| A note this system wrote cannot validate its own work | pass |
| A reversal reopens what it reverses | pass |
| Kinds with no agreed SLA surface with the gap stated | pass |

### Product boundaries, each with a test

- no send capability anywhere in the source, comments included
- Gmail scope is `gmail.readonly` and nothing wider
- account resolution stops rather than guessing
- no obligation without a verbatim, present, supporting span
- two independent switches for external writes; all four combinations tested
- no insurance transaction of any kind
- source content reaches the model only as a read-only function result
- synthetic by default; live data and model transmission are separate switches
- credentials from the OS credential store only, no file or environment fallback

---

## Live integration: not ready

Nothing in this repository has ever talked to a production system. The blockers
below are not bugs; they are things that require access, decisions, or
credentials nobody has supplied yet.

### Blocking

**1. Four of five mailbox addresses are unknown.** Only one mailbox is
configured. The other four are placeholders and are skipped with a named
warning. They were not invented.

**2. No Gmail authorization has been performed.** `sync-gmail` has never run
against a real mailbox. The transport, pagination, history replay, expiry
fallback and vanishing-message handling are all exercised against a synthetic
transport that models those behaviours — which is not the same as having met
the real API.

**3. No approved model account.** Every extraction in this repository came from
the offline stub. The Astra adapter has never sent a request. Its shape is
asserted by tests (correct endpoint, `text.format`, `reasoning.effort`, no
sampling parameters) but shape is not behaviour.

**4. No model snapshot is pinned.** Snapshot identifiers were not available at
build time and none was invented. Until `OPS_MODEL_SNAPSHOT` is set, extraction
runs against a floating model. Every call records requested vs returned model,
so drift is visible afterwards — but not prevented.

**5. QQ Catalyst note creation returns 417.** Unresolved, and explicitly not
claimed to be fixed. The adapter records 417 as a distinct code rather than
folding it into a generic error. Permanent Vertafore credentials are still
pending. Successful dry runs are evidence that a payload is well-formed, not
that the endpoint accepts it.

**6. Parser sender domains are unverified.** `config/parser-sources.json` is
marked `verified_against_live_corpus: false`. All nine families were written
from the brief, not from real carrier mail. Real senders drift, and a family
that fails to match degrades to model extraction rather than failing loudly —
which is safe but silent. Check routing against a real sample before trusting
throughput numbers.

### Requires a decision, not access

**7. Every escalation midpoint is an assumption.** The agency supplied first
actions and critical dates. The middles were interpolated and are marked
`assumption` in `src/config/sla.js`. They will fire in production exactly as
written.

**8. Four event kinds have no agreed SLA.** `declination`,
`endorsement_request`, `claim_activity` and `other` surface with
`missing_sla = 1` and appear under their own heading in `status`. They are
deliberately not given invented deadlines.

**9. The holiday calendar is an assumption.** `config/holidays.json` covers
2026–27 and was not supplied by the agency. It affects timing directly:
calendar-day offsets that land on a holiday move earlier.

**10. The private name list is not configured.** `check-leakage` reports
`clean against public patterns only` without it. Point `OPS_PRIVATE_NAME_LIST`
at a list kept outside this repository before treating a clean result as
meaningful.

---

## What the measured numbers do and do not say

They say: given messages of this shape, the pipeline extracts the obligations a
broker would extract, refuses the evidence a broker would refuse, schedules
reminders on the stated rules, links forwards without duplicating, keeps
same-day commitments apart, and does not close a task without evidence.

They do not say: that a real model will extract this well from real carrier
mail, that the parser families will match real senders, that Gmail
synchronization behaves as modelled, or that anything can be written to QQ
Catalyst.

The corpus is 36 messages. A percentage on a denominator that small is a
description of fixtures, which is why every rate in this repository is printed
with its numerator and denominator and carries its caveat in the same output.

---

## Suggested order for going live

1. Fill in the four mailbox addresses; confirm the SLA midpoints and the four
   missing SLAs; confirm the holiday calendar.
2. Configure the private name list; re-run `check-leakage` and expect
   `complete: true`.
3. Gmail credentials, `OPS_DATA_MODE=live`, still on the stub. Read the review
   console for a week. Check routing against `config/parser-sources.json` and
   correct the domains.
4. Model account, `OPS_MODEL_MODE=astra` plus
   `OPS_MODEL_TRANSMISSION_APPROVED=1`. Compare against the stub period. Pin a
   snapshot as soon as one is available.
5. `qq-dryrun` and read the payloads. Resolve the 417 before `--live`.
6. `--live` with `OPS_EXTERNAL_WRITES_APPROVED=1`, one mailbox first.
