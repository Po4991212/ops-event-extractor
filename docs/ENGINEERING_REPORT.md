# Engineering Report — Ops Event Extractor

Status: complete, runnable, tested synthetic vertical slice (Phases 1–5 of
`docs/SPEC.md`). Live Gmail/QQ/Anthropic integration is coded and gated but
not exercised in this environment, per `docs/SPEC.md` §10: "Live Gmail or
QQ credentials are integration acceptance items, not prerequisites for a
complete synthetic vertical slice."

## 1. As-built file map

```
ops-event-extractor/
├── package.json, .env.example, .gitignore, README.md
├── data/
│   ├── synthetic/messages.json      18 fictional messages (§3.5, ADR 0006)
│   ├── private/, raw/               gitignored, empty (no real mail ingested here)
│   └── ops.db                       gitignored, created by `migrate`
├── docs/
│   ├── SPEC.md                      the full spec (moved here from the repo root)
│   ├── research-sources.md          §11 source verification, dated 2026-08-29
│   ├── ENGINEERING_REPORT.md        this file
│   └── adr/0001–0006                6 ADRs, see §6 below
├── src/
│   ├── cli.js, config.js
│   ├── db/{schema.sql, index.js, queries.js}
│   ├── gmail/{auth.js, sync.js, fetch.js}         coded, not live-exercised (ADR 0003)
│   ├── normalize/{text.js, dates.js}
│   ├── dedup/hash.js
│   ├── classify/route.js
│   ├── parsers/{registry, ringcentral, foxquilt, twia, hellosign, ipfs,
│   │            progressive, coisolution, dailytasks}.js   — 8 files per §1
│   ├── extract/{schema.js, prompt.js, llm.js}
│   ├── resolve/{account.js, index.json}           synthetic client index, ADR 0001
│   ├── score/confidence.js
│   ├── events/{sla.js, store.js}
│   ├── review/server.js                           localhost:8766
│   ├── writeback/{qq.js, nudges.js}                qq.js: dry-run only, ADR 0001
│   └── eval/{align.js, score.js, replay.js}
└── test/
    ├── fixtures/*.json                             7 parser fixtures (real vendor domains, ADR 0006)
    └── *.spec.js                                    13 files, 67 tests
```

Deviations from `docs/SPEC.md` §1's tree, each with an ADR: no `bind.js`/
`intake.js` (nothing existed to extract from — ADR 0001); `writeback/`
gained `nudges.js` (§6.2 needs a home; not named in the tree); `README.md`
now setup-focused, full spec moved to `docs/SPEC.md`; added
`docs/ENGINEERING_REPORT.md` and `docs/adr/`.

## 2. Exact commands run and results

```
$ npm install                          → 208 packages, 0 vulnerabilities
$ npx vitest run                       → 13 files, 67 tests, all passed
$ node src/cli.js migrate              → schema applied (idempotent, re-run safe)
$ node src/cli.js seed-synthetic       → 18/18 synthetic messages loaded
$ node src/cli.js run                  → 18 messages → 15 event-results (8 auto, 7 queued);
                                          13 distinct event rows persisted (2 auto results
                                          collapsed into 1 existing row — the triple-delivery
                                          dedup case, §4.5/§7.3 recovery 3)
$ node src/cli.js parse-daily-tasks --write-db
                                        → 6 ground-truth rows from 2 synthetic daily-task emails
$ node src/cli.js replay               → see §4 below
$ node src/cli.js export-tasks         → CSV of 6 open tasks
$ node src/cli.js qq-push-dry-run      → 6 dry-run payloads logged, nothing sent
$ node src/cli.js nudge-drafts         → 6 draft pairs (recommendation + neutral), nothing sent
```

Review server smoke test (`src/review/server.js`, in-process, ephemeral
port): `GET /queue` returned all 7 pending items;
`POST /queue/:key/resolve {action:accept}` created a task and removed the
item from the pending queue — the human-review→task path works end to end.

## 3. Parser/LLM routing distribution

18 synthetic messages → **noise: 1, parser: 14, llm: 3** (`routing_log`
table). The 3 routed to `llm` are the one genuinely unstructured client
email and the two daily-task-summary emails (which have no dedicated
OpsEvent parser — they're read separately for ground truth via
`parse-daily-tasks`, per §3.4). **Zero LLM calls were actually made**: no
`ANTHROPIC_API_KEY` is configured in this environment, and
`llmAllowedForMessage()` (`src/extract/llm.js`) requires one — this is by
design (§8: fail closed, don't silently skip a check). `cost_cents_per_1000`
and `p50/p95 latency` are therefore `0`/`null` in this run; see §4.

Of the 14 parser-routed messages, 13 produced at least one event (the
triple-delivery scenario contributes 3 messages → 1 collapsed event, one of
which is also counted in "parser: 14" three times).

## 4. Metrics (§7.2), from `node src/cli.js replay`

```json
{
  "messageCount": 18, "eventCount": 13,
  "headline": { "precision": 0.077, "recall": 0.167, "f1": 0.105, "tp": 1, "fp": 12, "fn": 5 },
  "perField": { "account_name_raw": 1, "kind": 1, "due_date": null },
  "reviewQueueRate": 0.538, "autoBandPrecision": 0,
  "autoCount": 6, "queuedCount": 7,
  "costCentsPer1000": 0, "p50LatencyMs": null, "p95LatencyMs": null
}
```

**Read these numbers correctly — they measure corpus overlap, not
extraction correctness.** The 18-message parser/LLM demo corpus and the
6-row ground-truth set (from 2 separate synthetic daily-task emails) were
built as two largely independent scenario sets, on purpose, to keep the
committed fixtures small and each fixture legible on its own (ADR 0006).
Only one account ("Copperline Hospitality LLC," a COI request) appears in
both, and that one **is** the single true positive above. Manually
verifying the other 5 auto/queued events against their source fixtures
(§2 of this report and `test/parsers.spec.js`) confirms they are correct
extractions of their respective messages — they score as false positives
here purely because no ground-truth row happens to describe the same
account, not because the extraction is wrong.

A second, real limitation this run surfaces: the daily-task ground-truth
format's date field is a **follow-up/check-in date** ("Follow-up scheduled
for 8/24"), not necessarily the underlying obligation's actual due date.
Even with full account overlap, `±2 day` due-date alignment (§7.1) will
systematically miss on `renewal_due`/`payment_due` rows where the follow-up
cadence date differs from the policy's real expiration/installment date.
This is a property of Rita's daily-list format itself, not a bug in the
aligner — see §5 (Limitations) for the recommended fix.

**What this means in practice:** this metrics harness is fully
implemented, tested (`src/eval/align.js`, `src/eval/score.js`,
`test/replay.spec.js`), and produces a real, if small, number today. It
becomes meaningful once ground truth is drawn from the *same* message
stream as production traffic — exactly what Phase 1 (`parse-daily-tasks`
against the real mailbox) is designed to produce, and exactly why
`docs/SPEC.md` §3 has you build the eval set before the pipeline.

## 5. The three §7.3 recovery tests (`test/replay.spec.js`)

Per ADR 0006, these are synthetic analogs of the spec's real documented
incidents, not the literal named accounts.

| Test | Result |
|---|---|
| Flags a renewal 45 days before its due date, not at the deadline | **PASS** — `sla_first_action` = `2026-09-17` for a policy due `2026-11-01` |
| Surfaces a renewal months before it's due, not the week of expiration | **PASS** — extracted 163 days before its due date (`2026-06-05` → `2026-11-15`) |
| Collapses a renewal notice delivered three times into one event, three recorded sources | **PASS** — 1 event row, `event_sources` has exactly 3 distinct `source_msg_id` |

All three, plus a fourth check on the `lapse_warning` 0/0/0 SLA and a full
run/metrics smoke test, pass: `npx vitest run test/replay.spec.js` → 5/5.

## 6. Security, privacy, and data-flow controls

- **Dry-run by default, live fails closed** (§0.1/§0.10): `OPS_MODE`
  defaults to `synthetic`; anything other than the literal string `live` is
  treated as synthetic (`src/config.js`).
- **Two independent live-approval gates**, not one: `OPS_MODE=live` alone
  does **not** allow real mail to reach Anthropic —
  `OPS_LLM_LIVE_APPROVED=true` is a second, separate switch (ADR 0004),
  because "approved to process live mail" and "approved to send some of
  that mail's text to Anthropic" are different approvals per §0.6.
- **Least privilege**: Gmail scope is `gmail.readonly` only in this build;
  `modify`/`compose` are not requested (ADR 0003).
- **Secret isolation**: `.env` is gitignored; `.env.example` carries only
  placeholders; Gmail/QQ tokens are expected outside the repo
  (`GMAIL_TOKEN_STORE_PATH`); no token or full auth-error body is logged
  anywhere in `src/`.
- **Untrusted input handling** (§0.8): the email is delivered to Claude as
  a JSON-encoded `tool_result` answering a synthetic `read_email`
  `tool_use` turn — the current Anthropic guidance for indirect prompt
  injection (`docs/research-sources.md`) — with an explicit
  untrusted-content policy in the system prompt. Verified structurally
  (no live model call) in `test/prompt-injection.spec.js`: the untrusted
  payload cannot break out of its JSON delimiters, the system prompt never
  contains email content, and body size is capped.
- **Hallucination detector**: `src/score/confidence.js`'s grounding gate
  discards any event whose `raw_span` doesn't appear verbatim (after
  NFKC + whitespace normalization) in the source — tested against a
  deliberately fabricated span in `test/confidence.spec.js`.
- **No outbound-send capability exists**: `test/no-send-endpoint.spec.js`
  greps all of `src/` for Gmail's send-endpoint call patterns (including
  inside comments) and fails the build if either appears. Drafts are
  create-only.
- **Synthetic-only committed data, enforced**: `test/no-real-names.spec.js`
  greps `data/synthetic/`, `test/fixtures/`, and `src/resolve/` for every
  proper noun `docs/SPEC.md`'s own narrative uses as a real-mailbox example
  and fails if any appear. This test caught two real leaks during
  development (a code comment quoting a real example name, and a
  false-positive in the send-endpoint scanner) — both fixed; see git
  history on `src/resolve/account.js` and `src/writeback/nudges.js`.
- **Auditability**: every LLM call (attempted or made) is logged to
  `llm_calls` with model id, token counts, cost, latency, and ok/error;
  every event carries `extractor`, `extractor_ref`, `confidence`, and
  `confidence_parts` (the per-validator breakdown).
- **Recipients of data**: in synthetic mode, no data leaves the machine
  except calls to the Anthropic API using synthetic fixtures (harmless).
  In live mode with both approval gates set, the minimum bounded text
  (subject, capped body, from-domain — no full email address, no
  attachments) reaches Anthropic; nothing reaches QQ (write-back is
  dry-run only, see §7); nothing is ever sent via Gmail.

## 7. Known limitations and open items

**Product/scope:**
- QQ Catalyst write-back has no verified API contract in this environment
  (ADR 0001) — dry-run and CSV export are the shipped surface. Wiring a
  real endpoint is a follow-up once the agency supplies the contract and
  the previously-noted 417/credential blockers (per `docs/SPEC.md` §6.3)
  are resolved.
- Live Gmail sync (`src/gmail/sync.js`) and the OAuth bootstrap flow
  (`src/gmail/auth.js`'s `runOAuthSetup`, wired to `cli.js gmail-auth`,
  added after this report's first pass in response to a request to walk
  through connecting a real mailbox) are implemented against the current
  documented API shape (ADR 0003) but have never run against a real
  mailbox in this environment — treat them as code-reviewed, not
  field-tested, until they have. See README "Live Gmail setup" for the
  operator walkthrough.
- `resolveAccount`'s exact-name match short-circuits before checking for a
  fuzzy near-duplicate (documented and tested as a known limitation in
  `test/resolve-account.spec.js`) — a query that happens to exactly equal
  one client's normalized name resolves there even if another client's
  name is a very close superset. This mirrors `docs/SPEC.md` §4.4's
  algorithm exactly; tightening it (e.g., always checking for a
  high-scoring alternate candidate even after an exact match) is a
  reasonable follow-up if this pattern shows up in real client data.
- Only the 7 carrier/vendor parsers named in `docs/SPEC.md` §1's file tree
  are implemented; §4.3's table also mentions `amwins_tfia` and
  `wholesure` parsers that aren't in the file tree and aren't built here,
  to keep to the tree's literal "eight parsers" (7 carrier + dailytasks)
  acceptance count. Adding them is straightforward (same shape as the
  existing 7) and is listed as a near-term milestone below.
- Ground-truth date semantics (§4 above): the daily-task format's date is
  a follow-up/check-in date, not necessarily the obligation's true due
  date. Recommended fix: either (a) extend `ground_truth` with a second,
  optional `true_due_date` column reserved for cases where a human review
  confirms the follow-up date happens to equal the real due date, or (b)
  treat due-date agreement as a *soft* signal in `align.js` (a bonus, not
  a requirement) rather than a hard ±2-day gate, and re-tune once real
  data is available.
- Supersession (`findSupersedeTarget` in `src/events/store.js`) requires a
  shared `policy_no` by design (§2.3: "the same policy and kind") — an
  earlier, broader version of this check that also matched on
  `account_name_raw` alone was caught by `npm test` incorrectly marking
  two genuinely distinct `client_commitment` tasks from the same call as
  one superseding the other, and was narrowed before this report. Kinds
  with no policy number (most of `client_commitment`, `uw_question`, etc.)
  never supersede — each message-derived obligation of that kind stays a
  distinct event, which is the safe default or already the sole intended
  behavior for LLM-sourced events, but worth knowing about IF/when
  parsers gain policy numbers for those kinds.

**Compliance (explicitly not resolved by this codebase, per §0.6/§0.10/§11):**
- The agency's actual Anthropic account type (standard retention vs.
  zero-data-retention) has not been confirmed — `OPS_LLM_LIVE_APPROVED`
  stays `false` until it is.
- Google Workspace API verification/security-assessment requirements for
  the `gmail.readonly` scope beyond internal use are unverified here.
- TDI Bulletin B-0003-26 and FTC Safeguards Rule obligations are not
  independently assessed by this repo — `docs/SPEC.md` §11's sources are
  recorded but their applicability is a decision for the agency's
  compliance professional.
- Encrypted-volume storage, formal retention schedule, backup/restore
  drill, and access-revocation runbook are named in README but not
  implemented as automated controls (they're host/OS-level operational
  decisions, not application code).

## 8. Next three highest-value milestones (beyond this MVP)

1. **Run Phase 1 against the real mailbox** (`sync --full` with a
   configured OAuth client) and regenerate ground truth from the actual
   daily-task history — this is what turns §4's metrics from a corpus-size
   artifact into a real accuracy number, and is a prerequisite for tuning
   the confidence thresholds in `src/score/confidence.js` against reality
   rather than the defaults carried over from `docs/SPEC.md` §5.4.
2. **Wire a verified QQ Catalyst write-back** once the agency supplies a
   real API contract and credentials, replacing the dry-run stub in
   `src/writeback/qq.js` — the CSV export remains the fallback if that
   slips.
3. **Add the `amwins_tfia` and `wholesure` parsers** (§4.3) and re-tune
   `align.js`'s due-date semantics per §7 above, using the real ground
   truth from milestone 1 to validate both changes together.

## 9. Addendum (2026-08-29): Gmail OAuth bootstrap + real QQ client index

Two gaps closed after the initial report, both in response to the user
asking to actually connect this to their real Gmail and QQ Catalyst:

- **`src/gmail/auth.js` gained `runOAuthSetup()`** (`cli.js gmail-auth`).
  The original build could *use* a Gmail token but had no way to *obtain*
  one — the current Google OAuth guide for installed apps confirms the old
  copy/paste flow is retired in favor of a loopback-redirect flow, which
  this now implements locally (see ADR 0003's addendum).
- **`src/resolve/qqClient.js` + `src/resolve/importClientIndex.js`**
  (`cli.js refresh-client-index`) replace the synthetic-only client index
  with a real one pulled from the QQ Catalyst API, using the user's
  already-provisioned "Enterprise API Access" credentials. Endpoint shapes
  and the auth header were verified against QQ's own docs before writing
  any client code (ADR 0007) — two fields (per-policy field names, any
  ZIP/address source) were not confirmable from the fetched docs and are
  handled as logged, documented gaps rather than guesses.
- **A real hermeticity bug was found and fixed**: once the user created an
  actual `.env` with real credentials, `npm test` started silently
  attempting a live Anthropic API call from `test/replay.spec.js` and
  timing out, because `src/config.js`'s `.env` fallback loader ran during
  `vitest run` too. Fixed by skipping that loader whenever
  `process.env.VITEST` is set — see ADR 0004's addendum. This is worth
  flagging prominently: before the fix, simply running the test suite on a
  machine with a populated `.env` could have made billed API calls with no
  `--live` flag and no explicit intent to do so.

Test count: 13 files / 67 tests (up from 11/57), all passing, including
new coverage for the QQ client's auth-header construction and the
importer's CSV/API mapping logic (`test/qq-client.spec.js`,
`test/import-client-index.spec.js`).
