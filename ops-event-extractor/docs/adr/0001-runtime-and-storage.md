# 0001. Node.js, SQLite, one process

Status: accepted

## Context

Five shared mailboxes, roughly 200 threads a week. One agency, a handful of
staff, no operations team. The existing agency automation is Node.js against
the QQ Catalyst REST API, so a second language would mean a second set of
things to keep working.

## Decision

Node.js 22 with `better-sqlite3`, one process, one file on disk.

`better-sqlite3` is synchronous, which for this workload is a feature rather
than a limitation: every write is a short transaction, and synchronous calls
remove a whole class of interleaving bug from the code that decides whether an
obligation exists. WAL mode plus foreign keys on. Schema changes are numbered
SQL files applied in order and recorded, so migrating is idempotent and a
half-applied upgrade is visible.

Timezone arithmetic uses Luxon rather than `Date`. The difference between "45
calendar days before" and "3 business days after" is the product, and native
`Date` cannot express the agency's timezone without care that would be repeated
in a dozen places.

Runtime schema validation uses Ajv against the same JSON Schema that is sent to
the model as a strict structured output. One schema, two consumers.

## Consequences

- Single machine. Throughput is nowhere near a concern at 200 threads a week.
- A crash loses nothing committed; SQLite's durability is the whole story.
- No connection pool, no ORM, no migration framework, no background worker
  process. Everything is a command someone runs or a timer that runs a command.
- Scaling past one agency would mean revisiting this. That is a real limit and
  it is written down rather than designed around prematurely.
