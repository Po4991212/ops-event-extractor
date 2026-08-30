import { describe, expect, it } from 'vitest';
import { parseDailyTasks } from '../src/parsers/dailytasks.js';

const msg = {
  id: 'dt-1',
  internal_date: Date.parse('2026-07-17T18:00:00.000Z'),
  body_text: [
    'Completed',
    '   - Fictional Account One LLC – Followed up on the new business process. The policy',
    '     was bound, and the agent sent the thank-you email. Case completed.',
    '',
    'Pending / Follow-up',
    '   - Larry Fictional – Followed up on the renewal payment. Payment has not',
    '     been made yet. Emailed the insured with another reminder.',
    '     Follow-up scheduled for 8/24 to confirm receipt.'
  ].join('\n')
};

describe('parsers/dailytasks (§3.4 — ground truth, not the pipeline under test)', () => {
  it('splits Completed vs Pending/Follow-up sections and unwraps continuation lines', () => {
    const rows = parseDailyTasks(msg);
    expect(rows).toHaveLength(2);
    expect(rows[0].section).toBe('completed');
    expect(rows[0].account_name_raw).toBe('Fictional Account One LLC');
    expect(rows[0].obligation).toMatch(/thank-you email\. Case completed\.$/);
    expect(rows[1].section).toBe('pending');
  });

  it('resolves a bare M/D follow-up date relative to the message date', () => {
    const rows = parseDailyTasks(msg);
    expect(rows[1].due_date).toBe('2026-08-24');
  });

  it('infers a payment_due kind from "renewal payment" phrasing', () => {
    const rows = parseDailyTasks(msg);
    expect(rows[1].kind).toBe('payment_due');
  });

  it('returns an empty array for a message with no recognizable section headers', () => {
    expect(parseDailyTasks({ ...msg, body_text: 'Just a normal email with no structure.' })).toEqual([]);
  });
});
