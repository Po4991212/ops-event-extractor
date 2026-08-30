import { describe, expect, it } from 'vitest';
import { addBusinessDays, isPlausibleRange, nextWeekday, resolveShortDate } from '../src/normalize/dates.js';

describe('normalize/dates', () => {
  it('resolveShortDate rolls a same-year candidate forward a year when it would land >60 days in the past (§3.4)', () => {
    // Message sent in December referencing "1/15" should mean next January, not one already 11 months gone.
    const ref = Date.parse('2026-12-10T00:00:00Z');
    expect(resolveShortDate('1/15', ref)).toBe('2027-01-15');
  });

  it('resolveShortDate keeps a near-term same-year date as-is', () => {
    const ref = Date.parse('2026-07-01T00:00:00Z');
    expect(resolveShortDate('7/24', ref)).toBe('2026-07-24');
  });

  it('resolveShortDate honors an explicit year when given', () => {
    const ref = Date.parse('2026-07-01T00:00:00Z');
    expect(resolveShortDate('8/24/25', ref)).toBe('2025-08-24');
  });

  it('addBusinessDays skips weekends', () => {
    // Friday 2026-07-17 + 1 business day = Monday 2026-07-20
    expect(addBusinessDays('2026-07-17', 1)).toBe('2026-07-20');
  });

  it('nextWeekday finds the next occurrence strictly after the reference date', () => {
    // 2026-07-14 is a Tuesday; next Friday should be 2026-07-17
    expect(nextWeekday('2026-07-14', 'friday')).toBe('2026-07-17');
  });

  it('isPlausibleRange rejects wildly out-of-range dates', () => {
    expect(isPlausibleRange('2026-08-01', '2026-08-01')).toBe(true);
    expect(isPlausibleRange('2019-01-01', '2026-08-01')).toBe(false);
    expect(isPlausibleRange('2040-01-01', '2026-08-01')).toBe(false);
  });
});
