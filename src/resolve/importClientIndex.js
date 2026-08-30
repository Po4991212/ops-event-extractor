import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { extractPage, getContactAddresses, getCustomerDetail, listCustomersPage, listPoliciesForCustomer } from './qqClient.js';

/**
 * Writes the normalized client-index shape resolve/account.js reads
 * (§4.4). Refuses to write anywhere under src/ — that's where the
 * committed, public, synthetic-only index.json lives (ADR 0006); real
 * client data must never land there. Defaults into data/private/, which
 * is gitignored.
 */
export function writeClientIndex(clients, outPath = config.qq.clientIndexPath, { source = 'unknown' } = {}) {
  const resolved = path.resolve(outPath || path.join(config.privateDir, 'client-index.json'));
  const srcDir = path.resolve(config.root, 'src');
  if (resolved.startsWith(srcDir + path.sep)) {
    throw new Error(
      `Refusing to write a real client index into ${resolved} — anything under src/ is committed to the ` +
      'public repo (ADR 0006). Point QQ_CLIENT_INDEX_PATH at a location under data/private/ instead.'
    );
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify({ fetched_at: new Date().toISOString(), source, clients }, null, 2));
  return resolved;
}

// ---- CSV path (for a manual export instead of the API) --------------------

/** Minimal RFC4180-ish CSV parser: quoted fields, embedded commas/quotes/newlines, no external dependency. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      pushField();
    } else if (c === '\n') {
      pushRow();
    } else if (c === '\r') {
      // swallow; \r\n handled via the following \n
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) pushRow();

  const [header, ...body] = rows.filter(r => !(r.length === 1 && r[0] === ''));
  return body.map(r => Object.fromEntries(header.map((h, idx) => [h, r[idx] ?? ''])));
}

export function mapCsvRowsToClients(rows, columns = config.qq.exportColumns) {
  return rows.map(r => ({
    id: r[columns.id],
    name: r[columns.name],
    zip: r[columns.zip] || null,
    policies: (r[columns.policies] || '').split(columns.policyDelimiter).map(s => s.trim()).filter(Boolean)
  })).filter(c => c.id && c.name);
}

export function importFromCsvFile(inPath = config.qq.exportPath, outPath = config.qq.clientIndexPath) {
  const rows = parseCsv(fs.readFileSync(inPath, 'utf8'));
  const clients = mapCsvRowsToClients(rows);
  return writeClientIndex(clients, outPath, { source: `csv:${inPath}` });
}

// ---- QQ Catalyst API path ---------------------------------------------

/** name from a CustomerDetailSummaryDTO (confirmed fields — see ADR 0007). */
function customerName(detail) {
  return detail.DisplayName || detail.BusinessName ||
    [detail.FirstName, detail.LastName].filter(Boolean).join(' ') || null;
}

// PolicySearchDTO's exact field names weren't in the fetched docs (ADR
// 0007) — try the plausible candidates and fall back to logging the
// record's key names (not values) so the real one can be added here once seen.
const POLICY_NUMBER_CANDIDATES = ['PolicyNumber', 'PolicyNo', 'PolicyNum', 'Number'];
let warnedUnknownPolicyShape = false;

function policyNumberOf(record) {
  for (const key of POLICY_NUMBER_CANDIDATES) {
    if (record[key]) return String(record[key]);
  }
  if (!warnedUnknownPolicyShape) {
    warnedUnknownPolicyShape = true;
    // eslint-disable-next-line no-console
    console.warn(
      '[qq-import] none of the expected policy-number fields ' +
      `(${POLICY_NUMBER_CANDIDATES.join(', ')}) were found on a policy record. ` +
      `Actual field names on this record: ${Object.keys(record).join(', ')}. ` +
      'Update POLICY_NUMBER_CANDIDATES in src/resolve/importClientIndex.js with the real one.'
    );
  }
  return null;
}

// Same tolerant-discovery pattern for the ZIP field on an /Addresses
// record (endpoint path confirmed from the agency's own API-developer
// endpoint list; exact response fields were not independently verified —
// ADR 0007 addendum).
const ZIP_CANDIDATES = ['Zip', 'ZipCode', 'PostalCode', 'Postal'];
let warnedUnknownAddressShape = false;

function zipOf(addressRecord) {
  for (const key of ZIP_CANDIDATES) {
    if (addressRecord[key]) return String(addressRecord[key]);
  }
  if (!warnedUnknownAddressShape) {
    warnedUnknownAddressShape = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[qq-import] none of the expected zip fields (${ZIP_CANDIDATES.join(', ')}) were found on an address record. ` +
      `Actual field names on this record: ${Object.keys(addressRecord).join(', ')}. ` +
      'Update ZIP_CANDIDATES in src/resolve/importClientIndex.js with the real one.'
    );
  }
  return null;
}

/** First address's zip from a /Contacts/{id}/Addresses response, tolerant of a bare-array or {Data:[...]} envelope. */
function firstZip(addressResponse) {
  const { rows } = extractPage(addressResponse);
  return rows.length ? zipOf(rows[0]) : null;
}

/**
 * Pulls the full customer list + each customer's policies from the live
 * QQ Catalyst API and writes a client index. `since`/`until` bound the
 * LastModifiedCreatedCustomersEmployees window (required by that
 * endpoint) — pass a wide range (e.g. the agency's founding year to today)
 * for a full backfill.
 */
export async function importFromQQApi({ since, until = new Date().toISOString().slice(0, 10), outPath = config.qq.clientIndexPath, pageSize = 100, fetchImpl } = {}) {
  if (!since) throw new Error('importFromQQApi requires `since` (an ISO start date) — required by the underlying QQ endpoint.');
  const opts = fetchImpl ? { fetchImpl } : {};

  const clients = [];
  let pageNumber = 1;
  for (;;) {
    const page = await listCustomersPage({ since, until, pageNumber, pageSize }, opts);
    const { rows, isLastPage } = extractPage(page);
    for (const row of rows) {
      const customerId = row.EntityID ?? row.CustomerID ?? row.Id;
      if (customerId == null) continue;
      const detail = await getCustomerDetail(customerId, opts);
      const policyResponse = await listPoliciesForCustomer(customerId, opts);
      const { rows: policyRows } = extractPage(policyResponse);

      // Best-effort: a customer with no address on file, or an endpoint
      // permission wrinkle for a specific contact, must not abort the
      // whole backfill — zip just stays null for that one client (§4.4
      // already treats zip as optional).
      let zip = null;
      try {
        zip = firstZip(await getContactAddresses(customerId, opts));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[qq-import] could not fetch address for customer ${customerId}: ${err.message}`);
      }

      clients.push({
        id: String(customerId),
        name: customerName(detail),
        zip,
        policies: policyRows.map(policyNumberOf).filter(Boolean)
      });
    }
    if (isLastPage || rows.length === 0) break;
    pageNumber++;
  }

  return writeClientIndex(clients.filter(c => c.name), outPath, { source: 'qq-catalyst-api' });
}
