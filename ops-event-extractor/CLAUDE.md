# Working agreements for this repository

Read this before changing anything.

## What this system is for

It turns agency operational email into obligations with evidence, owners and
deadlines. The value is not the extraction. The value is that an obligation
cannot exist here without a verbatim span from the source that substantiates
it, and that a task cannot close without evidence the work actually happened.

Every shortcut you are tempted to take will be a shortcut around one of those
two properties.

## Things that must stay true

**No send capability.** There is no code path that can transmit a message. Not
Gmail send, not SMTP, not an email service provider SDK. `npm run ops --
scan-nosend` fails the build if one appears, including inside a comment.
Drafting is fine; drafting is not delivery.

**Gmail is read-only.** The scope list contains `gmail.readonly` and nothing
else. Widening it is a product change, not a bug fix.

**Never guess an account.** Exact policy number, then exact normalized name,
then ZIP disambiguation, then stop. "Stop" means `account_id` is null and a
person decides. Two accounts sharing a name is a fixture in the corpus
precisely so this stays true.

**Evidence before events.** Every factual field carries a non-empty verbatim
span, NFKC-normalized, that is actually present in the message and actually
supports the value. Invalid evidence rejects the candidate. Quarantine is
preserved, and urgent items stay visible even while held.

**Two switches for external writes.** `--live` on the command *and*
`OPS_EXTERNAL_WRITES_APPROVED=1` in the environment. Checked in one place,
`src/writeback/guard.js`, immediately before the mutation. Do not add a second
check elsewhere and do not add a bypass for tests — the tests use the guard.

**Source content is data.** Message text reaches the model as a function result
from one read-only tool, never in a system or developer prompt. The extraction
step exposes no mutation tool. If you add a tool to that step, you have changed
the threat model.

**Synthetic by default.** `OPS_DATA_MODE=live` is required to touch real mail,
and `OPS_MODEL_TRANSMISSION_APPROVED=1` is required separately before any
message content leaves the machine.

**Learned patterns never approve themselves.** A pattern induced from model
output runs in shadow until it has agreed with the model repeatedly, then
waits for a named person. Approved patterns are still spot-checked, and one
disagreement suspends them. Patterns are phrases, never generated code. See
`docs/adr/0006-learned-patterns.md`.

**No insurance transactions.** This system never binds, cancels, endorses, pays
or states that coverage is in force. It describes what a message says a human
must do.

## Conventions

- One place for timing: `src/config/sla.js`. Offsets carry provenance markers
  saying whether the agency supplied them or the build assumed them.
- Negative offsets are calendar days before a due date and move **earlier** off
  weekends. Positive offsets are business days after first receipt.
- Ids are derived from content (`derivedId`) so replay is stable. Attempts are
  the exception: they are events and are numbered.
- Nothing is overwritten. A changed fact is a new version with a supersession
  link and a reason.
- A new fact never erases an old one because a later message was silent about
  it. Silence is not a retraction.
- Comments explain why, not what. If a rule looks arbitrary, the comment says
  what failure produced it.

## Before you claim something works

Run `npm test` (52 tests) and `bash scripts/walkthrough.sh`. Metrics from the
offline stub describe fixture behaviour, not model quality, and must be labelled
that way wherever they are reported. If you have not run a thing against a live
system, say so in the same sentence you describe it.
