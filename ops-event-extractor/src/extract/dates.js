'use strict';
const { DateTime } = require('luxon');

/**
 * Date phrase -> ISO date, with the rule that produced it recorded.
 *
 * A derived date is never stored as though it were something the carrier wrote.
 * The caller keeps the original phrase, the timezone used and the rule name
 * alongside the ISO value.
 */
const RULES = [
  { name: 'us_slash_mdY', re: /\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/((?:19|20)\d{2})\b/,
    build: (m) => ({ month: +m[1], day: +m[2], year: +m[3] }) },
  { name: 'iso_ymd', re: /\b((?:19|20)\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/,
    build: (m) => ({ year: +m[1], month: +m[2], day: +m[3] }) },
  { name: 'long_month_dY', re: /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+((?:19|20)\d{2})\b/i,
    build: (m) => ({ month: MONTHS[m[1].toLowerCase()], day: +m[2], year: +m[3] }) },
  { name: 'abbrev_month_dY', re: /\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+(\d{1,2}),?\s+((?:19|20)\d{2})\b/i,
    build: (m) => ({ month: MONTHS[m[1].toLowerCase().slice(0, 3)], day: +m[2], year: +m[3] }) },
];

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8,
  september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function parseDatePhrase(text, zone) {
  for (const rule of RULES) {
    const m = rule.re.exec(text);
    if (!m) continue;
    const parts = rule.build(m);
    const dt = DateTime.fromObject(parts, { zone });
    if (!dt.isValid) continue;
    return { iso: dt.toISODate(), phrase: m[0], rule: `${rule.name}@${zone}`, index: m.index };
  }
  return null;
}

function allDatePhrases(text, zone) {
  const out = [];
  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, `${rule.re.flags.includes('i') ? 'gi' : 'g'}`);
    let m;
    while ((m = re.exec(text)) !== null) {
      const dt = DateTime.fromObject(rule.build(m), { zone });
      if (dt.isValid) out.push({ iso: dt.toISODate(), phrase: m[0], rule: `${rule.name}@${zone}`, index: m.index });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

function parseAmount(text) {
  const m = /\$\s?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?)/.exec(text);
  if (!m) return null;
  return { value: Number(m[1].replace(/,/g, '')), currency: 'USD', phrase: m[0], index: m.index };
}

module.exports = { parseDatePhrase, allDatePhrases, parseAmount };
