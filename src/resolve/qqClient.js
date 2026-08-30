import { config } from '../config.js';

/**
 * QQ Catalyst "Enterprise API Access" client — read-only endpoints only
 * (customer list, customer detail, policies-by-customer). This is separate
 * from src/writeback/qq.js, which is the (unverified, dry-run-only) note
 * write-back path per ADR 0001. Endpoint paths and the auth header shape
 * are verified against api.qqcatalyst.com's own docs, accessed 2026-08-29
 * — see docs/research-sources.md and ADR 0007 for exactly what was
 * confirmed vs. left as a documented gap (notably: the exact field names
 * on an individual policy record, and where a ZIP/address lives — neither
 * was in the fetched docs).
 */

function authHeader() {
  if (!config.qq.apiClientId || !config.qq.apiClientSecret) {
    throw new Error('QQ_API_CLIENT_ID/QQ_API_CLIENT_SECRET are not set. See .env.example and README "Real QQ client index".');
  }
  // Documented explicitly as ISO-8859-1 (latin1), not UTF-8 — Node's
  // 'latin1' encoding is ISO-8859-1.
  const raw = `${config.qq.apiClientId}:${config.qq.apiClientSecret}`;
  const encoded = Buffer.from(raw, 'latin1').toString('base64');
  return `Basic ${encoded}`;
}

/**
 * Thin request wrapper. `fetchImpl` is injectable so tests can supply a
 * fake without a real HTTP dependency or live credentials.
 */
async function request(method, pathAndQuery, { body, fetchImpl = fetch } = {}) {
  const url = `${config.qq.apiBaseUrl}${pathAndQuery}`;
  const headers = { Authorization: authHeader(), Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetchImpl(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (!res.ok) {
    // Never include the Authorization header value or request body in an error message/log (§0.9).
    throw new Error(`QQ Catalyst API ${res.status} ${res.statusText} for ${method} ${pathAndQuery}`);
  }
  return res.json();
}

const get = (pathAndQuery, opts) => request('GET', pathAndQuery, opts);
const put = (pathAndQuery, body, opts) => request('PUT', pathAndQuery, { ...opts, body });

/**
 * Paged customer/employee listing (GET /v1/Contacts/LastModifiedCreatedCustomersEmployees).
 * `since`/`until` are ISO dates; QQ's docs did not show the exact response
 * envelope shape for this endpoint, so this returns the parsed JSON as-is
 * — callers should log its top-level keys on first real use and adjust
 * `extractPage()` below if it doesn't match the PolicySearchResultsDTO-style
 * `{ Data, PageNumber, PagesTotal, ... }` envelope the sibling Policies
 * endpoint documents.
 */
export async function listCustomersPage({ since, until, pageNumber = 1, pageSize = 100 }, opts = {}) {
  const params = new URLSearchParams({
    startDate: since, endDate: until,
    pageNumber: String(pageNumber), pageSize: String(pageSize)
  });
  return get(`/Contacts/LastModifiedCreatedCustomersEmployees?${params}`, opts);
}

/** GET /v1/Customers/{customerID}/CustomerDetailSummary — verified field names, see ADR 0007. */
export async function getCustomerDetail(customerId, opts = {}) {
  return get(`/Customers/${encodeURIComponent(customerId)}/CustomerDetailSummary`, opts);
}

/**
 * GET /v1/Contacts/{contactID}/Addresses — path confirmed directly from the
 * agency's own API-developer endpoint list (ADR 0007 addendum); this is
 * where ZIP data actually lives, not on CustomerDetailSummary. Exact
 * response field names for an individual address weren't independently
 * verified — importClientIndex.js's zipOf() tries plausible candidates
 * and logs the real ones on first mismatch, same pattern as policyNumberOf().
 */
export async function getContactAddresses(contactId, opts = {}) {
  return get(`/Contacts/${encodeURIComponent(contactId)}/Addresses`, opts);
}

/** GET /v1/Policies/ByCustomer/{customerId} — envelope verified, per-record fields not (ADR 0007). */
export async function listPoliciesForCustomer(customerId, opts = {}) {
  return get(`/Policies/ByCustomer/${encodeURIComponent(customerId)}?rowCount=99999`, opts);
}

/**
 * PUT /v1/Contacts/Notes — creates (no `Id`) or updates (with `Id`) a note.
 * Request/response schema (NoteDTO / ActionResultDTOOfNoteDTO) verified
 * directly from api.qqcatalyst.com/Help/Api/PUT-v1-Contacts-Notes,
 * including a full sample request/response — see ADR 0001's addendum.
 * `payload` must include at minimum `{ AssignedContactId, Comment }`.
 */
export async function createContactNote(payload, opts = {}) {
  return put('/Contacts/Notes', payload, opts);
}

/** Best-effort extraction of a page's row array, tolerant of the couple of envelope shapes QQ's docs suggest. */
export function extractPage(response) {
  if (Array.isArray(response)) return { rows: response, isLastPage: true };
  if (Array.isArray(response?.Data)) {
    const isLastPage = response.PagesTotal == null || response.PageNumber >= response.PagesTotal;
    return { rows: response.Data, isLastPage };
  }
  return { rows: [], isLastPage: true };
}
