# Ops Event Extractor

A pipeline that reads operational email, turns each message into a typed
`OpsEvent` (an account, an obligation, and a due date), deduplicates across
the internal forward chain, and produces dated tasks with SLA timers.

**What it is not.** It does not send email, bind coverage, or replace QQ
Catalyst. It generates drafts and tasks; a licensed human acts. See
`docs/SPEC.md` §0 for the full set of non-negotiable ground rules (dry-run
by default, idempotent, never guess an account, human review controls
consequential action, email is untrusted input).

- **Full specification:** [docs/SPEC.md](docs/SPEC.md) — the original,
  complete implementation spec this repo was built from. The repo's earlier
  README (an older draft of the same spec) is preserved in git history
  (commit `4ec58e7`) and superseded by `docs/SPEC.md`, which is the fuller,
  later version and the one this implementation follows.
- **Design decisions:** [docs/adr/](docs/adr/) — records every place this
  implementation had to make a call the spec left open (missing existing
  toolkit, package/model version pinning, Gmail scopes, Anthropic data flow,
  synthetic-data policy, Node version).
- **Sources verified before implementation:**
  [docs/research-sources.md](docs/research-sources.md).
- **Engineering report:**
  [docs/ENGINEERING_REPORT.md](docs/ENGINEERING_REPORT.md) — what's built,
  metrics, open items, next milestones.

## Status

A complete, runnable, tested vertical slice running on synthetic data by
default. Live Gmail/QQ/Anthropic integration is coded and gated but not
exercised in this environment — see "Modes" below and the engineering
report's open-items list.

## Setup

```bash
npm install
node --env-file=.env src/cli.js migrate        # or: cp .env.example .env first
node --env-file=.env src/cli.js seed-synthetic  # loads data/synthetic/messages.json
node --env-file=.env src/cli.js run             # routes → parses/extracts → scores → tasks
node --env-file=.env src/cli.js replay          # §7.3 as-of-mode replay + metrics
```

Node 22 supports `--env-file` natively (this repo targets v22.16.0 — see
`docs/adr/0005-node-version.md`); `src/config.js` also loads `.env` itself
as a fallback so plain `node src/cli.js ...` works too. No `.env` is
required at all to run the default synthetic workflow — every value has a
safe default, and `OPS_MODE` defaults to `synthetic`.

```bash
npm test          # vitest — 75 tests: parsers, dedup, dates, resolution,
                   # confidence gating, the 3 §7.3 recovery scenarios,
                   # security/privacy static checks, QQ client + write-back
npm run review     # starts the localhost review queue (default port 8766)
```

## Does this cost tokens?

Only when you explicitly ask it to. The 7 deterministic parsers (Foxquilt,
TWIA, RingCentral, HelloSign, IPFS, Progressive, COI) handle their mail for
**$0**, no API call. `cli.js run` and `cli.js replay` skip the LLM tier
entirely unless you pass **`--llm`** — this is a separate, explicit switch
from having `ANTHROPIC_API_KEY` set, added after an early test here made
real (tiny — 2.4¢) unplanned API calls once a real key was in `.env`. See
`docs/adr/0004`'s addendum for the full story. `replay`'s output reports
`costCentsPer1000` from the real `llm_calls` log whenever `--llm` is used,
so you can see the actual number for your mailbox before deciding it
matters.

## Modes

| | `OPS_MODE=synthetic` (default) | `OPS_MODE=live` |
|---|---|---|
| Data source | `data/synthetic/messages.json` only | the real Gmail mailbox |
| Gmail calls | none | `gmail.readonly` (see ADR 0003) |
| Anthropic calls | only with `--llm` (see above); then allowed freely — no real client data at risk | only with `--llm` **and** `OPS_LLM_LIVE_APPROVED=true` (ADR 0004) — otherwise the LLM path is skipped, not silently run |
| QQ / Gmail draft writes | dry-run, logged | dry-run unless `--live` **and** the relevant `*_LIVE_*APPROVED` flag **and**, for QQ, the account resolved to a real numeric QQ contact id (not the synthetic index) |

Fails closed: anything other than the literal string `live` for `OPS_MODE`
is treated as synthetic.

## What's not wired to a real backend

- **QQ Catalyst write-back** (`src/writeback/qq.js`): now calls a
  verified real endpoint (`PUT v1/Contacts/Notes`, full schema confirmed —
  see `docs/adr/0001`'s addendum and `docs/adr/0007`) when `--live`,
  `QQ_LIVE_WRITES_APPROVED=true`, and a real numeric account id are all
  present; otherwise it dry-runs and logs. It has not been exercised
  against the live API in this environment — treat it as code-reviewed
  against a verified schema, not field-tested, until it has. `cli.js
  export-tasks` (CSV) remains available as a fallback surface.
- **Live Gmail sync / OAuth**: coded per the current Gmail API sync guide
  (`docs/adr/0003`) but not exercised here — no OAuth client is configured
  in this environment. Configure `GMAIL_OAUTH_CLIENT_ID/SECRET`, run
  `cli.js gmail-auth` once to obtain a refresh token, then `cli.js sync
  --full` to backfill a real mailbox once approved. See "Live Gmail setup"
  below for the full walkthrough.
- **Live Anthropic extraction on real mail**: gated behind
  `OPS_LLM_LIVE_APPROVED`, which defaults `false` until the agency confirms
  its Anthropic account/retention arrangement (`docs/adr/0004`).

None of the above block the synthetic vertical slice — see
`docs/SPEC.md` §10: "Live Gmail or QQ credentials are integration
acceptance items, not prerequisites for a complete synthetic vertical
slice."

## CLI reference

```
migrate                  Apply the SQLite schema (idempotent)
seed-synthetic            Load data/synthetic/messages.json
gmail-auth                 One-time OAuth setup → writes GMAIL_TOKEN_STORE_PATH
sync [--full]              Live Gmail sync (requires OPS_MODE=live)
parse-daily-tasks [--write-db]   Ground truth from daily-task-summary emails → CSV
run                        Process every stored message → events → tasks
replay [--from] [--to]     §7.3 as-of-mode replay + §7.2 metrics
export-tasks               CSV of open tasks (the QQ interim surface)
qq-push-dry-run            Demonstrate the QQ dry-run write-back path
nudge-drafts               Print both nudge draft variants (never sends)
refresh-client-index        Rebuild the real client index from QQ Catalyst (--from-csv for a manual export)
```

## Real QQ client index (applying account resolution to your book of business)

`src/resolve/account.js` (§4.4's E&O-safe resolution flow) reads a client
list to match a policy number or account name to a real client id. By
default that list is the committed synthetic one (`src/resolve/index.json`)
— safe for demos, useless for real matching. To point it at your actual
QQ Catalyst data (verified against api.qqcatalyst.com's own docs — see
`docs/adr/0007`):

1. Add to `.env` (see the updated `.env.example` for the full list):
   ```
   QQ_API_CLIENT_ID=<your Enterprise API Access client id>
   QQ_API_CLIENT_SECRET=<your Enterprise API Access client secret>
   QQ_CLIENT_INDEX_PATH=data/private/client-index.json
   ```
   `QQ_CLIENT_INDEX_PATH` must stay outside `src/` — `writeClientIndex()`
   refuses to write there in code, not just by convention, because
   `src/resolve/index.json` is committed to the public repo.

2. Pull it:
   ```bash
   node --env-file=.env src/cli.js refresh-client-index --since 2020-01-01
   ```
   This paginates your customer list, pulls each customer's policies, and
   writes the mapped index. `loadClientIndex()` logs which source is
   active (`SYNTHETIC` vs `REAL (path)`) the first time anything resolves
   an account, specifically so it's never ambiguous which one a given run
   used.

The importer also pulls each customer's ZIP from `GET
/Contacts/{contactID}/Addresses` (so `resolveAccount()`'s optional
zip-disambiguation step has real data to work with) and policy numbers
from `GET /Policies/ByCustomer/{customerID}`. **One remaining unconfirmed
field, not a silent guess** (full detail in `docs/adr/0007`): the exact
field names for a policy number and a ZIP on their respective individual
records weren't shown in QQ's docs (a resource-model page errored for
policies; addresses weren't documented at all beyond the endpoint path).
The importer tries a few plausible names for each and, if none match,
logs the real field names it saw (not values) on the first mismatch —
check your terminal output after the first `refresh-client-index` run and
tell me what it printed if that happens; it's a one-line fix in
`src/resolve/importClientIndex.js`.

If you'd rather import a manual CSV export instead of hitting the API,
`--from-csv` plus the `QQ_EXPORT_*` column-name variables in `.env.example`
handle that path too.

## Live Gmail setup (applying this to a real mailbox)

Everything below runs entirely on your own machine — no credential, token,
or mailbox content is ever sent through chat or to me. Steps 1–3 are a
one-time setup.

1. **Google Cloud project + OAuth client.**
   In the [Google Cloud Console](https://console.cloud.google.com/):
   enable the **Gmail API** for a project, then create an OAuth 2.0 Client
   ID of type **Desktop app** (not "Web application" — Desktop-type clients
   accept any `127.0.0.1` port automatically, which the flow below relies
   on). Copy the generated Client ID and Client Secret.

2. **Configure `.env`.**
   ```bash
   cp .env.example .env
   ```
   Edit `.env`:
   ```
   OPS_MODE=live
   GMAIL_OAUTH_CLIENT_ID=<paste>
   GMAIL_OAUTH_CLIENT_SECRET=<paste>
   GMAIL_TOKEN_STORE_PATH=C:/Users/Roger/.ops-event-extractor/gmail.token.json
   GMAIL_MAILBOX=<the mailbox you're authorizing>
   GMAIL_SYNC_SINCE=2026/06/01
   ```
   Put `GMAIL_TOKEN_STORE_PATH` **outside** this repo (e.g. a dotfile under
   your home directory) — it holds a live refresh token and must never be
   committed. `.env` itself is already gitignored.

3. **Authorize once.**
   ```bash
   node --env-file=.env src/cli.js gmail-auth
   ```
   This prints a Google consent URL — open it in a browser signed in to
   the mailbox you want to read, approve `gmail.readonly` access, and the
   local process catches the redirect automatically and writes the token
   file. If you ever want to revoke access, remove it at
   [myaccount.google.com/permissions](https://myaccount.google.com/permissions)
   and delete the token file.

4. **Backfill and run.**
   ```bash
   node --env-file=.env src/cli.js sync --full     # includeSpamTrash:true — this is required, see docs/SPEC.md §3.2
   node --env-file=.env src/cli.js run              # routes/parses/extracts every synced message
   node --env-file=.env src/cli.js parse-daily-tasks --write-db   # if your mailbox has a similar daily-summary format
   node --env-file=.env src/cli.js replay           # metrics against ground truth, once you have some
   node --env-file=.env src/cli.js export-tasks      # CSV of what would become tasks
   ```
   `sync` without `--full` after the first run does an incremental sync via
   Gmail's `historyId` and falls back to a full sync automatically if that
   watermark has expired (§3.2/ADR 0003).

**What stays off by default even in live mode**, and what you'd need to
change deliberately:
- **LLM extraction on real mail** stays off until you also set
  `OPS_LLM_LIVE_APPROVED=true` — a second, independent switch from
  `OPS_MODE=live` (see "Modes" above and `docs/adr/0004`). Until then,
  messages that don't match one of the 7 deterministic parsers are left
  unprocessed rather than silently sent to Claude.
- **QQ write-back and Gmail drafts** stay dry-run regardless of `OPS_MODE`
  unless you also pass `--live` on the relevant commands, and QQ writes
  additionally require `QQ_LIVE_WRITES_APPROVED=true` plus a real
  `QQ_API_BASE_URL` — which this repo doesn't have a verified contract for
  yet (see `docs/adr/0001` and "What's not wired to a real backend" above).
- **Account resolution** runs against the synthetic client list in
  `src/resolve/index.json` regardless of mode — pointing it at your real
  QQ client list (export it once, refresh weekly per §4.4) is the one
  piece of "your current Gmail" wiring not yet built; ask me for it if you
  want it and I'll add a real loader for whatever export format QQ gives
  you.

## Security, privacy, and retention

- **Dry-run by default; live fails closed.** See "Modes" above.
- **Secrets never live in the repo.** `.env` is gitignored; `.env.example`
  has no real values. Gmail refresh tokens and QQ tokens are expected in an
  OS credential store or a separate, owner-readable, gitignored file
  (`GMAIL_TOKEN_STORE_PATH`), never inline in `.env`.
- **Real mailbox data never leaves the machine except the minimum text sent
  to an agency-approved Anthropic account**, and only once that approval
  and retention arrangement is confirmed (`OPS_LLM_LIVE_APPROVED=true`) —
  see `docs/adr/0004-anthropic-data-flow-and-live-gate.md`.
- **Email is treated as untrusted input.** The extraction prompt's
  untrusted-content policy plus a hallucination-detecting grounding gate
  (`src/score/confidence.js`) are tested against injection fixtures in
  `test/prompt-injection.spec.js` (structural checks — no live model call).
- **No outbound-send path exists.** `test/no-send-endpoint.spec.js` greps
  all of `src/` for Gmail's send endpoints and fails the build if either
  appears.
- **Synthetic-only test/demo data.** `test/no-real-names.spec.js` greps
  committed synthetic/test data for every proper noun `docs/SPEC.md`'s own
  narrative uses as a "real mailbox" example, and fails if any appear — see
  `docs/adr/0006-synthetic-data-policy.md`.
- **Retention, deletion, backup, incident response, and access
  revocation** for a real deployment are agency operational decisions this
  repo does not make. `data/private/` (gitignored) is the designated
  location for any real mailbox export or corrected ground truth, per
  `docs/SPEC.md` §1; deleting that directory and rotating the credentials
  referenced in `.env`/the token store is the rollback/incident-response
  procedure this repo assumes. This is a starting point, not a compliance
  sign-off — see `docs/SPEC.md` §11's closing note and the engineering
  report's open-items list for what still needs the agency's compliance
  professional.

## Repo layout

See `docs/SPEC.md` §1 for the intended layout; `docs/ENGINEERING_REPORT.md`
has the as-built file map and notes every place this implementation
diverged from it (and why).
