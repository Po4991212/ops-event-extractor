# Ops Event Extractor — Implementation Spec

**What it is.** A pipeline that reads operational email arriving at `commercialtx@aiinsure.com`, turns each message into a typed `OpsEvent` with an account, an obligation, and a due date, deduplicates across the internal forward chain, and produces dated tasks with SLA timers.

**What it is not.** It does not send email, bind coverage, or replace QQ Catalyst. It generates drafts and tasks. A licensed human acts.

**Stack.** Node.js 20+, SQLite (`better-sqlite3`), Gmail API, Anthropic API. Same runtime as the existing `bind.js` / `intake.js` toolkit so the QQ client, the client-resolution flow, and the dry-run discipline carry over.

---

## Table of contents

- [0. Ground rules](#0-ground-rules)
- [1. Repo layout](#1-repo-layout)
- [2. Data model](#2-data-model)
- [3. Phase 1 — Corpus and ground truth](#3-phase-1--corpus-and-ground-truth)
- [4. Phase 2 — Deterministic parsers](#4-phase-2--deterministic-parsers)
- [5. Phase 3 — LLM extraction and confidence](#5-phase-3--llm-extraction-and-confidence)
- [6. Phase 4 — Tasks, SLA, write-back](#6-phase-4--tasks-sla-write-back)
- [7. Phase 5 — Replay, eval, writeup](#7-phase-5--replay-eval-writeup)
- [8. Failure modes to design against](#8-failure-modes-to-design-against)
- [9. Acceptance criteria](#9-acceptance-criteria)

---

## 0. Ground rules

These constrain every decision below. Agree on them with your teammate before writing code.

**0.1 — Dry run by default.** Same discipline as `bind.js`. No write to QQ, no Gmail label mutation, no draft creation unless `--live` is passed. Every write path logs the payload it *would* have sent.

**0.2 — Idempotent everything.** Reprocessing a message must never create a second event or a second task. Every insert is keyed on a deterministic hash. Assume you will reprocess the corpus fifty times during development, because you will.

**0.3 — Route by sender before reaching for a model.** RingCentral, Foxquilt, TWIA, HelloSign, IPFS and Progressive send fixed templates. A regex parser on those is cheaper, faster, and more reliable than an LLM. The model handles genuinely unstructured mail only. This is the single most defensible design decision in the project — protect it.

**0.4 — Confidence is computed from validators, not self-reported by the model.** Asking Claude "how confident are you" produces a number that correlates weakly with correctness. Compute confidence from things you can check: did the date parse into a plausible range, did the account resolve to exactly one client, does the policy number match a known carrier format. Use the model's own confidence only as a tiebreak. Say this in the interview.

**0.5 — Never guess an account.** Ambiguous account resolution routes to the review queue. In an insurance context, attaching a renewal deadline to the wrong client is worse than surfacing nothing. Reuse the E&O-safe resolution flow from the QQ toolkit: policy number → single name match → zip disambiguation → stop and list candidates.

**0.6 — Real data never leaves the machine.** Development runs against the live mailbox locally. Demos, the public repo, and any hosted artifact run against a synthetic corpus. Set this up in Phase 1, not at the end, or you will be scrubbing screenshots the night before an interview.

---

## 1. Repo layout

```
ops-event-extractor/
├── package.json
├── .env.example
├── README.md
├── SPEC.md                      ← this file
├── data/
│   ├── ops.db                   ← sqlite, gitignored
│   ├── raw/                     ← cached raw MIME, gitignored
│   └── synthetic/               ← committed, safe for demo
├── src/
│   ├── cli.js                   ← entrypoint, subcommands
│   ├── config.js
│   ├── db/
│   │   ├── schema.sql
│   │   ├── index.js             ← connection + migrations
│   │   └── queries.js
│   ├── gmail/
│   │   ├── auth.js
│   │   ├── sync.js              ← incremental via historyId
│   │   └── fetch.js             ← message → normalized record
│   ├── normalize/
│   │   ├── text.js              ← html→text, strip quotes/signatures
│   │   └── dates.js             ← parse + validate dates
│   ├── dedup/
│   │   ├── hash.js              ← content hash
│   │   └── semantic.js          ← cross-forward collapse
│   ├── classify/
│   │   └── route.js             ← sender/subject → handler
│   ├── parsers/
│   │   ├── registry.js
│   │   ├── ringcentral.js
│   │   ├── foxquilt.js
│   │   ├── twia.js
│   │   ├── hellosign.js
│   │   ├── ipfs.js
│   │   ├── progressive.js
│   │   ├── coisolution.js
│   │   └── dailytasks.js        ← Rita's list → ground truth
│   ├── extract/
│   │   ├── llm.js               ← Claude structured extraction
│   │   ├── schema.js            ← JSON schema for OpsEvent
│   │   └── prompt.js
│   ├── resolve/
│   │   ├── account.js           ← name/policy → QQ client
│   │   └── index.json           ← local client index cache
│   ├── score/
│   │   └── confidence.js
│   ├── events/
│   │   ├── store.js
│   │   └── sla.js
│   ├── review/
│   │   └── server.js            ← localhost review queue
│   ├── writeback/
│   │   └── qq.js                ← wraps existing QQ client
│   └── eval/
│       ├── align.js
│       ├── score.js
│       └── replay.js
└── test/
    └── fixtures/                ← redacted single messages per format
```

**Dependencies.**

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.30.0",
    "googleapis": "^140.0.0",
    "better-sqlite3": "^11.0.0",
    "commander": "^12.0.0",
    "luxon": "^3.4.0",
    "node-html-parser": "^6.1.0",
    "zod": "^3.23.0",
    "express": "^4.19.0",
    "p-limit": "^5.0.0"
  },
  "devDependencies": {
    "vitest": "^2.0.0"
  }
}
```

`luxon` over `date-fns` because carrier emails carry timezone-ambiguous dates and you need explicit zone handling. `zod` because you will validate the model's JSON output and want the error messages.

---

## 2. Data model

### 2.1 The OpsEvent

One shape for every source. A Foxquilt renewal notice, a RingCentral call summary, and a line from Rita's daily list all produce this.

```js
// src/extract/schema.js
import { z } from 'zod';

export const EventKind = z.enum([
  'renewal_due',          // policy renews on a date
  'payment_due',          // premium or installment due
  'lapse_warning',        // carrier says coverage will/did lapse
  'nonrenewal_notice',    // carrier declining to renew
  'cancellation_notice',  // pending cancellation
  'signature_required',   // bind docs, LPR, no-loss letter
  'coi_request',          // certificate requested
  'audit_request',        // premium audit outstanding
  'quote_received',       // carrier returned a quote
  'declination',          // carrier declined to quote
  'uw_question',          // underwriter needs info
  'client_commitment',    // agency promised the client something
  'endorsement_request',  // change requested to a policy
  'claim_activity',
  'other'
]);

export const OpsEvent = z.object({
  // identity
  event_key:      z.string(),              // deterministic hash, see 2.3
  source_msg_id:  z.string(),              // gmail message id
  source_thread_id: z.string(),

  // what
  kind:           EventKind,
  obligation:     z.string().max(400),     // one sentence, imperative
  due_date:       z.string().nullable(),   // ISO yyyy-mm-dd
  due_date_basis: z.enum(['stated','derived','absent']),

  // who / which
  account_name_raw: z.string().nullable(), // as written in the email
  account_id:     z.string().nullable(),   // resolved QQ client id
  owner:          z.string().nullable(),   // agency mailbox responsible
  carrier:        z.string().nullable(),
  policy_no:      z.string().nullable(),
  amount_cents:   z.number().int().nullable(),

  // provenance
  extractor:      z.enum(['parser','llm','human']),
  extractor_ref:  z.string(),              // parser name or model id
  confidence:     z.number().min(0).max(1),
  confidence_parts: z.record(z.number()),  // per-validator breakdown
  extracted_at:   z.string(),
  raw_span:       z.string().nullable()    // the text it came from
});
```

**Design note worth defending.** `due_date_basis` distinguishes a date the email stated from one you derived ("renews in 60 days" → compute it) from one that doesn't exist. Collapsing those three is how you end up with confidently wrong deadlines.

### 2.2 SQLite schema

```sql
-- src/db/schema.sql
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS messages (
  id                TEXT PRIMARY KEY,      -- gmail message id
  thread_id         TEXT NOT NULL,
  history_id        TEXT,
  internal_date     INTEGER NOT NULL,      -- epoch ms
  from_addr         TEXT NOT NULL,
  from_domain       TEXT NOT NULL,
  to_addrs          TEXT,                  -- json array
  cc_addrs          TEXT,
  subject           TEXT,
  label_ids         TEXT,                  -- json array
  body_text         TEXT,                  -- normalized, quotes stripped
  body_full         TEXT,                  -- normalized, quotes intact
  attachment_names  TEXT,                  -- json array
  content_hash      TEXT NOT NULL,
  fetched_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_hash   ON messages(content_hash);
CREATE INDEX IF NOT EXISTS idx_msg_from   ON messages(from_domain);
CREATE INDEX IF NOT EXISTS idx_msg_date   ON messages(internal_date);

CREATE TABLE IF NOT EXISTS events (
  event_key         TEXT PRIMARY KEY,
  source_msg_id     TEXT NOT NULL REFERENCES messages(id),
  source_thread_id  TEXT NOT NULL,
  kind              TEXT NOT NULL,
  obligation        TEXT NOT NULL,
  due_date          TEXT,
  due_date_basis    TEXT NOT NULL,
  account_name_raw  TEXT,
  account_id        TEXT,
  owner             TEXT,
  carrier           TEXT,
  policy_no         TEXT,
  amount_cents      INTEGER,
  extractor         TEXT NOT NULL,
  extractor_ref     TEXT NOT NULL,
  confidence        REAL NOT NULL,
  confidence_parts  TEXT,
  raw_span          TEXT,
  status            TEXT NOT NULL DEFAULT 'new',
                    -- new | queued | auto | dismissed | superseded | done
  superseded_by     TEXT,
  extracted_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ev_status  ON events(status);
CREATE INDEX IF NOT EXISTS idx_ev_due     ON events(due_date);
CREATE INDEX IF NOT EXISTS idx_ev_account ON events(account_id);

CREATE TABLE IF NOT EXISTS tasks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key         TEXT NOT NULL REFERENCES events(event_key),
  title             TEXT NOT NULL,
  due_date          TEXT,
  sla_first_action  TEXT,                  -- when to nudge
  owner             TEXT,
  state             TEXT NOT NULL DEFAULT 'open',
  qq_note_id        TEXT,                  -- null until written back
  created_at        INTEGER NOT NULL,
  UNIQUE(event_key)
);

CREATE TABLE IF NOT EXISTS review_queue (
  event_key         TEXT PRIMARY KEY REFERENCES events(event_key),
  reason            TEXT NOT NULL,
  candidates        TEXT,                  -- json, e.g. account matches
  resolved_at       INTEGER,
  resolution        TEXT                   -- json patch the human applied
);

CREATE TABLE IF NOT EXISTS ground_truth (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  source_msg_id     TEXT NOT NULL,
  source_line       TEXT NOT NULL,
  account_name_raw  TEXT,
  kind              TEXT,
  obligation        TEXT,
  due_date          TEXT,
  observed_on       TEXT NOT NULL          -- date of the daily email
);

CREATE TABLE IF NOT EXISTS llm_calls (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  msg_id            TEXT,
  model             TEXT NOT NULL,
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  cost_cents        REAL,
  latency_ms        INTEGER,
  ok                INTEGER,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
  key               TEXT PRIMARY KEY,
  value             TEXT
);
```

### 2.3 The event key — get this right first

Everything downstream depends on it. Two copies of the same obligation arriving through three mailboxes must collapse to one row.

```js
// src/dedup/hash.js
import crypto from 'node:crypto';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);

/** Hash of the message content, for "have I seen this exact mail". */
export function contentHash(msg) {
  const norm = [
    msg.from_addr.toLowerCase(),
    (msg.subject || '').replace(/^(re|fwd|fw):\s*/gi, '').trim().toLowerCase(),
    (msg.body_text || '').replace(/\s+/g, ' ').trim().slice(0, 4000)
  ].join('\u0000');
  return sha(norm);
}

/**
 * Hash of the *obligation*, for "is this the same duty I already know about".
 * Deliberately excludes the message — a renewal for policy X due on date Y
 * is one event no matter who forwarded it or how many times.
 */
export function eventKey(ev) {
  const parts = [
    ev.kind,
    (ev.policy_no || '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
    (ev.account_name_raw || '').toLowerCase().replace(/[^a-z0-9]/g, ''),
    ev.due_date || ''
  ];
  // require at least one strong identifier, else fall back to message scope
  if (!parts[1] && !parts[2]) return sha(`msg:${ev.source_msg_id}:${ev.kind}`);
  return sha(parts.join('|'));
}
```

**Why the fallback matters.** If an event has neither a policy number nor an account name, it cannot be deduplicated meaningfully and must stay scoped to its message. Silently merging those would collapse unrelated obligations.

**Supersession, not deletion.** When a later message changes a due date for the same policy and kind, write a new event and set `superseded_by` on the old one. You need the history for the replay demo, and "the deadline moved" is itself information.

---

## 3. Phase 1 — Corpus and ground truth

**Goal by end of week 1:** the mailbox is local and queryable, the ground-truth set exists, and you have written zero extraction logic. Building the eval set before the pipeline is unusual and it is the thing to mention in interviews.

### 3.1 Gmail access

Scopes needed:

```
https://www.googleapis.com/auth/gmail.readonly      ← ingestion
https://www.googleapis.com/auth/gmail.modify        ← only if you label (Phase 4)
https://www.googleapis.com/auth/gmail.compose       ← only if you draft nudges (Phase 4)
```

Start with `readonly` alone. Don't request write scopes you aren't using yet.

Two auth paths:

- **OAuth desktop flow** — fastest to stand up, refresh token in `.env`, fine for one mailbox. Start here.
- **Service account with domain-wide delegation** — needed if you ever ingest `stafftx@`, `gw@`, `docs@` too. Requires Workspace admin action. Plan for it, don't block on it.

### 3.2 Sync — the detail that bites

```js
// src/gmail/sync.js
import { google } from 'googleapis';
import { db } from '../db/index.js';
import { toRecord } from './fetch.js';

const QUERY = '-in:chats';   // everything else, INCLUDING trash and spam

export async function fullSync(auth, { since = '2026/06/01' } = {}) {
  const gmail = google.gmail({ version: 'v1', auth });
  let pageToken;
  let n = 0;
  do {
    const { data } = await gmail.users.messages.list({
      userId: 'me',
      q: `${QUERY} after:${since}`,
      includeSpamTrash: true,        // ← critical, see note
      maxResults: 500,
      pageToken
    });
    for (const { id } of data.messages ?? []) {
      if (db.prepare('SELECT 1 FROM messages WHERE id=?').get(id)) continue;
      const { data: full } = await gmail.users.messages.get({
        userId: 'me', id, format: 'full'
      });
      insertMessage(toRecord(full));
      n++;
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  // store the watermark for incremental sync
  const { data: prof } = await gmail.users.getProfile({ userId: 'me' });
  db.prepare(
    'INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)'
  ).run('historyId', String(prof.historyId));
  return n;
}
```

> **`includeSpamTrash: true` is not optional.** Every RingCentral call summary in this mailbox is in Trash. If you omit this flag you will build the whole pipeline, run it, and conclude the highest-value data source doesn't exist. Spam is empty, so it costs you nothing to include.

Incremental sync after the first pass:

```js
export async function incrementalSync(auth) {
  const gmail = google.gmail({ version: 'v1', auth });
  const start = db.prepare('SELECT value FROM sync_state WHERE key=?')
                  .get('historyId')?.value;
  if (!start) return fullSync(auth);

  let pageToken, latest = start;
  const seen = new Set();
  do {
    let data;
    try {
      ({ data } = await gmail.users.history.list({
        userId: 'me', startHistoryId: start,
        historyTypes: ['messageAdded'], pageToken
      }));
    } catch (e) {
      // 404 = historyId expired (Gmail keeps ~1 week). Fall back.
      if (e.code === 404) return fullSync(auth);
      throw e;
    }
    for (const h of data.history ?? []) {
      latest = h.id;
      for (const m of h.messagesAdded ?? []) seen.add(m.message.id);
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  // ... fetch each id, insert, update watermark to `latest`
}
```

The 404-on-expired-historyId fallback is a real production behavior. Handle it in week 1 so it never surprises you.

### 3.3 Normalization

Two body fields, and you need both:

- `body_full` — everything, quoted replies intact. Used by the LLM path, because context in the quoted chain often carries the account name.
- `body_text` — quoted material and signatures stripped. Used for hashing and for parsers, so a reply doesn't change the hash of the original content.

```js
// src/normalize/text.js
const QUOTE_MARKERS = [
  /^On .+ wrote:$/m,
  /^-{2,}\s*Forwarded message\s*-{2,}$/mi,
  /^_{5,}$/m,
  /^From:\s.+$/m,
  /^Vào (Th|CN).+ đã viết:$/m        // Vietnamese Gmail quote header
];

const SIG_MARKERS = [
  /^--\s*$/m,
  /\*{0,2}Ai Insurance Services, LLC\*{0,2}/,
  /\*{3}FLOOD INSURANCE FACT\*{3}/,
  /\*\*We have a new .living. life insurance policy/
];

export function stripQuoted(text) {
  let cut = text.length;
  for (const re of QUOTE_MARKERS) {
    const m = re.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  return text.slice(0, cut).trim();
}

export function stripSignature(text) {
  let cut = text.length;
  for (const re of SIG_MARKERS) {
    const m = re.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  return text.slice(0, cut).trim();
}
```

The Vietnamese quote header and the agency's own flood-insurance footer are both in this mailbox in volume. Handling them is a five-line change that materially improves every downstream step.

### 3.4 Ground truth from the daily task emails

This is the highest-leverage hour in the project. Rita's daily emails are already structured prose with an account, an action, a status, and a follow-up date on every line.

Source shape:

```
Completed
   - HangCao LLC – Followed up on the new business process. The policy
     was bound, and the agent sent the thank-you email. Case completed.

Pending / Follow-up
   - Larry Cheek – Followed up on the renewal payment. Payment has not
     been made yet. Emailed the insured with another reminder.
     Follow-up scheduled for 8/24 ...
```

Parser sketch:

```js
// src/parsers/dailytasks.js
const SECTION = /^\s*\*?(Completed|Pending\s*\/\s*Follow-?up)\*?\s*$/i;
const ITEM    = /^\s*[-•]\s*\*?(.+?)\*?\s*[–-]\s*(.+)$/;
const FOLLOWUP= /Follow-?up scheduled for\s*\*?(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i;

export function parseDailyTasks(msg) {
  const rows = [];
  let section = null;
  // items wrap across lines — join continuations before matching
  const lines = unwrap(msg.body_text.split('\n'));
  for (const line of lines) {
    const s = SECTION.exec(line);
    if (s) { section = /Completed/i.test(s[1]) ? 'completed' : 'pending'; continue; }
    const m = ITEM.exec(line);
    if (!m || !section) continue;
    const [, account, rest] = m;
    const fu = FOLLOWUP.exec(rest);
    rows.push({
      source_msg_id: msg.id,
      source_line: line.trim(),
      account_name_raw: account.replace(/\*/g, '').trim(),
      obligation: rest.trim(),
      due_date: fu ? resolveShortDate(fu[1], msg.internal_date) : null,
      kind: inferKind(rest),      // keyword map, see below
      observed_on: isoDate(msg.internal_date)
    });
  }
  return rows;
}
```

`resolveShortDate` matters: `8/24` has no year, and near a year boundary the naive answer is wrong. Resolve relative to the message date, and if the result lands more than 60 days in the past, roll forward a year.

`inferKind` is a keyword map, deliberately dumb — this is labeling assistance, not the model under test:

```js
const KIND_HINTS = [
  [/renewal payment|premium was paid|past-due/i,        'payment_due'],
  [/pending signature|LPR|binding documents/i,          'signature_required'],
  [/issued the COI|certificate/i,                       'coi_request'],
  [/uploaded .* to QQ|downloaded/i,                     'other'],
  [/new business process/i,                             'other'],
  [/claim/i,                                            'claim_activity'],
  [/cancellation/i,                                     'cancellation_notice']
];
```

**Then hand-correct.** Run the parser, dump to CSV, and have Roger spend two hours fixing the `kind` column and flagging rows that aren't real obligations. That two hours produces a labeled set covering months. Store the corrected file in `data/` and treat it as immutable.

### 3.5 Synthetic corpus — build it now

For each real format, write one fictional example preserving the exact structure: same subject-line pattern, same field labels, same sender-domain shape (`@carrier-example.com`). Twenty to thirty messages is enough for a demo. Commit these; they are what the public repo and the demo video run against.

Sanity check before committing: grep the synthetic directory for every real client name in your accounts list and confirm zero hits.

---

## 4. Phase 2 — Deterministic parsers

**Goal by end of week 2:** the pipeline catches the Foxquilt lapse case with no LLM in the loop.

### 4.1 Routing

```js
// src/classify/route.js
import { parsers } from '../parsers/registry.js';

const NOISE = [
  /VerifyMFA@hanover\.com/i,
  /account@coterieinsurance\.com/i,
  /agentportal@wholesure\.com/i,
  /noreply@steadily\.com/i,
  /status@notifications\.ringcentral\.com/i,
  /@notification\.intuit\.com/i
];

export function route(msg) {
  if (NOISE.some(re => re.test(msg.from_addr))) return { handler: 'noise' };

  for (const p of parsers) {
    if (p.match(msg)) return { handler: 'parser', parser: p };
  }
  return { handler: 'llm' };
}
```

Order matters: noise check first (it's the largest bucket and the cheapest to decide), then parsers, then the model. Log the distribution — that histogram is a slide in your writeup.

### 4.2 A full parser — RingCentral call notes

This is the highest-value source and the easiest, because RingCentral's AI assistant has already done the extraction. You're re-homing it, not redoing it.

Real structure:

```
Dear Roger Vo, Here's the notes of your call with +12818915143 on
Friday, August 28, 2026 at 11:42 AM: Roger discussed the property renewal
quote for Brookfield Town Homes with Mr. Bits ...
Recap
 * Roger informed Mr. Bits that a quote for the Brookfield Town Homes
   renewal property was obtained ...
Tasks
 * Roger will email Mr. Bits the quote from the wholesaler, including a
   comparison table from Burner Wilcox and Bridge Specialty, within the
   next few days.
 * Roger will try to find information about the $12,000 pigtails cost ...
```

```js
// src/parsers/ringcentral.js
export default {
  name: 'ringcentral-callnotes',
  match: (msg) =>
    /service@ringcentral\.com/i.test(msg.from_addr) &&
    /^Notes of your call with/i.test(msg.subject || ''),

  parse(msg) {
    const body = msg.body_full;
    const tasksBlock = section(body, 'Tasks');
    if (!tasksBlock) return [];

    const when = parseCallTime(msg.subject, msg.internal_date);
    return bullets(tasksBlock).map(t => ({
      kind: 'client_commitment',
      obligation: t,
      // "within the next few days" / "by Friday" → derived date
      due_date: deriveDue(t, when),
      due_date_basis: deriveDue(t, when) ? 'derived' : 'absent',
      account_name_raw: guessAccount(body),  // from Recap, see below
      carrier: null,
      policy_no: firstPolicyNo(body),
      amount_cents: firstAmount(t),
      raw_span: t,
      extractor: 'parser',
      extractor_ref: 'ringcentral-callnotes'
    }));
  }
};

const section = (text, label) => {
  const re = new RegExp(`\\b${label}\\b([\\s\\S]*?)(?=\\b(Recap|Tasks|View transcript)\\b|$)`);
  return re.exec(text)?.[1]?.trim() ?? null;
};

const bullets = (block) => block
  .split(/\n?\s*\*\s+/)
  .map(s => s.replace(/\s+/g, ' ').trim())
  .filter(s => s.length > 15);
```

`guessAccount` is the interesting bit. The recap contains a business name in prose ("the property renewal quote for Brookfield Town Homes"). Rather than regexing for it, match candidate n-grams against your local client index (§4.4). If exactly one client name appears in the body, use it. If several or none, leave `account_name_raw` null and let confidence routing send it to review. **Do not** have the parser guess.

`deriveDue` handles the vague phrasings RingCentral produces:

| Phrase                       | Derived due date       | Basis     |
|------------------------------|------------------------|-----------|
| "within the next few days"   | call date + 3 business | derived   |
| "by Friday" / "on Monday"    | next such weekday      | derived   |
| "today" / "this afternoon"   | call date              | derived   |
| "shortly", "soon", "asap"    | call date + 1 business | derived   |
| no temporal phrase           | null                   | absent    |

Keep this table small and explicit. It is more defensible than asking a model, and every entry is testable.

### 4.3 The other parsers

| Parser | Match on | Extract | Event kind |
|---|---|---|---|
| `foxquilt` | `renewal-us@foxquilt.com`, `policy@foxquilt.com` | policy no, expiry date, "renewal unsuccessful" | `renewal_due` / `lapse_warning` |
| `twia` | `twia.appmail.np@twia.org` | policy ending digits, renewal offer date | `renewal_due` |
| `hellosign` | `noreply@mail.hellosign.com` | doc title, signer list, signed/pending | `signature_required` |
| `ipfs` | `donotreply@ipfs.com` | account no, installment amount, due date | `payment_due` |
| `progressive` | `BOPUWR@progressive.com` | policy no, term dates | `uw_question` / `endorsement_request` |
| `coisolution` | `Certificaterequest@mycoisolution.com`, `support@mycoitracking.com` | insured name, expiry days | `coi_request` |
| `amwins_tfia` | `tfia.renewals@amwins.com` | policy no, 45-day renewal invoice | `renewal_due` |
| `wholesure` | `@wholesure.com` + subject `NON-RENEWAL` | policy no, reason | `nonrenewal_notice` |

Write them in that order — Foxquilt second, right after RingCentral, because Foxquilt is where the actual lapse happened and you want that replay working early for morale.

Each parser gets a fixture in `test/fixtures/` (one redacted real message) and a vitest test asserting the exact extracted object. When a carrier changes their template, a test fails instead of the pipeline silently emitting nothing.

### 4.4 Account resolution

```js
// src/resolve/account.js
export function resolveAccount(nameRaw, { policyNo } = {}) {
  // 1. policy number is the strongest signal
  if (policyNo) {
    const byPolicy = lookupByPolicy(normalizePolicy(policyNo));
    if (byPolicy.length === 1) return { id: byPolicy[0].id, method: 'policy', score: 1.0 };
  }
  if (!nameRaw) return { id: null, method: 'none', score: 0, candidates: [] };

  // 2. exact normalized name
  const key = normName(nameRaw);            // lowercase, strip LLC/INC/DBA, punctuation
  const exact = lookupByName(key);
  if (exact.length === 1) return { id: exact[0].id, method: 'name_exact', score: 0.95 };

  // 3. fuzzy — return candidates, never auto-pick
  const fuzzy = fuzzyName(key, { limit: 5, minScore: 0.82 });
  if (fuzzy.length === 1 && fuzzy[0].score > 0.93)
    return { id: fuzzy[0].id, method: 'name_fuzzy', score: fuzzy[0].score };

  return { id: null, method: 'ambiguous', score: 0, candidates: fuzzy };
}
```

`normName` must handle the real patterns in this book: `HANGCAO LLC` vs `HangCao LLC DBA Alpha Nail Spa Charlotte`, `Sugar Nails of Clemson LLC` vs `Sugar Nails`, and the near-identical pair `DNA Access Services, LLC` / `DNA Access Services LLC` that produced two separate Hiscox quotes. That last one is a real duplicate in the mailbox — make it a test case, and note that your resolver flags it rather than silently merging.

Build `resolve/index.json` by pulling the client list from QQ once and caching it locally. Refresh weekly. Don't hit QQ per-message.

### 4.5 Dedup across the forward chain

Two levels:

1. **Content hash** — identical mail seen twice (the same Foxquilt notice forwarded from `docs@` three times has near-identical bodies once quotes are stripped). Skip at ingest.
2. **Event key** — different messages producing the same obligation. Collapse at event insert with `INSERT OR IGNORE`, and record the additional `source_msg_id` in a `event_sources` join table so the replay can show "this obligation arrived 3 times through 3 mailboxes."

That second stat is a good line in the writeup.

---

## 5. Phase 3 — LLM extraction and confidence

**Goal by end of week 3:** unstructured mail produces events, low-confidence ones land in a review queue, and you can report accuracy against ground truth.

### 5.1 Model routing

Two tiers, and the split is the cost story:

- **Classification** — `claude-haiku-4-5-20251001`. Given subject + first 500 chars, answer: is this operational, and which kind? Cheap, high volume.
- **Extraction** — `claude-sonnet-5`. Only for messages classified operational and not handled by a parser.

Run classification on everything the parsers don't claim; run extraction on maybe a third of those. Log both to `llm_calls` and report cost per thousand messages versus a naive send-everything-to-Sonnet baseline.

### 5.2 Extraction call

Use a tool definition to force schema conformance rather than asking for JSON in prose.

```js
// src/extract/llm.js
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic();

const TOOL = {
  name: 'record_ops_events',
  description: 'Record every operational obligation found in the email.',
  input_schema: {
    type: 'object',
    properties: {
      events: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: [/* EventKind values */] },
            obligation: { type: 'string',
              description: 'One imperative sentence describing what must be done.' },
            due_date: { type: ['string','null'],
              description: 'ISO yyyy-mm-dd. Null if the email states no date.' },
            due_date_basis: { type: 'string', enum: ['stated','derived','absent'] },
            account_name_raw: { type: ['string','null'],
              description: 'Business name exactly as written in the email. Do not infer.' },
            carrier: { type: ['string','null'] },
            policy_no: { type: ['string','null'] },
            amount_cents: { type: ['integer','null'] },
            raw_span: { type: 'string',
              description: 'The verbatim sentence this was extracted from.' },
            model_confidence: { type: 'number' }
          },
          required: ['kind','obligation','due_date','due_date_basis',
                     'account_name_raw','raw_span','model_confidence']
        }
      }
    },
    required: ['events']
  }
};

export async function extract(msg, { today }) {
  const res = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 2000,
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: 'record_ops_events' },
    messages: [{ role: 'user', content: renderMessage(msg, today) }]
  });
  logCall(msg.id, res);
  const block = res.content.find(c => c.type === 'tool_use');
  return block?.input?.events ?? [];
}
```

### 5.3 The system prompt

```
You extract operational obligations from insurance agency email.

An obligation is something a specific party must do by a specific time:
a renewal that must be shopped, a premium that must be paid, a document
that must be signed, a certificate that must be issued, an underwriter
question that must be answered, a commitment the agency made to a client.

Rules:
- Extract only what the email states. Never infer an account name from
  context, a carrier from a domain, or a date from an assumption.
- If the email states no date, set due_date null and due_date_basis
  "absent". If it states a relative time ("in 60 days", "by Friday"),
  compute it from TODAY, given below, and set basis "derived".
- account_name_raw is the business name as written. If the email refers
  only to a person, leave it null.
- raw_span must be copied verbatim from the email.
- Marketing, newsletters, MFA codes, delivery receipts and out-of-office
  replies contain no obligations. Return an empty array.
- One email may contain several obligations. One sentence is at most one.
```

Two things this prompt is doing deliberately: forbidding inference (the model's instinct is to be helpful and fill gaps, which is exactly the failure mode you can't afford) and requiring `raw_span` (it grounds the output and gives your review queue something to display).

### 5.4 Confidence — computed, not asked

```js
// src/score/confidence.js
export function score(ev, ctx) {
  const parts = {};

  // date validity
  if (ev.due_date_basis === 'absent') parts.date = 0.6;
  else {
    const d = parseISO(ev.due_date);
    const days = daysFrom(ctx.today, d);
    parts.date = !d.isValid ? 0
      : days < -400 || days > 800 ? 0.2      // implausible range
      : ev.due_date_basis === 'stated' ? 1.0 : 0.8;
  }

  // account resolution
  parts.account = ({ policy: 1.0, name_exact: 0.95, name_fuzzy: 0.75,
                     ambiguous: 0.3, none: 0.2 })[ctx.resolution.method];

  // policy number plausibility against known carrier formats
  parts.policy = !ev.policy_no ? 0.6
    : matchesKnownFormat(ev.policy_no) ? 1.0 : 0.5;

  // grounding: raw_span must actually appear in the source
  parts.grounding = ctx.body.includes(ev.raw_span?.slice(0, 60) ?? '') ? 1.0 : 0.0;

  // extractor prior
  parts.extractor = ev.extractor === 'parser' ? 1.0 : 0.85;

  // model self-report, small weight, tiebreak only
  parts.model = clamp(ev.model_confidence ?? 0.7, 0, 1);

  const weights = { date: .25, account: .30, policy: .10,
                    grounding: .20, extractor: .10, model: .05 };
  const total = Object.entries(weights)
    .reduce((s,[k,w]) => s + w * (parts[k] ?? 0), 0);

  // hard gates override the weighted score
  if (parts.grounding === 0) return { total: 0, parts, gate: 'hallucinated_span' };
  if (parts.date === 0)      return { total: 0, parts, gate: 'unparseable_date' };

  return { total, parts, gate: null };
}
```

**The grounding check is the most valuable line in this file.** If the model's `raw_span` doesn't appear in the source text, it invented content, and the event is discarded regardless of everything else. It's a cheap, deterministic hallucination detector, and it's exactly the kind of thing interviewers want to hear you built rather than trusted the model to avoid.

Routing thresholds — tune against ground truth in Phase 5, start here:

```
total >= 0.85  → status 'auto'      (becomes a task)
0.55 – 0.85    → status 'queued'    (review queue)
< 0.55         → status 'queued' with reason, low priority
gate != null   → discarded, logged
```

### 5.5 Review queue

Keep it plain. An Express app on `localhost:8766` (adjacent to the existing `:8765/drop`), one table, each row showing: the extracted event, the `raw_span` with the source subject, the account candidates as a dropdown, and Accept / Edit / Dismiss.

The critical part: **every human action writes to `review_queue.resolution` as a JSON patch.** Those patches are new labeled examples. After a few weeks you have a second eval set drawn from the model's actual weak spots, which is worth more than the original one.

---

## 6. Phase 4 — Tasks, SLA, write-back

### 6.1 SLA table

```js
// src/events/sla.js
export const SLA = {
  renewal_due:         { firstAction: -45, escalate: -20, critical: -7 },
  payment_due:         { firstAction: -10, escalate:  -3, critical: -1 },
  lapse_warning:       { firstAction:   0, escalate:   0, critical:  0 },
  nonrenewal_notice:   { firstAction:   0, escalate:  +2, critical: +5 },
  cancellation_notice: { firstAction:   0, escalate:  +1, critical: +3 },
  signature_required:  { firstAction:  +1, escalate:  +3, critical: +7 },
  coi_request:         { firstAction:   0, escalate:  +1, critical: +2 },
  audit_request:       { firstAction:  +2, escalate:  +7, critical: +14 },
  uw_question:         { firstAction:  +1, escalate:  +2, critical: +4 },
  client_commitment:   { firstAction:  +2, escalate:  +5, critical: +10 },
  quote_received:      { firstAction:  +1, escalate:  +3, critical: +7 }
};
// negative = days BEFORE due_date; positive = days AFTER event date
```

The renewal numbers come from the agency's own behavior. Foxquilt sends its first notice at 60 days out; the Little P thread shows Roger asking for a QQ alert at 30 days. Forty-five days is a defensible first action, and it would have caught the Escamillia lapse with a month to spare.

`lapse_warning` at 0/0/0 is deliberate — that's already a fire.

### 6.2 Nudge drafts

Generate, never send. Write to Gmail drafts only under `--live`, and prefix subjects with a marker while developing so nothing can be mistaken for an outbound message.

Two variants per nudge, matching how you already work: one leading with a recommendation, one presenting options neutrally.

### 6.3 QQ write-back

You have two open blockers here: the 417 on note creation and permanent Vertafore credentials. **Do not let Phase 4 depend on them.** Structure it so:

```js
// src/writeback/qq.js
export async function pushTask(task, { live = false }) {
  const payload = buildNotePayload(task);
  if (!live) { logDryRun(payload); return { ok: true, dryRun: true }; }
  return qqClient.createNote(payload);   // existing client from bind.js
}
```

The pipeline is complete and demonstrable with `pushTask` in dry-run. Credentials landing later is a config change, not a rework. If the 417 is still open when you get here, ship with a CSV export of open tasks as the interim surface — Rita can work from that, and it proves the value without blocking on Vertafore.

---

## 7. Phase 5 — Replay, eval, writeup

### 7.1 Alignment

To score extraction against Rita's daily lists you must match predicted events to ground-truth rows. Match on `(normalized account, kind, due_date within ±2 days)`, then Hungarian-assign the leftovers within the same account. Report unmatched in both directions — false positives and misses are different failures and lumping them hides the interesting one.

### 7.2 Metrics to report

| Metric | Why it's there |
|---|---|
| Event-level precision / recall / F1 | The headline |
| Per-field exact match: account, kind, due_date | Shows *where* it fails |
| Breakdown by `extractor` (parser vs llm) | Justifies the routing decision |
| Breakdown by source domain | Shows which carrier formats are weak |
| Review-queue rate | The human-cost number the agency cares about |
| Precision within `auto` band only | The number that actually matters — what ships unreviewed |
| Cost per 1,000 messages, routed vs naive | The efficiency story |
| p50 / p95 latency per message | Production awareness |

**Precision within the auto band is the headline metric**, not overall F1. Nobody is harmed by an event that went to review. The question is how often something auto-created is wrong.

### 7.3 The replay

```bash
node src/cli.js replay --from 2026-06-01 --to 2026-08-29 --as-of-mode
```

`--as-of-mode` processes messages in chronological order and only lets the pipeline see what existed at that point — no lookahead. Then assert specific recoveries:

```js
// test/replay.spec.js
it('flags the Escamillia renewal before the lapse', () => {
  const ev = findEvent({ account: /escamillia/i, kind: 'renewal_due' });
  expect(ev).toBeTruthy();
  expect(ev.sla_first_action).toBeLessThan('2026-08-22');   // lapse date
});

it('surfaces Tobacco & Vapor 12 in March, not August', () => {
  const ev = findEvent({ account: /tobacco.*vapor/i, kind: 'renewal_due' });
  expect(ev.extracted_at).toBeLessThan(Date.parse('2026-04-01'));
});

it('collapses the Stars Plumbing notice forwarded three times', () => {
  const evs = findEvents({ account: /stars plumbing/i, kind: 'renewal_due' });
  expect(evs).toHaveLength(1);
  expect(sourcesFor(evs[0])).toHaveLength(3);
});
```

**Those three tests are the demo.** Each maps to a real documented failure. Passing them is a stronger claim than any accuracy figure, and it's what you open the case study with.

### 7.4 The writeup

Structure it as: the failure, the system, the measurement, the limits.

Lead with the lapse. State the architecture in one diagram. Show the metrics table including the numbers that are bad. Close with an honest limits section — what it doesn't handle, what you'd do with another month, where the human stays in the loop and why. Reviewers trust a writeup with a limits section far more than one without.

---

## 8. Failure modes to design against

| Failure | Where it bites | Mitigation |
|---|---|---|
| Gmail `historyId` expires (~1 week) | Incremental sync 404s | Fall back to full sync, §3.2 |
| Carrier changes email template | Parser silently returns `[]` | Fixture test per parser; alert on zero-yield from a sender that historically yielded |
| Model invents a due date | Wrong deadline on a real account | Grounding gate, §5.4 |
| Two clients with near-identical names | Event on the wrong account | Resolver returns candidates, never auto-picks, §4.4 |
| Same obligation, three forwards | Duplicate tasks | Event key, §2.3 |
| Deadline moves in a later email | Stale task | Supersession chain, §2.3 |
| Reprocessing creates duplicates | Corrupted dev data | Deterministic keys + `INSERT OR IGNORE` |
| Test data leaks a client name | Interview goes badly | Synthetic corpus from Phase 1, grep check before commit |
| Vertafore credentials don't land | Phase 4 blocked | Dry-run + CSV export path, §6.3 |
| Rate limits on bulk backfill | Sync stalls | `p-limit` at 5 concurrent, exponential backoff |

---

## 9. Acceptance criteria

Ship a phase only when its box is checked.

**Phase 1**
- [ ] Full mailbox 06/01–present in SQLite, including Trash
- [ ] Incremental sync survives an expired `historyId`
- [ ] `body_text` correctly strips Vietnamese quote headers and the agency footer
- [ ] Ground-truth table populated from daily task emails and hand-corrected
- [ ] Synthetic corpus committed, grep-verified clean

**Phase 2**
- [ ] Eight parsers, each with a fixture test
- [ ] Routing histogram reported: noise / parser / llm
- [ ] Stars Plumbing triple-forward collapses to one event
- [ ] Escamillia renewal produces a `renewal_due` event with a correct date
- [ ] Zero LLM calls made in this phase

**Phase 3**
- [ ] LLM path emits schema-valid events or fails loudly
- [ ] Grounding gate rejects a deliberately hallucinated span in a test
- [ ] Confidence thresholds tuned against ground truth, chosen numbers documented
- [ ] Review queue runs, resolutions persist as JSON patches
- [ ] Cost per 1,000 messages logged, routed vs naive baseline

**Phase 4**
- [ ] Events become tasks with SLA dates
- [ ] Nudge drafts generated in both variants, nothing sent
- [ ] QQ write-back works in dry-run; live path guarded by `--live`
- [ ] CSV export of open tasks

**Phase 5**
- [ ] `--as-of-mode` replay runs clean over the full window
- [ ] Three recovery tests pass
- [ ] Metrics table complete, including auto-band precision
- [ ] Case study, public repo on synthetic data, two-minute demo video

---

## Start here, Monday

1. `npm init`, install deps, create `data/`, write `schema.sql`, get `db/index.js` opening a connection.
2. Google Cloud project → Gmail API enabled → OAuth desktop client → refresh token in `.env`.
3. `node src/cli.js sync --full --since 2026/06/01`, **with `includeSpamTrash: true`**. Confirm you have RingCentral messages in the table. If you have zero, that flag is wrong.
4. `node src/cli.js parse-daily-tasks > data/ground_truth_draft.csv`. Hand-correct it.

Everything else follows from having the corpus and the labels on disk.
