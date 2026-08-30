# ADR 0007: QQ Catalyst API client for the real client index — verified vs. unconfirmed fields

## Status
Accepted

## Context
ADR 0001 established that no existing QQ client exists in this environment
to reuse, and `src/resolve/index.json` (the account-resolution cache §4.4
requires) has only ever held synthetic data. The user has real QQ Catalyst
"Enterprise API Access" credentials already provisioned and pointed this
session at the vendor's own docs (api.qqcatalyst.com), so this ADR records
what was verified there before writing `src/resolve/qqClient.js` and
`src/resolve/importClientIndex.js`, and — just as importantly — what
wasn't, so nothing here is presented as more certain than it is.

Sources fetched 2026-08-29 (see docs/research-sources.md):
`api.qqcatalyst.com/`, `/Home/Authentication`, `/Home/Security`, `/Help`,
`/Help/Api/GET-v1-Customers-customerID-CustomerDetailSummary`,
`/Help/Api/GET-v1-Policies-ByCustomer-customerId_keyword_page_rowCount`,
plus a web search that surfaced the same Authorization-header spec from
independent summaries of the same docs.

### Verified
- **Auth**: "Enterprise API Access" (the non-interactive style, appropriate
  for an agency reading its own book of business, as opposed to the OAuth2
  "Active Authentication" flow meant for third-party apps acting on behalf
  of an individual QQ user) sends `Authorization: Basic <base64>`, where
  the base64 is `clientid:clientsecret` encoded with **ISO-8859-1**
  specifically (not the more common UTF-8) — confirmed independently by
  the docs page and a web search summarizing the same page. No separate
  token-exchange call; the header is sent on every request.
- **Base URL / endpoints**: `https://api.qqcatalyst.com/v1/...`.
  - `GET /Contacts/LastModifiedCreatedCustomersEmployees?startDate&endDate&pageNumber&pageSize`
    — paged customer/employee listing.
  - `GET /Customers/{customerID}/CustomerDetailSummary` — response fields
    confirmed: `EntityID`, `DisplayName`, `BusinessName`, `FirstName`,
    `LastName`, `CustomerNo`, and others (agent/CSR/status fields) not used
    here.
  - `GET /Policies/ByCustomer/{customerId}?keyword&page&rowCount` —
    envelope confirmed: `{ Data: [...], PageNumber, PagesTotal, TotalItems,
    IsSuccess, ... }`.

### Explicitly not verified — documented gaps, not guesses
- **`PolicySearchDTO`'s exact field names** (the objects inside `Data` from
  the policies-by-customer call) were referenced by name in the docs but
  the field list itself wasn't shown on any page this session could reach
  (a resource-model page returned a server error). `policyNumberOf()` in
  `src/resolve/importClientIndex.js` tries a short list of plausible names
  (`PolicyNumber`, `PolicyNo`, `PolicyNum`, `Number`) and, if none match,
  logs the record's actual key names (not values) once so the real field
  can be added to that list from a genuine response instead of being
  guessed twice.
- **No ZIP/address field appears on `CustomerDetailSummaryDTO`.** §4.4's
  "zip disambiguation" tertiary step in `resolveAccount()` therefore has no
  data source from this endpoint. **Resolved in the 2026-08-29 addendum
  below**: `GET /Contacts/{contactID}/Addresses` is the right endpoint.
- **`LastModifiedCreatedCustomersEmployees`'s response envelope** wasn't
  shown with an example; `extractPage()` is written to tolerate either a
  bare array or the `{Data, PageNumber, PagesTotal}` shape confirmed on the
  policies endpoint, since ASP.NET Web API sites in this style are usually
  internally consistent about that. Unverified until it runs once for
  real.

## Decision
1. `src/resolve/qqClient.js` implements only the three read endpoints
   above, with every request routed through an injectable `fetchImpl` (no
   new HTTP dependency) so it's unit-testable without live credentials —
   see `test/qq-client.spec.js`.
2. `src/resolve/importClientIndex.js` orchestrates a full pull (paginate
   customers → detail + policies per customer → map → write) and, in
   parallel, keeps the CSV-import path from the original design in case a
   manual export is ever used instead of the API.
3. **`writeClientIndex()` refuses to write anywhere under `src/`** —
   enforced in code, not just convention, because that's where the
   committed public synthetic index lives (ADR 0006) and a real client
   list must never land there by accident. It defaults into
   `data/private/` (gitignored).
4. `resolve/account.js`'s `loadClientIndex()` now prefers a real index at
   `QQ_CLIENT_INDEX_PATH` when that file exists, falling back to the
   synthetic one otherwise, and **logs which one is active** on first use
   — silently resolving against the wrong source (real data in a demo, or
   fake data in production) is the specific mistake this logging exists to
   catch immediately rather than downstream.
5. `cli.js refresh-client-index [--from-csv] [--since <date>]` is the
   operator entry point.

## Consequences
- The client index can now be rebuilt from real QQ Catalyst data with a
  single command, once `QQ_API_CLIENT_ID`/`QQ_API_CLIENT_SECRET` are set —
  but this has not been run against the live API in this environment (no
  credentials here), so treat the two documented gaps above as the first
  things to check on its first real run, not settled facts.
- This ADR's read-only client is unrelated to `src/writeback/qq.js`'s
  note-creation write-back path, which still has no verified contract
  (ADR 0001) — reading the agency's own client list and writing a note
  into its own AMS are different endpoints with, plausibly, different
  confirmation needs; this ADR doesn't change ADR 0001's conclusion for
  write-back.

## Addendum (2026-08-29): real endpoint list from the agency's own account

The user pasted the raw `<select>` HTML from QQ Catalyst's own
"API Developer" test-console page (`urlToCallFromSelect`), populated from
their own logged-in account. This is a stronger source than the public
docs pages fetched above — it's the literal, complete endpoint list this
agency's QQ instance exposes, not a cached doc page — and it changes two
things:

1. **ZIP gap closed**: `GET /v1/Contacts/{contactID}/Addresses` is
   confirmed to exist. `src/resolve/qqClient.js` gained
   `getContactAddresses()`; `src/resolve/importClientIndex.js` now calls
   it per customer and extracts a zip via the same tolerant-candidate
   pattern as `policyNumberOf()` (`zipOf()`, candidates `Zip`, `ZipCode`,
   `PostalCode`, `Postal`) since the individual address record's exact
   field names still weren't shown. A failed/missing address for one
   customer degrades that one client to `zip: null` rather than aborting
   the whole import (tested in `test/import-client-index.spec.js`).
2. **`LastModifiedCreatedCustomersEmployees`'s query params confirmed
   exactly**: `startDate`, `endDate`, `pageNumber`, `pageSize` — matches
   what `listCustomersPage()` already sent, so no change needed there.
3. **A promising lead for ADR 0001's write-back gap, not yet acted on**:
   the same list includes `PUT v1/Contacts/Notes` and
   `GET/PUT v1/Contacts/{contactID}/Notes` and
   `GET/PUT v1/Contacts/{contactID}/Tasks` endpoints — plausibly exactly
   what `src/writeback/qq.js`'s dry-run note-creation stub needs a real
   contract for. Not implemented here: the request/response body shape for
   `PUT /Contacts/Notes` wasn't in the pasted list (it only shows the
   endpoint's existence, not its schema), and ADR 0001's caution about not
   guessing a write endpoint's shape applies even more strongly to a
   *write* than the read endpoints this ADR covers. Fetching that
   endpoint's own `/Help/Api/PUT-v1-Contacts-Notes`-style detail page
   (same pattern used successfully for the read endpoints above) is the
   concrete next step, listed in the engineering report's milestones.
