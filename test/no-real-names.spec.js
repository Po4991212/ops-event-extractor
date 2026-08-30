import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// §0.6/ADR 0006: every proper noun docs/SPEC.md's own narrative uses as an
// illustrative "real mailbox" example. None may appear in committed
// synthetic/demo/test data.
const REAL_NAMES = [
  'HangCao', 'Alpha Nail Spa Charlotte', 'Larry Cheek', 'DNA Access Services',
  'Sugar Nails of Clemson', 'Brookfield Town Homes', 'Mr. Bits', 'Escamillia',
  'Stars Plumbing', 'Tobacco & Vapor', 'Tobacco and Vapor', 'Little P', 'Roger Vo'
];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function scan(dir) {
  const offenders = [];
  if (!fs.existsSync(dir)) return offenders;
  for (const file of walk(dir)) {
    const content = fs.readFileSync(file, 'utf8');
    for (const name of REAL_NAMES) {
      if (content.toLowerCase().includes(name.toLowerCase())) {
        offenders.push(`${path.relative(ROOT, file)} contains "${name}"`);
      }
    }
  }
  return offenders;
}

describe('privacy: committed synthetic/test data never reuses docs/SPEC.md\'s narrative example names (§0.6, ADR 0006)', () => {
  it('data/synthetic/ is clean', () => {
    expect(scan(path.join(ROOT, 'data', 'synthetic'))).toEqual([]);
  });

  it('test/fixtures/ is clean', () => {
    expect(scan(path.join(ROOT, 'test', 'fixtures'))).toEqual([]);
  });

  it('src/resolve/ (the synthetic client index) is clean', () => {
    expect(scan(path.join(ROOT, 'src', 'resolve'))).toEqual([]);
  });
});
