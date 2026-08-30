import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { importFromQQApi, mapCsvRowsToClients, parseCsv, writeClientIndex } from '../src/resolve/importClientIndex.js';

describe('resolve/importClientIndex', () => {
  it('writeClientIndex refuses to write anywhere under src/ (ADR 0006 — no real data in the committed synthetic index)', () => {
    expect(() => writeClientIndex([], path.join(config.root, 'src', 'resolve', 'index.json'), { source: 'test' }))
      .toThrow(/Refusing to write/);
  });

  it('writeClientIndex writes a valid index file to an allowed path', () => {
    const out = path.join(os.tmpdir(), `ops-client-index-${Date.now()}.json`);
    const written = writeClientIndex([{ id: '1', name: 'Fictional Co', zip: null, policies: [] }], out, { source: 'test' });
    const parsed = JSON.parse(fs.readFileSync(written, 'utf8'));
    expect(parsed.source).toBe('test');
    expect(parsed.clients).toHaveLength(1);
    fs.rmSync(written, { force: true });
  });

  it('parseCsv handles quoted fields with embedded commas', () => {
    const rows = parseCsv('id,name\n1,"Fictional, Co LLC"\n2,Plain Name\n');
    expect(rows).toEqual([
      { id: '1', name: 'Fictional, Co LLC' },
      { id: '2', name: 'Plain Name' }
    ]);
  });

  it('mapCsvRowsToClients applies configured column names and splits delimited policies', () => {
    const rows = [{ client_id: 'C1', client_name: 'Fictional Co', zip: '75201', policy_numbers: 'FQ-1;FQ-2' }];
    expect(mapCsvRowsToClients(rows)).toEqual([{ id: 'C1', name: 'Fictional Co', zip: '75201', policies: ['FQ-1', 'FQ-2'] }]);
  });

  it('mapCsvRowsToClients drops rows missing an id or name', () => {
    const rows = [{ client_id: '', client_name: 'No Id', zip: '', policy_numbers: '' }];
    expect(mapCsvRowsToClients(rows)).toEqual([]);
  });
});

describe('resolve/importClientIndex — importFromQQApi (fake fetch, no live credentials)', () => {
  const savedClientId = config.qq.apiClientId;
  const savedClientSecret = config.qq.apiClientSecret;
  let outPath;

  afterEach(() => {
    config.qq.apiClientId = savedClientId;
    config.qq.apiClientSecret = savedClientSecret;
    if (outPath) fs.rmSync(outPath, { force: true });
  });

  it('paginates customers, fetches each detail + policy list, and writes a mapped client index', async () => {
    config.qq.apiClientId = 'id';
    config.qq.apiClientSecret = 'secret';
    outPath = path.join(os.tmpdir(), `ops-client-index-api-${Date.now()}.json`);

    const fetchImpl = async (url) => {
      if (url.includes('/Contacts/LastModifiedCreatedCustomersEmployees')) {
        return { ok: true, json: async () => ({ Data: [{ EntityID: 101 }], PageNumber: 1, PagesTotal: 1 }) };
      }
      if (url.includes('/CustomerDetailSummary')) {
        return { ok: true, json: async () => ({ EntityID: 101, DisplayName: 'Fictional Test Co' }) };
      }
      if (url.includes('/Policies/ByCustomer/')) {
        return { ok: true, json: async () => ({ Data: [{ PolicyNumber: 'FQ-000999' }], PageNumber: 1, PagesTotal: 1 }) };
      }
      if (url.includes('/Addresses')) {
        return { ok: true, json: async () => ({ Data: [{ Zip: '75201' }], PageNumber: 1, PagesTotal: 1 }) };
      }
      throw new Error(`unexpected url in test: ${url}`);
    };

    const written = await importFromQQApi({ since: '2026-01-01', outPath, fetchImpl });
    const parsed = JSON.parse(fs.readFileSync(written, 'utf8'));
    expect(parsed.source).toBe('qq-catalyst-api');
    expect(parsed.clients).toEqual([{ id: '101', name: 'Fictional Test Co', zip: '75201', policies: ['FQ-000999'] }]);
  });

  it('degrades gracefully to zip: null when the address lookup fails for one customer, without aborting the import', async () => {
    config.qq.apiClientId = 'id';
    config.qq.apiClientSecret = 'secret';
    outPath = path.join(os.tmpdir(), `ops-client-index-api-noaddr-${Date.now()}.json`);

    const fetchImpl = async (url) => {
      if (url.includes('/Contacts/LastModifiedCreatedCustomersEmployees')) {
        return { ok: true, json: async () => ({ Data: [{ EntityID: 202 }], PageNumber: 1, PagesTotal: 1 }) };
      }
      if (url.includes('/CustomerDetailSummary')) {
        return { ok: true, json: async () => ({ EntityID: 202, DisplayName: 'No Address Co' }) };
      }
      if (url.includes('/Policies/ByCustomer/')) {
        return { ok: true, json: async () => ({ Data: [], PageNumber: 1, PagesTotal: 1 }) };
      }
      if (url.includes('/Addresses')) {
        return { ok: false, status: 404, statusText: 'Not Found' };
      }
      throw new Error(`unexpected url in test: ${url}`);
    };

    const written = await importFromQQApi({ since: '2026-01-01', outPath, fetchImpl });
    const parsed = JSON.parse(fs.readFileSync(written, 'utf8'));
    expect(parsed.clients).toEqual([{ id: '202', name: 'No Address Co', zip: null, policies: [] }]);
  });
});
