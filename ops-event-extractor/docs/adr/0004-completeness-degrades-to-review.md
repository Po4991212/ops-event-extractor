# 0004. Incomplete processing lowers confidence; it does not quarantine

Status: accepted

## Context

Some messages cannot be fully read: a PDF attachment with no extractor, a body
in an encoding that does not round-trip, a part that arrives truncated. The
obvious options are to quarantine them or to process what is readable.

## Decision

Incomplete processing is a **warning**, not a gate failure. The readable part
is extracted normally, `processing_complete` is set to 0 on the message, and
confidence is capped at 0.70 — below the auto threshold, so the item lands in
the review queue with a person looking at it.

Grounding failures behave differently and are hard failures: a fabricated span,
an empty span, or a span that does not support the field it is attached to
sends the candidate to quarantine.

## Reasoning

The two failures are not alike. A fabricated span means the extractor asserted
something the source does not say — accepting it would put a false fact into
the obligation record, and no amount of human review downstream can undo the
fact that it was recorded as substantiated.

An unreadable attachment means the extractor saw less than there was. What it
did extract is still grounded in text that genuinely exists. The risk is
incompleteness, not falsity, and incompleteness is exactly what a human reading
the original attachment can fix.

Quarantining these would also have a predictable operational effect: the
quarantine queue would fill with ordinary mail that happened to carry a PDF,
and a queue that is mostly noise stops being read. The premium audit fixture in
the corpus is exactly this case — worksheet attached, obligation real, PDF
unreadable — and it belongs in front of a person, not behind a gate.

## Consequences

- `processing_completeness` appears in gate results as a warning with its
  reason, so the review console shows why confidence was capped.
- Urgency is computed independently of confidence. An urgent item with low
  confidence is still visible and still marked urgent; confidence decides how
  much a human must check, not whether they see it.
