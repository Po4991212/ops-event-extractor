import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ringcentral from '../src/parsers/ringcentral.js';
import foxquilt from '../src/parsers/foxquilt.js';
import twia from '../src/parsers/twia.js';
import hellosign from '../src/parsers/hellosign.js';
import ipfs from '../src/parsers/ipfs.js';
import progressive from '../src/parsers/progressive.js';
import coisolution from '../src/parsers/coisolution.js';
import { parsers } from '../src/parsers/registry.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8'));

describe('parsers/registry', () => {
  it('lists exactly the 7 carrier/vendor parsers (dailytasks is not routed through it, §3.4)', () => {
    expect(parsers.map(p => p.name).sort()).toEqual(
      ['coisolution', 'foxquilt', 'hellosign', 'ipfs', 'progressive', 'ringcentral-callnotes', 'twia'].sort()
    );
  });

  it('exactly one parser claims each fixture — routing is unambiguous', () => {
    const fixtures = [
      load('foxquilt-renewal.json'), load('twia-renewal.json'), load('hellosign-pending.json'),
      load('ipfs-installment.json'), load('progressive-uw.json'), load('coisolution-request.json'),
      { ...load('ringcentral-callnotes.json') }
    ];
    for (const msg of fixtures) {
      const claimants = parsers.filter(p => p.match(msg));
      expect(claimants.length, `expected exactly 1 parser for ${msg.subject}, got ${claimants.map(c => c.name)}`).toBe(1);
    }
  });
});

describe('parsers/foxquilt', () => {
  it('extracts policy number, stated expiration date, and renewal_due kind', () => {
    const msg = load('foxquilt-renewal.json');
    expect(foxquilt.match(msg)).toBe(true);
    const [ev] = foxquilt.parse(msg);
    expect(ev.kind).toBe('renewal_due');
    expect(ev.policy_no).toBe('FQ-77102233');
    expect(ev.due_date).toBe('2026-10-12');
    expect(ev.due_date_basis).toBe('stated');
    expect(msg.body_full).toContain(ev.raw_span);
  });

  it('flags a lapse as lapse_warning, not renewal_due', () => {
    const msg = { ...load('foxquilt-renewal.json'), body_full: 'Policy Number: FQ-000111\nRenewal was unsuccessful. Coverage has lapsed.' };
    const [ev] = foxquilt.parse(msg);
    expect(ev.kind).toBe('lapse_warning');
  });
});

describe('parsers/twia', () => {
  it('extracts a masked policy tail and the renewal offer date', () => {
    const msg = load('twia-renewal.json');
    expect(twia.match(msg)).toBe(true);
    const [ev] = twia.parse(msg);
    expect(ev.kind).toBe('renewal_due');
    expect(ev.policy_no).toBe('...9981');
    expect(ev.due_date).toBe('2026-10-05');
  });
});

describe('parsers/hellosign', () => {
  it('flags a pending signature as signature_required', () => {
    const msg = load('hellosign-pending.json');
    expect(hellosign.match(msg)).toBe(true);
    const [ev] = hellosign.parse(msg);
    expect(ev.kind).toBe('signature_required');
    expect(ev.obligation).toMatch(/LPR - Fictional Test Account LLC/);
    expect(ev.account_name_raw).toBe('Fictional Test Account LLC');
  });

  it('returns no event for an unrelated hellosign notification', () => {
    const msg = { ...load('hellosign-pending.json'), subject: 'Reminder settings updated', body_full: 'Your reminder preferences were updated.' };
    expect(hellosign.parse(msg)).toEqual([]);
  });
});

describe('parsers/ipfs', () => {
  it('extracts account, amount, and due date as payment_due', () => {
    const msg = load('ipfs-installment.json');
    const [ev] = ipfs.parse(msg);
    expect(ev.kind).toBe('payment_due');
    expect(ev.policy_no).toBe('IPFS-445291');
    expect(ev.amount_cents).toBe(31000);
    expect(ev.due_date).toBe('2026-10-03');
  });
});

describe('parsers/progressive', () => {
  it('flags an underwriting request as uw_question', () => {
    const msg = load('progressive-uw.json');
    const [ev] = progressive.parse(msg);
    expect(ev.kind).toBe('uw_question');
    expect(ev.policy_no).toBe('04112233-1');
  });

  it('flags an endorsement request as endorsement_request, not uw_question', () => {
    const msg = { ...load('progressive-uw.json'), subject: 'Endorsement request received', body_full: 'Policy Number: 04 998877-1\nWe have received your endorsement request.' };
    const [ev] = progressive.parse(msg);
    expect(ev.kind).toBe('endorsement_request');
  });
});

describe('parsers/coisolution', () => {
  it('extracts the insured name and an expiry-days-derived obligation', () => {
    const msg = load('coisolution-request.json');
    const [ev] = coisolution.parse(msg);
    expect(ev.kind).toBe('coi_request');
    expect(ev.account_name_raw).toBe('Fictional Test Account LLC');
    expect(ev.obligation).toMatch(/9 days/);
  });
});

describe('parsers/ringcentral', () => {
  it('extracts a task as client_commitment with a derived due date and a resolved account name', () => {
    const msg = load('ringcentral-callnotes.json');
    const [ev] = ringcentral.parse(msg);
    expect(ev.kind).toBe('client_commitment');
    expect(ev.due_date_basis).toBe('derived');
    expect(ev.account_name_raw).toBe('Alder Plumbing & Rooter LLC');
    expect(msg.body_full).toContain(ev.raw_span);
  });

  it('deriveDue table (§4.2): each phrase maps to the documented basis', async () => {
    const { deriveDue } = await import('../src/parsers/ringcentral.js');
    expect(deriveDue('call today', '2026-10-06').basis).toBe('derived');
    expect(deriveDue('reach out shortly', '2026-10-06').basis).toBe('derived');
    expect(deriveDue('no temporal phrase here', '2026-10-06')).toEqual({ date: null, basis: 'absent' });
  });
});
