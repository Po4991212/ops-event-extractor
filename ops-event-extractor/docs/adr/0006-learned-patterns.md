# 0006. Learned patterns replace repeat model calls, behind shadow testing and a person

Status: accepted

## Context

Nine hand-written parser families cover known carriers. Every other email goes
to the model, including the tenth copy of the same machine-generated reminder
from a carrier nobody wrote a parser for. Each of those costs a model call that
produces the same answer it produced last time.

## Decision

When a model answer passes every evidence gate, the system stores a **learned
pattern** for that sender and event kind: the opening words of the obligation
line (the trigger) and, for each claimed field, the words just before the value
(the cue). Words containing digits and words from client names in the email are
cut off, so the pattern holds template text and not one client's details.

A pattern moves through these states:

| state | what it does |
|---|---|
| shadow | runs next to the model on later mail from the same sender and is only compared |
| ready | agreed with the model `OPS_LEARNED_AGREEMENTS` times (default 3) with no disagreement |
| approved | a named person ran `patterns approve <id> --by=NAME`; matching mail skips the model |
| suspended | disagreed with the model, in shadow or in a spot check |
| retired | a person switched it off |

An approved pattern is still spot-checked. Every `OPS_LEARNED_SPOT_CHECK_EVERY`th
use (default 10) the model reads the email too and its answer is the one used. A
disagreement suspends the pattern.

## Why it is shaped this way

- **A wrong pattern fails silently.** It misreads every email of its template
  and nothing looks broken. That is worse than a model call, so the defaults all
  lean towards calling the model: shadow first, a person to approve, spot
  checks after approval, and suspension on a single disagreement.
- **Patterns are data, not code.** The model is never asked to write a parser.
  A pattern is a list of phrases matched case-insensitively, so text in an email
  cannot turn into something that runs.
- **Same gates.** A learned event carries verbatim spans and goes through the
  same evidence gates as parser and model events. Its confidence gets an
  extractor weight of 0.8, between a parser (1.0) and the model (0.6).
- **Exact sender only.** A pattern applies to the exact From address it was
  learned from, never a domain and never a lookalike.
- **Nothing learned from inside the agency.** Colleagues write in their own words
  each time. The first run over the corpus learned useless patterns from
  internal forwards, so senders on the agency's mailbox domains are skipped.
- **Retired patterns stay retired.** The id is derived from the rules, so the
  same pattern is not quietly learned again from the next email.
- **Replay is stable.** Trials are keyed by pattern and message, so reprocessing
  a mailbox never counts the same agreement twice. A pattern is never tested on
  the email it was learned from.

## Limits

- A pattern reads one obligation per email. Shadow agreement requires the model
  to have found exactly one, but after approval an email that gains a second
  obligation is only caught by the next spot check.
- `uses` counts every time a pattern read an email, including reprocessing the
  same email during a replay.
- Only events with no object key are learnable (an object key names one specific
  item, like an installment number). Those senders keep going to the model.
- The trigger and cue rules are heuristics, measured against the offline stub
  and synthetic mail only. How often real carrier mail produces a learnable,
  stable pattern is unknown until it runs against a live mailbox.
- Tokens saved are counted as `uses` per pattern (`npm run ops -- patterns`).
  No dollar figure is computed because no model account exists yet.
