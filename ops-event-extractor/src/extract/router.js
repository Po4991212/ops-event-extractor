'use strict';
const fs = require('node:fs');
const path = require('node:path');

/**
 * Deterministic routing.
 *
 * Two failure modes this guards against:
 *
 *   1. Substring matching on the sender. "notices@twia.test.evil-lookalike.test"
 *      contains "twia.test", and a naive check would hand an attacker-controlled
 *      message the trust of a known carrier. Matching here is exact address or
 *      exact domain/subdomain boundary.
 *
 *   2. Over-eager noise filtering. A carrier that sends login alerts also sends
 *      cancellation notices from the same address. A message is only dropped
 *      when it matches a known benign template AND carries no obligation cue.
 */
const CFG_PATH = path.resolve(__dirname, '..', '..', 'config', 'parser-sources.json');

function loadSources(p = CFG_PATH) {
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  return {
    verified: Boolean(raw.verified_against_live_corpus),
    families: raw.families,
    benign: (raw.benign_templates || []).map((b) => ({ ...b, re: new RegExp(b.subject, 'i') })),
  };
}

function addressOf(fromHeader) {
  const m = /<([^>]+)>/.exec(fromHeader || '');
  const addr = (m ? m[1] : String(fromHeader || '')).trim().toLowerCase();
  return addr.includes('@') ? addr : '';
}

function domainMatches(domain, configured) {
  return domain === configured || domain.endsWith(`.${configured}`);
}

function familyFor(fromHeader, sources) {
  const addr = addressOf(fromHeader);
  if (!addr) return null;
  const domain = addr.split('@').pop();
  for (const [family, spec] of Object.entries(sources.families)) {
    if ((spec.addresses || []).some((a) => a.toLowerCase() === addr)) return family;
    if ((spec.domains || []).some((d) => domainMatches(domain, d.toLowerCase()))) return family;
  }
  return null;
}

const OBLIGATION_CUES = [
  /\b(due|deadline|expires?|expiration|lapse|cancel|cancellation|nonrenew|non-renew|audit|certificate|signature|signed|bind|binding|payment|installment|premium|required|respond|reply|provide|send|remove|add)\b/i,
  /\$\s?\d/,
  /\b\d{1,2}\/\d{1,2}\/\d{4}\b/,
];

function hasObligationCue(text) { return OBLIGATION_CUES.some((re) => re.test(text)); }

/**
 * @returns {{family:string|null, route:'family'|'fallback'|'noise', reason:string, senderVerified:boolean}}
 */
function route(message, blocks, sources) {
  const family = familyFor(message.from_addr, sources);
  const replyText = blocks.filter((b) => b.kind === 'reply' || b.kind === 'table')
    .map((b) => b.canonical_text).join('\n');

  if (family) {
    const benign = sources.benign.find((b) => b.family === family && b.re.test(message.subject || ''));
    if (benign && !hasObligationCue(replyText)) {
      return { family, route: 'noise', reason: `known benign template for ${family} with no obligation cue`, senderVerified: sources.verified };
    }
    return { family, route: 'family', reason: `exact sender match for ${family}`, senderVerified: sources.verified };
  }

  return {
    family: null,
    route: 'fallback',
    reason: 'sender does not exactly match any configured family',
    senderVerified: sources.verified,
  };
}

module.exports = { route, loadSources, familyFor, addressOf, domainMatches, hasObligationCue };
