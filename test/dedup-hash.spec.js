import { describe, expect, it } from 'vitest';
import { contentHash, eventKey } from '../src/dedup/hash.js';

describe('dedup/hash', () => {
  it('contentHash ignores Re:/Fwd: prefixes and whitespace differences', () => {
    const a = { from_addr: 'a@x.com', subject: 'Renewal notice', body_text: 'Hello   world' };
    const b = { from_addr: 'A@X.com', subject: 'Fwd: Renewal notice', body_text: 'Hello world' };
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it('eventKey is identical for the same policy+kind+due_date regardless of source message', () => {
    const a = { kind: 'renewal_due', policy_no: 'FQ-123', account_name_raw: null, due_date: '2026-10-01', source_msg_id: 'm1' };
    const b = { kind: 'renewal_due', policy_no: 'fq-123', account_name_raw: null, due_date: '2026-10-01', source_msg_id: 'm2' };
    expect(eventKey(a)).toBe(eventKey(b));
  });

  it('eventKey changes when the due_date changes (supersession relies on this)', () => {
    const a = { kind: 'renewal_due', policy_no: 'FQ-123', account_name_raw: null, due_date: '2026-10-01', source_msg_id: 'm1' };
    const b = { ...a, due_date: '2026-11-01' };
    expect(eventKey(a)).not.toBe(eventKey(b));
  });

  it('falls back to message scope when neither policy_no nor account_name_raw is present, so unrelated obligations never collapse', () => {
    const a = { kind: 'client_commitment', policy_no: null, account_name_raw: null, due_date: null, source_msg_id: 'm1' };
    const b = { kind: 'client_commitment', policy_no: null, account_name_raw: null, due_date: null, source_msg_id: 'm2' };
    expect(eventKey(a)).not.toBe(eventKey(b));
  });
});
