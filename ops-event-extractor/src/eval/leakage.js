'use strict';
const fs = require('node:fs');
const path = require('node:path');

/**
 * Checks that nothing real leaked into the repository.
 *
 * Two lists. The public one, checked in, holds patterns that are always wrong
 * to commit: credentials, tokens, keys, live-looking mailbox addresses. The
 * private one holds real client and carrier names and is deliberately NOT in
 * this repository - it lives outside it, and if it is absent the check says so
 * out loud rather than passing quietly. A green result from an unavailable list
 * is a false assurance, and this function refuses to give one.
 */
const SECRET_PATTERNS = [
  { name: 'openai key', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'aws access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private key block', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'bearer token literal', re: /Bearer\s+[A-Za-z0-9._-]{24,}/ },
  { name: 'google oauth client secret', re: /\bGOCSPX-[A-Za-z0-9_-]{20,}/ },
  { name: 'real aiinsure address', re: /[A-Za-z0-9._%+-]+@aiinsure\.com/ },
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'var', 'coverage']);

function walk(root, acc = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(root, entry.name), acc);
    } else if (entry.isFile()) acc.push(path.join(root, entry.name));
  }
  return acc;
}

function loadPrivateList(listPath) {
  if (!listPath) return { available: false, reason: 'no path configured (OPS_PRIVATE_NAME_LIST unset)', terms: [] };
  if (!fs.existsSync(listPath)) return { available: false, reason: `configured path does not exist: ${listPath}`, terms: [] };
  const terms = fs.readFileSync(listPath, 'utf8').split('\n')
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return { available: true, reason: `loaded ${terms.length} terms`, terms };
}

function check(root, { privateListPath = process.env.OPS_PRIVATE_NAME_LIST } = {}) {
  const files = walk(root).filter((f) => !/\.(png|jpg|jpeg|gif|pdf|sqlite|eml)$/i.test(f));
  const findings = [];
  const priv = loadPrivateList(privateListPath);

  for (const file of files) {
    const rel = path.relative(root, file);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const p of SECRET_PATTERNS) {
      const m = text.match(p.re);
      if (m) findings.push({ file: rel, kind: p.name, evidence: `${m[0].slice(0, 6)}...` });
    }
    for (const term of priv.terms) {
      if (term.length < 4) continue;
      if (new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) {
        findings.push({ file: rel, kind: 'private name list match', evidence: '[redacted]' });
      }
    }
  }

  return {
    filesScanned: files.length,
    findings,
    privateList: priv,
    // The only honest verdict when half the check could not run.
    verdict: findings.length ? 'findings'
      : priv.available ? 'clean' : 'clean against public patterns only; private name list was not available',
    complete: findings.length === 0 && priv.available,
  };
}

module.exports = { check, SECRET_PATTERNS };
