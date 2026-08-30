import { parsers } from '../parsers/registry.js';

// Largest bucket, cheapest to decide — checked first (§4.1). Each pattern
// also matches a "-example" demo-domain variant so the committed synthetic
// corpus (data/synthetic/, §3.5/ADR 0006) exercises real routing without
// using a real vendor's literal domain there.
const NOISE = [
  /VerifyMFA@hanover(-example)?\.com/i,
  /account@coterieinsurance(-example)?\.com/i,
  /agentportal@wholesure(-example)?\.com/i,
  /noreply@steadily(-example)?\.com/i,
  /status@notifications\.ringcentral(-example)?\.com/i,
  /@notification\.intuit(-example)?\.com/i
];

/** noise (largest, cheapest) → parser registry (deterministic, cheap) → llm (last resort). */
export function route(msg) {
  if (NOISE.some(re => re.test(msg.from_addr || ''))) return { handler: 'noise' };

  for (const p of parsers) {
    if (p.match(msg)) return { handler: 'parser', parser: p };
  }
  return { handler: 'llm' };
}
