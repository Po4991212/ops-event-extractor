# ADR 0001: No existing bind.js/intake.js/QQ toolkit found — built self-contained equivalents

## Status
Accepted

## Context
The spec (docs/SPEC.md) repeatedly instructs reuse rather than duplication of an
"existing" toolkit: a `bind.js` / `intake.js` pair, a QQ Catalyst client, an
E&O-safe account-resolution flow, a dry-run discipline, and a review server
already running on `localhost:8765/drop`.

Before writing any pipeline code, the repository and the rest of this
machine's `~/Projects` tree were searched:

- `ops-event-extractor` (this repo) contained only `README.md` and an
  untracked `plan.txt` (the spec itself) — no `src/`.
- `find ~/Projects -iname bind.js -o -iname intake.js` returned only
  `node_modules/lodash/bind.js` inside an unrelated Angular project — not a
  toolkit file.
- `insurance-browser-agent`, the only other insurance-adjacent project in
  `~/Projects`, is a Python/Playwright browser-automation agent with no
  Gmail, QQ, or bind/intake code, and no shared vocabulary with this spec.
- No `:8765` review server, no QQ Catalyst client module, and no `.env`
  containing QQ/Vertafore credentials were found anywhere in `~/Projects`.

Ground rule 0.9 forbids requesting live credentials, and the top-level
instructions forbid guessing a real vendor API's undocumented shape.
Fabricating a QQ Catalyst REST client from memory would risk exactly the
failure mode the spec is most worried about: confidently wrong integration
code presented as if it reused a vetted, E&O-safe flow.

## Decision
1. Treat "the existing toolkit" as **not present in this environment**
   rather than block on it. The spec's constraints (dry-run by default,
   idempotent, E&O-safe resolution, human review) are fully specified in
   prose (§0.5, §4.4, §6.3) independent of any existing code, so they can be
   implemented directly rather than reused.
2. `src/resolve/account.js` implements the policy → exact-name → fuzzy-name
   → ambiguous flow exactly as specified in §4.4, built fresh, with a local
   JSON client index (`src/resolve/index.json`, synthetic by default —
   see ADR 0002) standing in for a QQ-sourced cache.
3. `src/writeback/qq.js` implements a minimal `QQClient` interface with a
   fully working **dry-run** path (logs the payload it would send, returns
   `{ ok: true, dryRun: true }`). The **live** path is a thin, clearly
   labeled stub gated behind `QQ_LIVE_WRITES_APPROVED=true` *and* `--live`;
   it throws with an explicit "no verified QQ Catalyst API contract in this
   environment" error rather than silently no-op'ing or guessing endpoints.
   Wiring it to the real API is listed as an integration follow-up in the
   final report, not claimed as done.
4. The review queue server binds to port `8766` as specified ("adjacent to
   the existing :8765/drop"), not `8765` — there is no existing `:8765`
   server on this machine to be adjacent to, and reusing that exact port
   number risks colliding with a real service on the agency's machine later.
5. `bind.js` / `intake.js` are not created as literal files — nothing in the
   spec's file tree (§1) calls for them in *this* repo; they were referenced
   only as the source of reusable behavior. That behavior is implemented
   directly in `src/resolve/`, `src/writeback/`, and the CLI's dry-run
   plumbing instead.

## Consequences
- The E&O-safe resolution flow and dry-run discipline are real,
  independently-implemented, and tested — not a re-export of unverified code.
- QQ write-back cannot be demonstrated live from this repo. The synthetic
  vertical slice (§10 of docs/SPEC.md) does not depend on it: dry-run output
  and the CSV export are the deliverable until a verified API contract and
  credentials are supplied out-of-band by the agency.
- If a real `bind.js`/`intake.js`/QQ client does exist somewhere the user
  has access to but this session could not see (a private repo, another
  machine), it was not found by this search. Pointing this project at it is
  a follow-up, not a blocker — `src/resolve/account.js` and
  `src/writeback/qq.js` are written as small, swappable modules for exactly
  that reason.

## Addendum (2026-08-29): the QQ write-back gap in point 3 is now closed

The user had real "Enterprise API Access" QQ Catalyst credentials already
provisioned and pointed this session at the vendor's own API docs
(`docs/adr/0007-qq-catalyst-api-client-index.md`), including — in a later
follow-up — the literal endpoint list and, for `PUT v1/Contacts/Notes`
specifically, the full request/response schema with a sample payload
(`api.qqcatalyst.com/Help/Api/PUT-v1-Contacts-Notes`). That's exactly the
"verified API contract" point 3 said was missing.

`src/writeback/qq.js` now calls this real endpoint (via
`src/resolve/qqClient.js`'s `createContactNote()`) when three conditions
all hold: `--live`, `QQ_LIVE_WRITES_APPROVED=true`, and the task's
`account_id` is a real numeric QQ contact id rather than the synthetic
index's `"C-1001"`-style placeholder — any one missing still falls back to
the same dry-run/logged behavior as before. This third condition is new
and specific to write-back: a wrong *read* only produces a bad
suggestion a human reviews, but a wrong *write* (a note attached to
contact id `1001` when no such real contact exists, or exists as someone
else) is the actual E&O harm this whole design is built to prevent, so
it's checked even beyond the two-key live/approved gate.

Point 3's original claim — "QQ write-back cannot be demonstrated live from
this repo" — no longer holds architecturally, but it still hasn't been
*exercised* against the real API in this environment (no live run was
made). Treat it as code-reviewed against a verified schema, not
field-tested, until it has been.
