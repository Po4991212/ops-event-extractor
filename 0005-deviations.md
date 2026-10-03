# 0005. Deviations from the specification, and defects found during the build

Status: accepted

Everything here is a place where the built system differs from a literal
reading of the brief, or where testing found the design wrong and it was
changed. Nothing below was discovered by a reviewer; all of it came out of
running the thing.

## Deviations

**1. The obligation summary is derived evidence, not an extracted field.**

The brief asks for a verbatim span behind every factual field. The obligation
text is a sentence the extractor writes — "Renew policy TWIA-8841207 before
2026-06-01" — and holding it to literal token support rejected almost every
correct extraction. It now requires a real, non-empty, in-message span, is
recorded with `nature: derived`, and is exempt from token-overlap support.
Dates, amounts, policy references and object keys are unchanged and still
require support.

**2. Version history tracks facts, not phrasing.**

`revisionReason` originally compared the obligation text. A carrier notice and
a colleague's forward of it describe the same obligation in different words, so
every reprocessing pass created a new version and the summary flip-flopped
forever. Revisions now compare `stated_deadline`, `amount`, `currency`,
`object_key`, `kind` and `responsible`. The wording already on file is kept
when nothing material changed.

**3. Cross-thread linking has a second signal.**

Similarity alone could not link three differently-worded forwards of one
notice. Matching policy + kind + stated deadline is now sufficient corroboration
on its own — but object compatibility still holds a veto, which is what keeps
two commitments made on the same call for the same day apart.

**4. A date alone does not substantiate a deadline.**

A span cited for a date field must contain deadline language (due, by, before,
expires, lapse, effective, and so on) unless it is a table row, where the
column header carries the meaning. Without this, "Our office will be closed on
07/04/2026" would substantiate a renewal deadline of 4 July, which is precisely
the failure the brief's unrelated-span scenario describes.

**5. Object keys are matched structurally.**

`installment:3` could not be supported by the table row containing it under
free-text overlap. Object-key support now compares the value part after the
type prefix against the span.

## Defects found by the tests

**Silent data loss on forwarding.** A forward that said nothing about the
renewal premium overwrote the premium the original notice stated. Revisions now
carry established facts forward along with the evidence rows that established
them, keeping the original source message attached. Silence is not a
retraction.

**Fulfillment ignored the clock.** `fulfillment.check` matched AMS activity
regardless of whether it had happened yet at the current clock, so a replay of
March closed a task using an endorsement filed in April. Activity is now bounded
by `occurred_at <= now`.

**Reprocessing threw.** `processing_attempts` rows were keyed by content, so a
second pass over the same mailbox hit a unique-constraint violation instead of
being a no-op. Attempts are events now, numbered per message and stage.

**Unbounded resync recursion.** An aged-out history id triggers a full resync;
if the history endpoint reported expiry again, `syncMailbox` recursed forever.
Recovery is bounded to one retry, after which it returns what it synchronized
and marks the incremental position stale.

**A real mailbox address was committed.** The leakage check found a live
agency mailbox address in `config/mailboxes.example.json` and in the synthetic
corpus. Both now use `.test` domains, and staff first names were replaced with
fictional ones. The address itself is deliberately not reproduced here — the
same check that found it runs over this directory, and writing it into the
document that describes the fix would reintroduce the problem.

**Two security scanners with opposite calling conventions.** `scan()` took an
options object while `leakage.check()` took a positional root. A caller passing
a path string to `scan()` would scan the default tree and read the empty result
as a pass. Both are positional-root now.

## Not done

- No Gmail authorization was performed; `sync-gmail` has never run against a
  real mailbox.
- The QQ 417 on note creation is unresolved and is not claimed to be fixed.
- Parser sender domains in `config/parser-sources.json` are marked
  `verified_against_live_corpus: false`. They were written from the brief, not
  from real mail.
