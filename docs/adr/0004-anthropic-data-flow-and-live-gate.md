# ADR 0004: Anthropic data flow, model IDs, and live-LLM kill switch

## Status
Accepted

## Context
docs/SPEC.md §0.6 requires that live mailbox content only reach Anthropic's
API if the agency's retention arrangement for that specific API account is
verified, and that the LLM path be disabled for live mail otherwise. §5.1
requires verified, non-aliased model IDs recorded with every call.

The live models overview page (platform.claude.com/docs/en/models/overview,
accessed 2026-08-29, see docs/research-sources.md) confirms current model
IDs. Per the cost/latency split in §5.1 (cheap classifier, stronger
extractor):

- Classification: `claude-haiku-4-5-20251001` — cheapest active model
  ($1/$5 per MTok), 200K context, sufficient for a subject+excerpt
  operational/non-operational + kind decision.
- Extraction: `claude-sonnet-5` — "best combination of speed and
  intelligence," $2/$10 per MTok, 1M context, strict tool use supported.

Both are pinned dated/stable IDs, not aliases resolved at call time to an
unknown snapshot (`claude-haiku-4-5` the bare alias was avoided in favor of
the dated `claude-haiku-4-5-20251001` so the exact snapshot is reproducible
in the replay/eval logs).

The structured-outputs doc confirms `strict: true` on a tool definition is
current and supported; this repo uses that shape rather than
`output_config.format` + `messages.parse()` (see ADR 0002) because it maps
directly onto the tool-forced call in docs/SPEC.md §5.2 without adding the
Zod-to-JSON-Schema helper as an extra dependency surface.

## Decision
- `ANTHROPIC_CLASSIFICATION_MODEL` and `ANTHROPIC_EXTRACTION_MODEL` are read
  from environment variables (defaults in `.env.example`), never
  hardcoded inside `src/extract/llm.js`; `src/config.js` validates both are
  set and match `/^claude-/` before any call is attempted, and logs the
  exact ID used with every row in `llm_calls`.
- A new gate, `OPS_LLM_LIVE_APPROVED`, defaults to `false`. When
  `OPS_MODE=live` and `OPS_LLM_LIVE_APPROVED` is not exactly `"true"`, the
  LLM extraction path is skipped entirely (messages that would have reached
  it are left in `status='new'` with a `llm_disabled` reason) rather than
  silently sending live mail content to the API. This is a second,
  independent switch from `--live`/`OPS_MODE`, because "the agency approved
  processing live mail" and "the agency approved sending some of that mail's
  text to Anthropic" are two different approvals per §0.6.
- In `OPS_MODE=synthetic` (the default), the LLM path may run against
  synthetic fixtures freely — no real client data exists to protect.
- Only the bounded, normalized message fields needed for extraction
  (subject, body_text/body_full capped to a size limit, from-domain) are
  sent — never raw MIME, attachments, or full header blocks. This is
  enforced in `renderMessage()` in `src/extract/prompt.js`.

## Consequences
- Live extraction cannot be demonstrated from this environment (no
  `ANTHROPIC_API_KEY` configured here, and `OPS_LLM_LIVE_APPROVED` defaults
  false) — this is intentional per §0.6, not an oversight. The synthetic
  vertical slice exercises the same code path with `OPS_MODE=synthetic`.
- The agency's actual Anthropic account/retention arrangement is a
  compliance decision this codebase cannot make; it is recorded as an open
  item in the final report per §10.

### Addendum (2026-08-29): a populated `.env` must never make `npm test` hit a real API

`src/config.js` loaded `.env` as a fallback whenever `ANTHROPIC_API_KEY`
etc. weren't already in `process.env` — including during `vitest run`. Once
a developer follows README's "Live Gmail setup" and creates a real `.env`
(with a real `ANTHROPIC_API_KEY`), `test/replay.spec.js` started actually
calling the live Anthropic API for its synthetic fixtures (their
`source: 'synthetic'` makes `llmAllowedForMessage()` return `true`
independent of `OPS_MODE`, by design — see §5.1 above), timing out at
Vitest's 5s default rather than completing in ~500ms. That's a real bug: it
means a normal `npm test` run could have made billed API calls without any
`--live` flag or explicit intent, which is precisely the "does this cost
tokens" accident this whole ADR exists to prevent. Fixed by skipping the
`.env` fallback entirely when `process.env.VITEST` is set (Vitest sets this
itself) — the test suite now only ever sees explicit `process.env`, never a
developer's real secrets file, regardless of what's in it.
