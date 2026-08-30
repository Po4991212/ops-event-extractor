import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// §6.2/§0.7/§9: this codebase must never contain a path to
// gmail.users.messages.send or gmail.users.drafts.send. Drafts may be
// created (drafts.create) but never sent.
const FORBIDDEN = [/users\.messages\.send/, /users\.drafts\.send/, /\.messages\s*\.\s*send\s*\(/, /\.drafts\s*\.\s*send\s*\(/];

describe('security: no outbound-send endpoint exists anywhere in src/ (§6.2, §9)', () => {
  it('scans every src/*.js file for forbidden Gmail send patterns', () => {
    const offenders = [];
    for (const file of walk(SRC_DIR)) {
      const content = fs.readFileSync(file, 'utf8');
      for (const re of FORBIDDEN) {
        if (re.test(content)) offenders.push(`${path.relative(SRC_DIR, file)} matches ${re}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
