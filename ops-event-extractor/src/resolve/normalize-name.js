'use strict';
/**
 * Name normalization for EXACT matching only.
 *
 * This deliberately does not do fuzzy matching. Normalizing "Bluebonnet
 * Logistics, L.L.C." and "BLUEBONNET LOGISTICS LLC" to the same string is safe;
 * deciding that "Bluebonnet Logistics" and "Bluebonnet Leasing" are probably
 * the same account is not, and this function will never say they are.
 */
const SUFFIXES = {
  'L L C': 'LLC', 'L.L.C.': 'LLC', LLC: 'LLC', 'L.P.': 'LP', LP: 'LP',
  INC: 'INC', 'INC.': 'INC', INCORPORATED: 'INC', CORP: 'CORP', 'CORP.': 'CORP',
  CORPORATION: 'CORP', CO: 'CO', 'CO.': 'CO', COMPANY: 'CO', PLLC: 'PLLC',
  'P.L.L.C.': 'PLLC', LTD: 'LTD', 'LTD.': 'LTD', PA: 'PA', PC: 'PC',
};

function normalizeName(name) {
  if (!name) return '';
  let s = String(name).normalize('NFKC').toUpperCase();
  s = s.replace(/&/g, ' AND ');
  s = s.replace(/[.,'"`()\[\]]/g, ' ');
  s = s.replace(/[^A-Z0-9 \-\/]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  const tokens = s.split(' ').map((t) => SUFFIXES[t] || t);
  return tokens.join(' ').replace(/^THE /, '').trim();
}

/** Similarity is used ONLY to rank review candidates. It never authorizes a match. */
function rankScore(a, b) {
  const A = new Set(normalizeName(a).split(' '));
  const B = new Set(normalizeName(b).split(' '));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / (A.size + B.size - inter);
}

module.exports = { normalizeName, rankScore };
