# Ops Event Extractor

Turns agency operational email into obligations that have evidence, an owner,
a deadline and a reminder schedule — and tracks whether the work actually got
done.

Built for a commercial insurance agency running five shared mailboxes at
roughly 200 threads a week, on Google Workspace with QQ Catalyst as the agency
management system.

## The thing it is actually solving

A renewal notice arrives in March for a policy that lapses in June. It gets
forwarded twice. One of the forwards mentions a signed form that is a separate
obligation with a separate deadline. A carrier asks a question in a new thread
three weeks later. Someone says "we'll remove that vehicle" on a call. A bind
confirmation arrives while a binding condition is still unsatisfied.

Nothing here is hard individually. What fails is the accounting: which of those
is still owed, by whom, by when, and how do you know it was done.

## What it will not do

- **It cannot send mail.** There is no send path in the source tree, and a
  scanner fails the build if one appears. It drafts; a person sends.
- **It reads Gmail read-only.** `gmail.readonly`, nothing wider.
- **It never guesses an account.** Exact policy number, then exact normalized
  name, then ZIP. Then it stops and asks.
- **It records no obligation without a verbatim span** from the message that
  actually supports the claim.
- **It performs no insurance transaction.** It never binds, cancels, endorses,
  pays, or says coverage is in force.
- **It writes nothing external without two independent switches** being set.

## Requirements

Node.js 22 (`.nvmrc` pins 22.22.2). No database server, no network needed for
the default path.

```
npm install
```

## Quickstart — nothing real is touched

```
npm run ops -- scan-nosend        # prove there is no way to send mail
npm run ops -- check-leakage      # prove no real names or secrets are committed
npm run ops -- init
npm run ops -- seed-synthetic
npm run ops -- process
npm run ops -- fulfillment
npm run ops -- sweep
npm run ops -- status
npm run ops -- review             # http://127.0.0.1:8766
```

Or run all of it at once:

```
bash scripts/walkthrough.sh
```

## Commands

Every command below exists and has been run.

| command | what it does |
|---|---|
| `init` | create or migrate the database |
| `seed-synthetic` | load the synthetic corpus and reference data |
| `sync-gmail` | read mail — needs `OPS_DATA_MODE=live` and Gmail credentials |
| `process` | route, extract, ground, resolve accounts, schedule |
| `sweep` | fire timers and silence escalations |
| `fulfillment` | match obligations against agency-system evidence |
| `review` | loopback-only review console on port 8766 |
| `replay` | reprocess chronologically, advancing the clock to each message |
| `eval` | replay and score against the labelled corpus |
| `export-csv` | write open tasks to CSV |
| `qq-dryrun` | build agency-system notes and show them without sending |
| `scan-nosend` | fail if any send capability appears in the source |
| `check-leakage` | fail if real names or secrets appear in the tree |
| `patterns` | list learned patterns; `patterns show\|approve\|retire <id> --by=NAME` |
| `status` | counts and configuration |

Options: `--db=PATH --now=ISO --live --parsers-only --port=N --json=PATH
--out=PATH --fresh --verbose`

## How it works

```
mailbox ──▶ sync ──▶ normalize ──▶ route ──┬─▶ parser family
                                            └─▶ model extraction
                                                      │
                                                      ▼
                                          gates: schema, span present,
                                          span grounded, span supports
                                          the field, dates parse,
                                          no account contradiction
                                                      │
                          ┌───────────────────────────┴──────────┐
                          ▼                                      ▼
                    quarantine                            resolve account
                 (kept, urgent ones                             │
                  still visible)                                ▼
                                                   obligation + version + evidence
                                                                │
                                                                ▼
                                              task ──▶ sweep ──▶ escalation
                                                       │
                                                       ▼
                                            fulfillment match ──▶ close or not
```

Nine deterministic parser families handle known senders (TWIA, RingCentral,
Foxquilt, HelloSign, IPFS, Progressive, COISolution, Amwins/TFIA, Wholesure).
Anything else — an unknown sender, a known sender with a new template, a
forward — goes to model extraction. Both paths produce candidates that face the
same gates.

When the model reads an email from a sender outside the agency and its answer
passes every gate, the system writes down a **learned pattern** for that
template: a trigger phrase and the words that come before each value. The
pattern runs in shadow next to the model. Once it has agreed three times, a
person can approve it with `patterns approve <id> --by=NAME`, and from then on
matching emails skip the model call. Every tenth use is still re-read by the
model, and a disagreement suspends the pattern. See
`docs/adr/0006-learned-patterns.md`.

## Configuration

Copy `.env.example`. The switches that matter:

| variable | default | effect |
|---|---|---|
| `OPS_DATA_MODE` | `synthetic` | `live` is required to read real mail |
| `OPS_MODEL_MODE` | `stub` | `astra` calls the real model |
| `OPS_MODEL_TRANSMISSION_APPROVED` | unset | required before content leaves the machine |
| `OPS_EXTERNAL_WRITES_APPROVED` | unset | one of the two switches for external writes |
| `OPS_MODEL_SNAPSHOT` | unset | pin an immutable model snapshot once you have one |
| `OPS_PRIVATE_NAME_LIST` | unset | path to the real-name list, kept outside this repo |

Credentials come from the OS credential store — macOS Keychain, libsecret, or
Windows Credential Manager. There is no file fallback and no environment
fallback; a missing credential fails the command rather than degrading.

Mailboxes live in `config/mailboxes.json`. Only one is configured; four are
placeholders and `init` tells you so.

## Tests

```
npm test
```

52 tests: the nine acceptance scenarios, the failure stories, infrastructure
behaviour (charset, pagination, expired history, reprocessing, crash rollback,
model refusal, unknown dispatch outcomes, all four write-switch combinations),
and the security properties.

## Measured behaviour

On the 36-message synthetic corpus, replayed in arrival order against labels
written independently of the extractors:

```
precision:   100.0% (27/27)
recall:      100.0% (27/27)
disposition: 100.0% (36/36)
```

These describe whether the pipeline behaves as specified on fixtures written
alongside it, using the offline extraction stub. **They are not a measurement
of live extraction quality** and should not be quoted as one. See
`PROGRESS.md` for what has and has not been verified against real systems.

## Documentation

- `CLAUDE.md` — working agreements; read before changing anything
- `PROGRESS.md` — what works, what is blocked, what is unverified
- `docs/OPERATOR.md` — running it against real mail
- `docs/WALKTHROUGH.md` — annotated end-to-end output
- `docs/DEMO_SCRIPT.md` — five-minute demonstration
- `docs/adr/` — architecture decisions, including every deviation and every
  defect the tests found
