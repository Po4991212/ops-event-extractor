# 0002. gpt-6-astra on the Responses API, and the snapshot we did not pin

Status: accepted

## Context

The extraction runtime is specified as OpenAI's Responses API with
`model: "gpt-6-astra"`, strict structured outputs, and reasoning effort varied
by stage.

## Decision

`src/extract/model/astra-adapter.js` builds exactly that request:

- `model: "gpt-6-astra"`
- `reasoning.effort` — `low` for classification, configurable (default
  `medium`) for extraction
- `text.format` — `{ type: "json_schema", name, schema, strict: true }`, the
  Responses shape, not the Chat Completions `response_format`
- one tool, `get_normalized_message`, which is read-only

Deliberately absent: `temperature`, `top_p`, `top_logprobs`. A test asserts
they are absent, because the easiest way for them to reappear is a well-meaning
"make it more deterministic" change.

Also deliberately absent: any `configuration_update` input item. The
documentation available at build time does not describe one, and per-request
`reasoning.effort` covers every need this application has. Inventing an input
shape is how an adapter breaks silently on the next API revision.

## The snapshot

`config.model.snapshot` is empty and no snapshot string is written anywhere in
this repository. Snapshot identifiers for this model were not enumerated in any
source consulted during the build, and guessing one would produce a request
that either fails or — worse — silently falls back.

This is a real reproducibility limitation and it is reported as one:

- every row in `model_calls` records `model_requested`, `model_returned` and
  `snapshot`, so drift between runs is visible after the fact
- `meta.snapshotPinned` is `false` until an operator sets a real snapshot
- the status report lists "no snapshot pinned" as a live-integration blocker

Set `OPS_MODEL_SNAPSHOT` once a real identifier is available. Nothing else
needs to change.

## Consequences

- Offline, `OPS_MODEL_MODE=stub` uses a deterministic local extractor. Metrics
  produced that way are labelled as fixture behaviour, not model quality.
- Sending message content to a model is gated separately from reading mail:
  `OPS_MODEL_TRANSMISSION_APPROVED=1`. Reading the mailbox and transmitting its
  contents to a third party are different decisions and are switched
  separately.
