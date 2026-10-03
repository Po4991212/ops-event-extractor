# Operator guide

What to do before this reads real mail, and what to watch afterwards.

## Before the first live run

**1. Fill in the mailboxes.** `config/mailboxes.json` (copy from
`config/mailboxes.example.json`). Four of the five are placeholders today.
`npm run ops -- init` lists them by id; an unconfigured mailbox is skipped, not
silently treated as empty.

**2. Confirm the SLA table.** `src/config/sla.js`. Each offset carries a marker
saying whether the agency supplied it or the build assumed it. **Every
escalation midpoint is currently an assumption** — interpolated between a first
action and a critical date the agency did supply. Four kinds have no agreed SLA
at all and appear in `status` under a heading that says so. Decide those before
going live; do not let the system pick.

**3. Confirm the holidays.** `config/holidays.json` covers 2026–27 and is an
assumption. It matters: calendar-day offsets that land on a holiday move
earlier, so a wrong holiday moves a renewal reminder.

**4. Verify the parser sender domains.** `config/parser-sources.json` is marked
`verified_against_live_corpus: false`. The domains were written from the brief,
not from real mail. Run against a sample first and check that routing lands
where you expect — the lookalike-domain fixture exists because a near-miss
domain must not inherit a parser's trust.

**5. Store credentials.** OS credential store only, under service
`ops-event-extractor`:

| account | used for |
|---|---|
| `gmail-oauth-refresh` | reading mail |
| `openai-api-key` | model extraction |
| `qq-access-token` | agency-system write-back |

There is no file or environment fallback. A missing credential fails the
command with the account name in the error.

**6. Put the real-name list outside the repository** and point
`OPS_PRIVATE_NAME_LIST` at it. `check-leakage` reports
`clean against public patterns only` when it is absent — that is not a pass,
and the exit status reflects the patterns it *could* check.

## Turning things on, one at a time

These are separate decisions and separate switches, deliberately.

```
OPS_DATA_MODE=live                    # read real mail
OPS_MODEL_MODE=astra                  # use the real model
OPS_MODEL_TRANSMISSION_APPROVED=1     # let message content leave the machine
OPS_EXTERNAL_WRITES_APPROVED=1        # permit external writes (with --live)
```

Reading a mailbox and transmitting its contents to a third party are not the
same decision. Neither is "I want to see what it would write" and "write it".

Recommended order: live mail with the stub first, and read the review console.
Then the model, and compare. Then dry-run write-back and read the payloads.
Only then `--live`.

## Daily operation

```
npm run ops -- sync-gmail
npm run ops -- process
npm run ops -- fulfillment
npm run ops -- sweep
npm run ops -- review
```

A cron entry every few hours is enough at 200 threads a week. The sweep is
restart-safe: one row per (task, level), so a repeated run, a crash, or a clock
that jumps cannot produce the same reminder twice.

## What to watch

**The held queue.** `status` reports it. Items land there when a span was
fabricated, empty, or did not support its field. A rising count usually means a
carrier changed a template, not that someone is attacking you — but read them.
Urgent items stay visible even while held.

**Kinds with no agreed SLA.** `status` lists them. Each one is a task a person
must schedule by hand until you set a rule.

**`needs a person` from `fulfillment`.** A partial match: right account, wrong
amount, or right object, wrong term. These are the ones worth looking at, and
they never close automatically.

**Unresolved accounts.** An obligation with a null account is the system
refusing to guess. Two accounts sharing a name with no ZIP to separate them
produces exactly this.

**Outbox rows in `unknown`.** The request may or may not have landed. Read the
agency system back and reconcile; do not blind-retry. The idempotency key
prevents a duplicate, but the readback is what tells you the truth.

## Known live issues

**QQ note creation returns 417.** Unresolved. The adapter records it as a
distinct code rather than folding it into a generic error. Do not read
successful dry runs as evidence that live note creation works.

**No snapshot is pinned.** Until `OPS_MODEL_SNAPSHOT` is set, extraction runs
against a floating model. `model_calls` records requested vs returned model on
every call, so drift is visible after the fact but not prevented.

## Recovering

- **Aged-out history id** — handled automatically with one full resync. A
  second expiry in a row stops and marks the incremental position stale rather
  than recursing; the mail is already backfilled, so the next run picks up.
- **Reprocessing** — safe. A second pass over the same mail is a no-op.
- **Corrupted run** — obligations are append-only versions. Nothing is
  overwritten, so the history of what a carrier said and when survives any
  reprocessing.
