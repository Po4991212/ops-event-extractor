# Research sources — access log

Per docs/SPEC.md §11/§12: sources checked before implementation, with access
dates and what was verified. Where a fetch conflicted with or extended the
spec's conceptual code, the difference is recorded in an ADR (linked below)
and the official documentation was followed.

All accesses below are dated **2026-08-29** (the day implementation started).

## Package registry (npm)

Checked via `npm view <pkg> version` against the public npm registry.
Drives docs/adr/0002-package-and-model-versions.md.

| Package | Latest stable | 
|---|---|
| better-sqlite3 | 13.0.3 |
| @anthropic-ai/sdk | 0.122.0 |
| googleapis | 176.0.0 |
| zod | 4.5.4 |
| luxon | 3.7.2 |
| commander | 15.0.0 |
| node-html-parser | 9.0.2 |
| express | 5.2.1 |
| p-limit | 7.3.1 |
| vitest | 4.1.11 |

## Gmail API

- **Sync guide** — developers.google.com/workspace/gmail/api/guides/sync.
  Confirmed: full sync mandatory on first connect; `history.list` +
  `startHistoryId` for incremental sync; out-of-range `startHistoryId`
  returns HTTP 404 and the documented recovery is a full-sync fallback;
  history retention "typically at least one week." Matches docs/SPEC.md
  §3.2 exactly. See docs/adr/0003-gmail-readonly-and-sync-fallback.md.
- **`users.messages.list` reference** and **`users.history.list`
  reference** (docs/SPEC.md §11 links) — not independently re-fetched this
  session; `includeSpamTrash` and `historyTypes` are stable, long-standing
  Gmail API v1 parameters used exactly as documented on the sync guide's
  companion reference pages. Flagged here rather than silently assumed.
- **OAuth for installed applications**, **Gmail OAuth scope guide**,
  **Workspace API user-data policy** (docs/SPEC.md §11 links) — not
  independently re-fetched this session. `gmail.readonly` is used as the
  sole scope for Phase 1–3 per ADR 0003; this is the minimum documented
  scope for read access and doesn't depend on details from those pages.
  Flagged as a follow-up verification before any live-mode deployment.

## Claude API

- **Structured outputs** —
  platform.claude.com/docs/en/build-with-claude/structured-outputs.
  Confirmed current: `strict: true` on a tool definition is supported and
  current; `output_config.format` + `messages.parse()` is the newer
  recommended path for pure-JSON extraction. This repo keeps the
  strict-tool-use shape from docs/SPEC.md §5.2 (see docs/adr/0002).
- **Models overview** —
  platform.claude.com/docs/en/models/overview. Confirmed current model IDs:
  `claude-haiku-4-5-20251001` (classification), `claude-sonnet-5`
  (extraction), pricing, context windows. See
  docs/adr/0004-anthropic-data-flow-and-live-gate.md.
- **API and data retention** —
  platform.claude.com/docs/en/manage-claude/api-and-data-retention.
  Confirmed: standard API retention and zero-data-retention (ZDR) /
  HIPAA-readiness are separate arrangements Anthropic offers; retained data
  is never used for training without express permission; the agency's
  actual arrangement (standard vs ZDR) is not discoverable from this
  session and must be confirmed by the agency directly with Anthropic
  before live mail content is sent. Recorded as an open item, not resolved
  here — see docs/adr/0004 and the final report's open-items list.
- **Mitigate jailbreaks and prompt injections** —
  platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks.
  Confirmed current guidance for indirect prompt injection (the relevant
  threat model here — the *email sender* is the adversary, not the agency
  user): deliver untrusted third-party content inside `tool_result` blocks
  rather than plain `user` text, label its source/type explicitly, and
  JSON-encode the payload so it can't "break out" of its delimiters. This
  is a concrete instruction beyond what docs/SPEC.md §5.3 sketches (which
  only says "JSON-encode... where the current pattern supports it, provide
  ... as an explicitly described tool_result"); `src/extract/llm.js`
  implements it literally: a synthetic `assistant` `tool_use` turn for a
  `read_email` tool, answered by a `user` `tool_result` turn carrying the
  JSON-encoded, bounded email fields, followed by the actual extraction
  instruction. See docs/adr/0004.

## QQ Catalyst API (added 2026-08-29, second research pass)

- **Developer portal overview** — api.qqcatalyst.com/. Confirmed this is a
  live API docs/developer-portal site (ASP.NET Web API auto-generated
  help), not a dead link, with Contacts/Customers and Policies endpoint
  categories.
- **Authentication** — api.qqcatalyst.com/Home/Authentication and
  /Home/Security, cross-checked with a web search summarizing the same
  pages. Confirmed: "Enterprise API Access" uses a static
  `Authorization: Basic base64(clientid:clientsecret)` header
  (ISO-8859-1 encoded), distinct from the OAuth2 "Active Authentication"
  flow meant for third-party apps impersonating an individual QQ user.
- **Endpoint reference** — api.qqcatalyst.com/Help and two individual
  endpoint pages (`GET-v1-Customers-customerID-CustomerDetailSummary`,
  `GET-v1-Policies-ByCustomer-customerId_keyword_page_rowCount`).
  Confirmed the base path, the `CustomerDetailSummaryDTO` field list (no
  ZIP/address field on it), and the `PolicySearchResultsDTO` envelope
  shape. A resource-model page for `PolicySearchDTO` itself
  (`/Help/ResourceModel?modelName=PolicySearchDTO`) returned a server
  error rather than the field list — **that page's exact per-record policy
  fields were not confirmed** and are handled as a documented gap, not a
  guess, in `docs/adr/0007-qq-catalyst-api-client-index.md`.
- **Agency's own API-developer console endpoint list** — pasted by the
  user directly from their logged-in QQ Catalyst account (the
  `urlToCallFromSelect` endpoint picker on QQ's own API test-console
  page), not fetched by this session. Confirmed `GET
  /Contacts/{contactID}/Addresses` exists (closing the ZIP-source gap) and
  the exact `LastModifiedCreatedCustomersEmployees` query params. See
  `docs/adr/0007`'s addendum.
- **`PUT v1/Contacts/Notes`** — api.qqcatalyst.com/Help/Api/PUT-v1-Contacts-Notes.
  Confirmed the full `NoteDTO` request schema and
  `ActionResultDTOOfNoteDTO` response schema, including a complete sample
  request/response. This closes ADR 0001's original write-back gap — see
  that ADR's addendum and `docs/adr/0007`.

## Insurance governance and security (docs/SPEC.md §11)

TDI Bulletin B-0003-26, FTC Safeguards Rule small-entity guidance, OWASP
Secrets Management and Logging cheat sheets — not fetched this session.
These inform operator-facing documentation (retention/deletion, incident
response, secrets handling in README/ADRs) rather than a specific code
shape, and docs/SPEC.md is explicit that "these sources guide
implementation but do not establish... that the finished application is
compliant" — compliance sign-off is out of scope for this repo and is
listed as an open item for the agency's compliance professional in the
final engineering report.

## Local environment

- `node --version` → v22.16.0 (used as the pinned runtime; see
  `package.json` `engines.node` and docs/adr/0005-node-version.md).
