# ADR 0005: Node runtime pinned to v22.16.0

## Status
Accepted

## Context
docs/SPEC.md requires "the current active Node.js LTS compatible with the
existing toolkit" and to "record and pin the exact Node version." Per ADR
0001, no existing toolkit was found in this environment to be compatible
with, so there is no inherited constraint. `node --version` on this machine
reports `v22.16.0`. Node 22 is an LTS line.

## Decision
Pin `package.json` `engines.node` to `>=22.16.0` and document v22.16.0 as
the version this repo was built and tested against. All ESM syntax,
`better-sqlite3` native bindings, and `googleapis`/`@anthropic-ai/sdk`
usage in this repo target Node 22 semantics.

## Consequences
- If the agency's production machine runs a different Node 22.x patch or a
  later LTS (e.g. Node 24), `npm install` should be re-run there to rebuild
  `better-sqlite3`'s native binding for that platform/version; no source
  changes are expected to be needed for any Node 22–24 LTS release.
