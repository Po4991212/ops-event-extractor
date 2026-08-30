# ADR 0006: Synthetic-only test/demo data; real vendor domains kept for routing tests

## Status
Accepted

## Context
docs/SPEC.md §0.6 is unambiguous: "Demos, tests, the public repo, screenshots,
videos, and hosted artifacts use synthetic data only." This repository's
`origin` remote is already `github.com/Po4991212/ops-event-extractor` — i.e.
this is the public repo the rule is talking about.

The spec's own narrative text (§3.4, §4.2, §4.4, §7.3), however, uses what
read as real client/account names and real documented incidents from the
target mailbox as illustrative examples and even as literal replay-test
assertions: `Escamillia`, `Stars Plumbing`, `Tobacco & Vapor 12`,
`HangCao LLC`, `Larry Cheek`, `DNA Access Services, LLC`, `Brookfield Town
Homes`, `Sugar Nails of Clemson LLC`. §7.3's `test/replay.spec.js` sketch
asserts against `/escamillia/i`, `/stars plumbing/i`, `/tobacco.*vapor/i`
directly.

Committing tests or fixtures that assert against those literal names would
violate §0.6 in the one place it matters most (a public GitHub repo). §0.6
is listed as non-negotiable "unless the user explicitly changes it," and no
such change was requested.

## Decision
1. **Client index, ground-truth corpus, synthetic email corpus, and all
   `test/fixtures/*` are entirely fictional.** No name, policy number, phone
   number, or dollar amount from docs/SPEC.md's narrative examples is reused
   anywhere in committed data. This was verified by grepping
   `data/synthetic/`, `src/resolve/index.json`, and `test/fixtures/` for
   every proper noun that appears in docs/SPEC.md's prose (see the
   `scripts` section of README.md for the exact grep command; it is also
   run as part of `npm test` via `test/no-real-names.spec.js`).
2. **The three §7.3 recovery tests are re-implemented against synthetic
   analogs**, not the literal named incidents:
   - "flags the lapse before it happens" → a fictional carrier
     `lapse_warning`/`renewal_due` pair on a fictional account.
   - "surfaces a renewal early, not late" → a fictional renewal notice
     dated well before its due date.
   - "collapses a notice forwarded three times" → a fictional renewal
     notice forwarded through three fictional internal mailboxes.
   These preserve the *shape* of the real failures the spec documents
   (a real, defensible engineering claim — "this architecture recovers
   this class of failure") without reproducing real client data.
3. **Carrier/vendor sender domains are treated differently from client
   data, and every parser matches both forms.** `renewal-us@foxquilt.com`,
   `twia.appmail.np@twia.org`, `service@ringcentral.com`, etc. are public
   facts about which vendor a given automated notice comes from — not
   agency client PII. Each parser's `match()` regex accepts the real vendor
   domain *and* a `-example` variant of it (e.g.
   `/@[\w.-]*foxquilt(-example)?\.com/i`), so:
   - `test/fixtures/` can use the real vendor domain, exercising the exact
     regex production traffic hits, paired with fully fictional insured
     names, policy numbers, and amounts in the message body.
   - `data/synthetic/` (the demo/ground-truth corpus) follows §3.5 and uses
     `@carrier-example.com`-shaped domains throughout — safe to show in a
     screen recording — while still being routed through the real parsers
     rather than falling through to the (uncalled, in synthetic mode
     without an API key) LLM path. Without the `-example` alternation, the
     synthetic corpus would silently bypass Phase 2's routing entirely,
     which defeats the point of demonstrating it.

## Consequences
- The replay tests demonstrate the same architectural claims (early
  warning, dedup across forwards) the spec's real incidents demonstrate,
  on data invented for this repo.
- Anyone extending this repo with real mailbox data must keep it under
  `data/private/` (gitignored) per the repo layout in docs/SPEC.md §1, and
  must not promote real names into `test/fixtures/` or `data/synthetic/`.
