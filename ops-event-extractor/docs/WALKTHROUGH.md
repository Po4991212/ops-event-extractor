# Annotated walkthrough

This is the real output of `bash scripts/walkthrough.sh` on a clean checkout,
with commentary. No network, no credentials, no API account. Every number below
came from the run that produced this file.

## The two proofs that come before anything else

```
1. Prove there is no way to send mail from this source tree
scanned 64 files in src, scripts against policy 1
no send capability found
```

The first is the product boundary that matters most: there is no code path in
this repository that can transmit a message. The scanner reads every source
file against a policy kept outside `src/` (so it cannot match its own patterns)
and fails on Gmail send endpoints, send or compose scopes, SMTP, nodemailer, or
an email-provider SDK — including inside a comment, because a commented-out
send is a send waiting to be uncommented.

```
2. Prove no real client names or secrets are committed
scanned 94 files
private name list: no path configured (OPS_PRIVATE_NAME_LIST unset)
verdict: clean against public patterns only; private name list was not available
```

The second is honest about its own limits. It checked the public patterns —
API keys, private key blocks, bearer tokens, live agency addresses — and found
nothing. It could not check real client and carrier names because that list
lives outside this repository and was not configured. It says so rather than
reporting a clean pass. A green result from a check that only half ran is worse
than no check.

This scanner earned its place twice during the build: once by finding a live
agency mailbox address committed in the example config, and once by finding
that same address in the very document written to describe the first finding.

## Setting up

```
3. Create the database
database ready at var/walkthrough.sqlite
migrations applied: 001_init.sql, 002_review.sql

4 mailbox(es) are placeholders and will be skipped:
  mbx_2 - address not supplied
  mbx_3 - address not supplied
  mbx_4 - address not supplied
  mbx_5 - address not supplied
Fill them in config/mailboxes.json before the live run.
```

Four of five mailboxes are placeholders. They are named, not skipped silently.
An address nobody supplied is not something to invent.

```
4. Load the synthetic corpus (no live mail is touched)
seeded 8 accounts, 6 policies, 6 AMS activity rows
seeded 36 synthetic messages
```

## Extraction

```
5. Extract, ground, resolve accounts, schedule
messages 36 | events 34 | accepted 31 | held 3 | tasks 31 | deferred 0 | noise 1
3 item(s) held back - review them with: npm run ops -- review
```

Thirty-six messages in, twenty-seven obligations out, three held back, one
routed as noise. The three held back are the point of the exercise:

- one cited a sentence that does not appear in the message
- one cited nothing at all
- one cited a real sentence — "our office will be closed on 07/04/2026" —
  as substantiation for a renewal deadline

The third is the one worth dwelling on. It is a genuine date in a genuine
sentence that the message genuinely contains. It substantiates nothing about
when anything is owed, and the refusal says exactly that.

## Fulfillment: saying is not doing

```
6. Match obligations against what the agency system actually shows
closed 2 | needs review 1 | reopened 1 | rejected 4
  needs a person: task_a2c9d10fa1e62e1c7c39f531 - no shared identifier between objects; no amount claimed
  reopened after reversal: task_69ba0affdff26495499a52c2
```

A commitment made on a phone call closed because an endorsement document
appeared in the agency management system carrying the same VIN. An endorsement
for a different vehicle on the same account did not close it. A note this
system wrote itself was rejected by name — a system cannot validate its own
work. A payment closed on a matching receipt and reopened when the reversal
arrived.

The one marked `needs a person` matched on some fields and not others. It will
not close on its own.

## Reminders, and not repeating them

```
7. Fire timers and silence escalations
examined 26 tasks, fired 79 reminder(s)
  first_action on task_bd2268fb7ea0b28927098f9a
  first_action on task_0f5d0fd155aa01b4a6f1dab3
  first_action on task_6ec4d47fdb24b2b390edbb64
  first_action on task_d26e7d9332b3a003c3a697b1
  first_action on task_52fd5e4007b43d1f210c82bd
  escalation on task_52fd5e4007b43d1f210c82bd
  critical on task_52fd5e4007b43d1f210c82bd
  silence_1 on task_52fd5e4007b43d1f210c82bd
  silence_2 on task_52fd5e4007b43d1f210c82bd
  silence_3 on task_52fd5e4007b43d1f210c82bd
  first_action on task_3c6a1d8e67968473c8ff1005
  escalation on task_3c6a1d8e67968473c8ff1005
  critical on task_3c6a1d8e67968473c8ff1005
  silence_1 on task_3c6a1d8e67968473c8ff1005
  silence_2 on task_3c6a1d8e67968473c8ff1005
  silence_3 on task_3c6a1d8e67968473c8ff1005
  first_action on task_8f8321245ee4ab79161958cf
  escalation on task_8f8321245ee4ab79161958cf
  critical on task_8f8321245ee4ab79161958cf
  first_action on task_bd9ef8faeecb0f824966fd6a
  ... 59 more
```

```
8. Run it again: a second sweep must repeat nothing
examined 26 tasks, fired 0 reminder(s)
```

The second sweep is the interesting one. Escalations are one row per task per
level, so a repeated run, a restart, or a clock that jumps forward cannot
produce the same reminder twice.

## Where things stand

```
9. Current state
data mode: synthetic | extraction: stub | timezone: America/Chicago
messages 36 | obligations 27
open tasks 26 | urgent 3 | held 3
escalations fired 79 | outbox pending 0

kinds with no agreed SLA (surfaced for a person to set):
  claim_activity: 1
  declination: 1
  endorsement_request: 1
  other: 2
```

Kinds with no agreed SLA appear under their own heading rather than being given
an invented deadline. Somebody has to decide those, and the system says so
instead of choosing.

## What it would write, and why it will not

```
10. Build agency-system notes and show what would be sent (nothing is sent)
write mode: dry run - neither switch set
queued 22 | dry run 22 | sent 0 | unknown 0 | failed 0

would POST to acct_sabine:
  [ops] renewal_due: Renew policy TWIA-8841207 before 2026-06-01
  Obligation: Renew policy TWIA-8841207 before 2026-06-01
  Stated deadline: 2026-06-01
  First action: 2026-04-17T14:00:00Z
  Source messages: 4
  Recorded automatically from agency email. Not a coverage confirmation.

would POST to acct_sabine:
  [ops] signature_required: Return signed WPI-8 form for policy TWIA-8841207
  Obligation: Return signed WPI-8 form for policy TWIA-8841207
  Stated deadline: 2026-05-15
  First action: 2026-03-16T14:00:00Z
  Source messages: 1
  Recorded automatically from agency email. Not a coverage confirmation.

would POST to acct_pecan:
  [ops] condition_precedent: Satisfy binding condition: signed no-loss letter required prior to binding.
  Obligation: Satisfy binding condition: signed no-loss letter required prior to binding.
  Stated deadline: 2026-04-15
  First action: 2026-03-23T14:00:00Z
  Source messages: 1
  Recorded automatically from agency email. Not a coverage confirmation.

... 19 more withheld payloads
```

Twenty-two notes built and none sent. Sending requires `--live` on the command
*and* `OPS_EXTERNAL_WRITES_APPROVED=1` in the environment. Either switch alone
leaves you exactly here. The payload shown is byte-for-byte what would be sent —
dry run withholds dispatch, not construction.

Note the renewal shows four source messages. One notice, forwarded twice
internally and once into a second mailbox, is one obligation.

## Scoring

```
12. Replay from scratch in arrival order and score against the labels
precision:   100.0% (27/27)
recall:      100.0% (27/27)
disposition: 100.0% (36/36)

Measured on a synthetic corpus with the offline extraction stub. These numbers describe whether the pipeline behaves as specified on fixtures written alongside it. They are not a measurement of live extraction quality and must not be quoted as one.
```

Replayed in arrival order, advancing the clock to each message's own timestamp,
so a decision that had to be made in March is made with only what existed in
March. Scored against labels written from the message text rather than from
whatever the extractors happened to produce.

The caveat is part of the output, not a footnote someone can drop. These numbers
say the pipeline behaves as specified on fixtures written alongside it. They say
nothing about how a real model performs on real carrier mail.
