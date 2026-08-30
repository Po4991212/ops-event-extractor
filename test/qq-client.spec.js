import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { config } from '../src/config.js';

// §4.4/ADR 0007: the QQ Catalyst client's auth-header construction and
// request shape, verified against api.qqcatalyst.com's own docs
// (docs/research-sources.md). No live credentials or network calls — a
// fake `fetchImpl` is injected so this is a pure structural test.

describe('resolve/qqClient (§4.4, ADR 0007)', () => {
  const savedClientId = config.qq.apiClientId;
  const savedClientSecret = config.qq.apiClientSecret;

  beforeEach(() => {
    config.qq.apiClientId = 'test-client-id';
    config.qq.apiClientSecret = 'test-client-secret';
  });
  afterEach(() => {
    config.qq.apiClientId = savedClientId;
    config.qq.apiClientSecret = savedClientSecret;
  });

  it('builds the Authorization header as Basic base64(clientid:clientsecret), ISO-8859-1 encoded', async () => {
    const { getCustomerDetail } = await import('../src/resolve/qqClient.js');
    let capturedHeaders;
    const fetchImpl = vi.fn(async (url, opts) => {
      capturedHeaders = opts.headers;
      return { ok: true, json: async () => ({ EntityID: 1, DisplayName: 'Test' }) };
    });

    await getCustomerDetail(42, { fetchImpl });

    const expected = `Basic ${Buffer.from('test-client-id:test-client-secret', 'latin1').toString('base64')}`;
    expect(capturedHeaders.Authorization).toBe(expected);
  });

  it('hits the documented endpoint paths', async () => {
    const { getCustomerDetail, listPoliciesForCustomer } = await import('../src/resolve/qqClient.js');
    const calledUrls = [];
    const fetchImpl = vi.fn(async (url) => { calledUrls.push(url); return { ok: true, json: async () => ({}) }; });

    await getCustomerDetail(42, { fetchImpl });
    await listPoliciesForCustomer(42, { fetchImpl });

    expect(calledUrls[0]).toBe(`${config.qq.apiBaseUrl}/Customers/42/CustomerDetailSummary`);
    expect(calledUrls[1]).toContain(`${config.qq.apiBaseUrl}/Policies/ByCustomer/42`);
  });

  it('throws a status-only error on a failed response, never echoing the auth header', async () => {
    const { getCustomerDetail } = await import('../src/resolve/qqClient.js');
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, statusText: 'Unauthorized' }));
    await expect(getCustomerDetail(1, { fetchImpl })).rejects.toThrow('401');
    // The rejection message must not contain the secret.
    try { await getCustomerDetail(1, { fetchImpl }); } catch (e) {
      expect(e.message).not.toContain('test-client-secret');
    }
  });

  it('extractPage handles both a bare array and the {Data, PageNumber, PagesTotal} envelope', async () => {
    const { extractPage } = await import('../src/resolve/qqClient.js');
    expect(extractPage([1, 2, 3])).toEqual({ rows: [1, 2, 3], isLastPage: true });
    expect(extractPage({ Data: [1, 2], PageNumber: 1, PagesTotal: 3 })).toEqual({ rows: [1, 2], isLastPage: false });
    expect(extractPage({ Data: [1, 2], PageNumber: 3, PagesTotal: 3 })).toEqual({ rows: [1, 2], isLastPage: true });
    expect(extractPage(null)).toEqual({ rows: [], isLastPage: true });
  });
});
