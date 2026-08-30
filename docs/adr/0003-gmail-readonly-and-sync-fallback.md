# ADR 0003: Gmail readonly-only scope; full-sync fallback on expired historyId

## Status
Accepted

## Context
docs/SPEC.md §0.9 and §3.1 require starting with `gmail.readonly` only, and
§3.2/§8 require falling back to a full sync when `users.history.list`
returns 404 (expired `historyId`). The live Gmail sync guide
(developers.google.com/workspace/gmail/api/guides/sync, accessed
2026-08-29, see docs/research-sources.md) confirms both: full sync is
mandatory on first connect, `history.list` with `startHistoryId` is the
correct incremental method, and an out-of-range `startHistoryId` returns
HTTP 404, at which point the documented recovery is to fall back to a full
sync. History records are retained "typically at least one week."

Google's page did not surface documentation of `includeSpamTrash` or
`historyTypes` in the fetched content; those are documented on the
`users.messages.list` and `users.history.list` reference pages
(linked from docs/SPEC.md §11) rather than the sync guide, and are
standard, stable Gmail API v1 parameters. `includeSpamTrash: true` is kept
per §3.2's operational note (RingCentral call notes live in Trash in the
target mailbox) — this is a product fact about the target mailbox, not
something the docs page needed to confirm.

## Decision
- `src/gmail/auth.js` requests only
  `https://www.googleapis.com/auth/gmail.readonly` for Phase 1–3. `modify`
  and `compose` scopes are added only when Phase 4 code that needs them
  ships, and only behind explicit operator opt-in — not requested eagerly
  "just in case."
- `src/gmail/sync.js` implements `fullSync` (with `includeSpamTrash: true`)
  and `incrementalSync`, with `incrementalSync` catching a 404 from
  `history.list` and calling `fullSync` as the documented recovery path.
- OAuth refresh tokens are never written into `.env`; `.env.example`
  documents a `GMAIL_TOKEN_STORE_PATH` pointing outside the repo.
- **Obtaining the initial refresh token**: the current OAuth guide for
  installed/desktop apps (developers.google.com/identity/protocols/oauth2/native-app,
  accessed 2026-08-29, see docs/research-sources.md) states plainly that
  the old copy/paste "out of band" (`urn:ietf:wg:oauth:2.0:oob`) flow "is no
  longer supported," and that the current recommended mechanism for a
  desktop app is a loopback IP redirect (`http://127.0.0.1:<port>`).
  `runOAuthSetup()` in `src/gmail/auth.js` (wired to `cli.js gmail-auth`)
  implements this: it starts a temporary local HTTP listener on an
  ephemeral port, opens the consent URL for the operator, and exchanges the
  returned code for tokens — entirely on the operator's own machine. A
  "Desktop app"-type OAuth client in Google Cloud Console accepts any
  `127.0.0.1` port without pre-registration, which is why an ephemeral port
  is used rather than a fixed one; the command's own output tells the
  operator to double-check the client type if Google reports
  `redirect_uri_mismatch`.

## Consequences
- No live Gmail calls are exercised in this environment (no OAuth client
  configured here); `src/gmail/*` is implemented and unit-tested against
  synthetic/mocked responses, but live-mode integration — including
  actually running `gmail-auth` end to end against a real Google account —
  is an operator follow-up per docs/SPEC.md §10 ("Live Gmail or QQ
  credentials are integration acceptance items, not prerequisites for a
  complete synthetic vertical slice").
