import { describe, expect, it, afterEach, vi } from 'vitest';
import { config } from '../src/config.js';
import { createContactNote } from '../src/resolve/qqClient.js';
import { buildNotePayload, pushTask } from '../src/writeback/qq.js';

// §0.1/§6.3/ADR 0001 addendum: dry-run by default; live requires both
// --live and QQ_LIVE_WRITES_APPROVED, and additionally refuses per-task
// when the account hasn't been resolved to a real numeric QQ contact id.
// qqClient.js is mocked file-wide so no test here makes a real HTTP call.
vi.mock('../src/resolve/qqClient.js', () => ({
  createContactNote: vi.fn()
}));

const baseTask = { event_key: 'ek1', kind: 'payment_due', obligation: 'Confirm payment.', title: 'Confirm payment.', due_date: '2026-09-01', policy_no: 'FQ-1', account_id: 'C-1001' };

describe('writeback/qq — buildNotePayload (NoteDTO shape, ADR 0001 addendum)', () => {
  it('maps a task to AssignedContactId/Comment, null for a non-numeric (synthetic) account id', () => {
    const payload = buildNotePayload(baseTask);
    expect(payload.AssignedContactId).toBeNull();
    expect(payload.Comment).toContain('payment_due');
    expect(payload.Comment).toContain('FQ-1');
  });

  it('maps a real numeric account id through', () => {
    const payload = buildNotePayload({ ...baseTask, account_id: '4021' });
    expect(payload.AssignedContactId).toBe(4021);
  });

  it('flags lapse_warning and cancellation_notice as Important', () => {
    expect(buildNotePayload({ ...baseTask, kind: 'lapse_warning' }).Important).toBe(true);
    expect(buildNotePayload({ ...baseTask, kind: 'payment_due' }).Important).toBe(false);
  });
});

describe('writeback/qq — pushTask gating', () => {
  const saved = { liveWritesApproved: config.qq.liveWritesApproved, apiClientId: config.qq.apiClientId, apiClientSecret: config.qq.apiClientSecret };
  afterEach(() => { Object.assign(config.qq, saved); createContactNote.mockClear(); });

  it('dry-runs by default (live: false)', async () => {
    const result = await pushTask(baseTask, { live: false });
    expect(result).toEqual({ ok: true, dryRun: true, payload: expect.any(Object) });
    expect(createContactNote).not.toHaveBeenCalled();
  });

  it('dry-runs even with live:true if QQ_LIVE_WRITES_APPROVED is not set', async () => {
    config.qq.liveWritesApproved = false;
    const result = await pushTask(baseTask, { live: true });
    expect(result.dryRun).toBe(true);
    expect(result.payload.blockedReason).toMatch(/QQ_LIVE_WRITES_APPROVED/);
    expect(createContactNote).not.toHaveBeenCalled();
  });

  it('dry-runs if approved but the account id is not a real numeric QQ id', async () => {
    config.qq.liveWritesApproved = true;
    config.qq.apiClientId = 'id';
    config.qq.apiClientSecret = 'secret';
    const result = await pushTask(baseTask, { live: true });
    expect(result.dryRun).toBe(true);
    expect(result.payload.blockedReason).toMatch(/not a real QQ contact id/);
    expect(createContactNote).not.toHaveBeenCalled();
  });

  it('actually calls the QQ client when live, approved, credentialed, and a real account id', async () => {
    config.qq.liveWritesApproved = true;
    config.qq.apiClientId = 'id';
    config.qq.apiClientSecret = 'secret';
    createContactNote.mockResolvedValueOnce({ IsSuccess: true, Result: { Id: 999 } });

    const result = await pushTask({ ...baseTask, account_id: '4021' }, { live: true });
    expect(createContactNote).toHaveBeenCalledWith(expect.objectContaining({ AssignedContactId: 4021 }));
    expect(result).toEqual({ ok: true, dryRun: false, qqNoteId: 999, response: expect.any(Object) });
  });
});
