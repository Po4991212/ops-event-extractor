# ADR 0002: Package and model versions pinned from live sources, not the spec's example numbers

## Status
Accepted

## Context
docs/SPEC.md §1 gives example dependency versions and says explicitly:
"The versions below express the intended libraries, not permission to
install stale versions. Verify current stable releases... pin compatible
versions in the lockfile." §5.1 similarly forbids hardcoding undocumented
model aliases.

`npm view <pkg> version` was run against the public registry on
2026-08-29 (see docs/research-sources.md) for every dependency. Several
majors have moved well past the spec's example pins:

| Package | Spec example | Installed (2026-08-29) |
|---|---|---|
| better-sqlite3 | ^11.0.0 | ^13.0.3 |
| @anthropic-ai/sdk | ^0.30.0 | ^0.122.0 |
| googleapis | ^140.0.0 | ^176.0.0 |
| zod | ^3.23.0 | ^4.5.4 |
| luxon | ^3.4.0 | ^3.7.2 (same major) |
| node-html-parser | ^6.1.0 | ^9.0.2 |
| commander | ^12.0.0 | ^15.0.0 |
| express | ^4.19.0 | ^5.2.1 |
| p-limit | ^5.0.0 | ^7.3.1 |
| vitest | ^2.0.0 | ^4.1.11 |

Two of these are major-version jumps with real breaking changes relevant to
this codebase:

- **zod v4**: `z.record()` now requires an explicit key schema
  (`z.record(z.string(), z.number())`); the v3 single-argument form
  (implicit string key) is gone. `z.string().email()` and friends moved to
  top-level `z.email()` etc. (not used here). Error customization
  (`invalid_type_error` → `error`) changed but isn't used in this codebase.
- **p-limit v7 / express v5**: both are ESM-only or ESM-first at these
  versions; this repo is `"type": "module"` already so that's not a
  conflict. Express 5 changes wildcard route syntax (`*` → `/*splat`) —
  relevant if the review server ever adds a catch-all route; it doesn't.
- **@anthropic-ai/sdk 0.122.0**: current SDK supports `messages.create` with
  a `strict: true` tool definition exactly as the spec's conceptual code
  shows (confirmed against the live Structured Outputs doc, see
  docs/research-sources.md), so `src/extract/llm.js` keeps the
  tool-forced-call shape from the spec rather than switching to
  `output_config.format` + `messages.parse()`. Both are current and
  supported; the tool-forced approach was kept because it maps 1:1 onto the
  existing Zod `OpsEvent` schema and gives a natural `tool_use` block to
  parse, with no behavior difference for this use case.

## Decision
Pin `package.json` to the versions actually available on the registry as of
the access date recorded in docs/research-sources.md, not the spec's example
numbers. Write all schema and extraction code against the confirmed-current
API shapes (zod v4 record signature, Anthropic strict tool use).

## Consequences
- The lockfile reflects real, installable versions rather than stale pins
  that would fail `npm install` today.
- Any zod v3-shaped code copied verbatim from docs/SPEC.md's conceptual
  snippets needs the v4 record-signature fix; `src/extract/schema.js`
  applies it directly.
