'use strict';
const fs = require('node:fs');
const path = require('node:path');

/**
 * Source scanner for outbound-delivery capability.
 *
 * The pattern list lives in policy/no-send-patterns.json, outside the scanned
 * tree, so this file contains no literal prohibited strings and the scan cannot
 * fail on its own examples. Comments are scanned too: a commented-out delivery
 * call is one uncomment away from being real, so it counts as a finding.
 */
const ROOT = path.resolve(__dirname, '..', '..');

function loadPolicy(policyPath = path.join(ROOT, 'policy', 'no-send-patterns.json')) {
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  return {
    ...policy,
    compiled: policy.patterns.map((p) => ({ ...p, re: new RegExp(p.regex, 'gi') })),
  };
}

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

/**
 * Positional root, matching leakage.check(root, options). Two security scanners
 * with opposite calling conventions is how a caller ends up scanning the wrong
 * tree and reading the empty result as a pass.
 *
 * @returns {{files:number, findings:Array, targets:string[], policyVersion:number}}
 */
function scan(root = ROOT, { policy = loadPolicy(), targets = null, extensions = null } = {}) {
  const exts = extensions || policy.extensions;
  const dirs = (targets || policy.targets).map((t) => path.join(root, t));
  const findings = [];
  let files = 0;
  for (const dir of dirs) {
    for (const file of walk(dir)) {
      if (!exts.includes(path.extname(file))) continue;
      files += 1;
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split('\n');
      for (const pat of policy.compiled) {
        pat.re.lastIndex = 0;
        let m;
        while ((m = pat.re.exec(text)) !== null) {
          const line = text.slice(0, m.index).split('\n').length;
          findings.push({
            file: path.relative(root, file),
            line,
            patternId: pat.id,
            why: pat.why,
            context: (lines[line - 1] || '').trim().slice(0, 120),
          });
        }
      }
    }
  }
  return { files, findings, targets: targets || policy.targets, policyVersion: policy.version };
}

module.exports = { scan, loadPolicy };
