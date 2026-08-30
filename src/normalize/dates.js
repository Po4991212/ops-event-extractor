import { DateTime } from 'luxon';

export const ZONE = 'America/Chicago';

/** Parses an ISO yyyy-mm-dd date in the agency's zone. Returns an invalid DateTime if unparseable. */
export function parseISO(iso) {
  if (!iso) return DateTime.invalid('empty');
  return DateTime.fromISO(iso, { zone: ZONE });
}

export function isoDate(epochMs) {
  return DateTime.fromMillis(epochMs, { zone: ZONE }).toISODate();
}

export function daysBetween(fromIso, toIso) {
  const a = parseISO(fromIso);
  const b = parseISO(toIso);
  if (!a.isValid || !b.isValid) return NaN;
  return Math.round(b.diff(a, 'days').days);
}

export function addDays(iso, n) {
  return parseISO(iso).plus({ days: n }).toISODate();
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function isWeekend(dt) {
  return dt.weekday === 6 || dt.weekday === 7; // luxon: 6=Sat, 7=Sun
}

/** Adds N *business* days (Mon–Fri) to an ISO date. */
export function addBusinessDays(iso, n) {
  let dt = parseISO(iso);
  let remaining = n;
  const step = remaining >= 0 ? 1 : -1;
  while (remaining !== 0) {
    dt = dt.plus({ days: step });
    if (!isWeekend(dt)) remaining -= step;
  }
  return dt.toISODate();
}

/** Next occurrence of a named weekday on/after `fromIso` (exclusive of fromIso itself). */
export function nextWeekday(fromIso, weekdayName) {
  const target = WEEKDAYS.indexOf(weekdayName.toLowerCase());
  if (target === -1) return null;
  // luxon weekday: 1=Mon..7=Sun; our WEEKDAYS array is 0=Sun..6=Sat
  const luxonTarget = target === 0 ? 7 : target;
  let dt = parseISO(fromIso).plus({ days: 1 });
  for (let i = 0; i < 7; i++) {
    if (dt.weekday === luxonTarget) return dt.toISODate();
    dt = dt.plus({ days: 1 });
  }
  return null;
}

/**
 * Resolves a bare M/D (optionally M/D/YY[YY]) date against a reference message date.
 * §3.4: if the naive same-year answer lands more than 60 days in the past,
 * roll forward a year — near a year boundary "8/24" seen in a December email
 * means next August, not one that already passed.
 */
export function resolveShortDate(shortDate, referenceEpochMs) {
  const m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(shortDate.trim());
  if (!m) return null;
  const [, mo, day, yr] = m;
  const ref = DateTime.fromMillis(referenceEpochMs, { zone: ZONE });
  let year = yr ? (yr.length === 2 ? 2000 + Number(yr) : Number(yr)) : ref.year;
  let candidate = DateTime.fromObject({ year, month: Number(mo), day: Number(day) }, { zone: ZONE });
  if (!candidate.isValid) return null;
  if (!yr) {
    const daysDiff = candidate.diff(ref, 'days').days;
    if (daysDiff < -60) candidate = candidate.plus({ years: 1 });
  }
  return candidate.toISODate();
}

/** Is `iso` a plausible obligation date relative to `todayIso`? Used by confidence scoring. */
export function isPlausibleRange(iso, todayIso) {
  const days = daysBetween(todayIso, iso);
  if (Number.isNaN(days)) return false;
  return days >= -400 && days <= 800;
}
