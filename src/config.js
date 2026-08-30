import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// No dotenv dependency: Node 22 supports `--env-file=.env` natively
// (see README "Setup"). This loader is a convenience fallback for ad-hoc
// scripts started without that flag — it never overrides a variable the
// process was actually launched with.
//
// Skipped entirely under Vitest (which sets process.env.VITEST): the test
// suite must be hermetic and never pick up a developer's real .env — a
// real ANTHROPIC_API_KEY sitting there once caused `npm test` to silently
// attempt a live Anthropic call and hang on a 5s timeout instead of using
// the synthetic fixtures the tests actually intend to exercise.
function loadDotEnvFallback() {
  if (process.env.VITEST) return;
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
loadDotEnvFallback();

function bool(v, def = false) {
  if (v === undefined || v === null || v === '') return def;
  return String(v).toLowerCase() === 'true';
}

// Fail closed: anything other than the literal string "live" is synthetic.
const mode = process.env.OPS_MODE === 'live' ? 'live' : 'synthetic';

const classificationModel = process.env.ANTHROPIC_CLASSIFICATION_MODEL || 'claude-haiku-4-5-20251001';
const extractionModel = process.env.ANTHROPIC_EXTRACTION_MODEL || 'claude-sonnet-5';

for (const [name, id] of [['ANTHROPIC_CLASSIFICATION_MODEL', classificationModel], ['ANTHROPIC_EXTRACTION_MODEL', extractionModel]]) {
  if (!/^claude-/.test(id)) {
    throw new Error(`${name}="${id}" does not look like a verified Claude model id (must start with "claude-"). ` +
      'See docs/research-sources.md and docs/adr/0004-anthropic-data-flow-and-live-gate.md.');
  }
}

export const config = {
  root: ROOT,
  mode,
  isLive: mode === 'live',

  dbPath: path.join(ROOT, 'data', 'ops.db'),
  rawDir: path.join(ROOT, 'data', 'raw'),
  syntheticDir: path.join(ROOT, 'data', 'synthetic'),
  privateDir: path.join(ROOT, 'data', 'private'),

  gmail: {
    mailbox: process.env.GMAIL_MAILBOX || 'commercialtx@aiinsure.com',
    clientId: process.env.GMAIL_OAUTH_CLIENT_ID || '',
    clientSecret: process.env.GMAIL_OAUTH_CLIENT_SECRET || '',
    tokenStorePath: process.env.GMAIL_TOKEN_STORE_PATH || '',
    syncSince: process.env.GMAIL_SYNC_SINCE || '2026/06/01'
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    classificationModel,
    extractionModel,
    // Independent from OPS_MODE=live: see ADR 0004. Both must be true
    // before any live mail content is sent to Anthropic.
    liveApproved: bool(process.env.OPS_LLM_LIVE_APPROVED, false)
  },

  qq: {
    // QQ Catalyst "Enterprise API Access" — verified against
    // api.qqcatalyst.com/Home/Authentication and api.qqcatalyst.com/Help,
    // accessed 2026-08-29 (docs/research-sources.md, ADR 0007). Auth is a
    // static Basic-auth-shaped header, not a token exchange: Authorization:
    // Basic base64(clientid:clientsecret), ISO-8859-1 encoded.
    apiBaseUrl: process.env.QQ_API_BASE_URL || 'https://api.qqcatalyst.com/v1',
    apiClientId: process.env.QQ_API_CLIENT_ID || '',
    apiClientSecret: process.env.QQ_API_CLIENT_SECRET || '',
    // Legacy/generic field kept for the dry-run note-write-back path
    // (src/writeback/qq.js), which has no verified contract yet (ADR 0001).
    apiToken: process.env.QQ_API_TOKEN || '',
    liveWritesApproved: bool(process.env.QQ_LIVE_WRITES_APPROVED, false),

    // Real client index (§4.4: "pull the client list from QQ once and
    // cache it locally"). Left unset, resolve/account.js falls back to the
    // committed synthetic index (src/resolve/index.json) — see ADR 0007.
    clientIndexPath: process.env.QQ_CLIENT_INDEX_PATH || '',
    // A local export file to build that index from — a CSV or JSON dump
    // pulled from QQ Catalyst's client-list report (exact mechanism varies
    // by agency; this repo doesn't assume one, see ADR 0007).
    exportPath: process.env.QQ_EXPORT_PATH || '',
    exportFormat: (process.env.QQ_EXPORT_FORMAT || 'csv').toLowerCase(),
    exportColumns: {
      id: process.env.QQ_EXPORT_COL_ID || 'client_id',
      name: process.env.QQ_EXPORT_COL_NAME || 'client_name',
      zip: process.env.QQ_EXPORT_COL_ZIP || 'zip',
      // One column holding all policy numbers for a client, delimited by
      // QQ_EXPORT_POLICY_DELIMITER — set QQ_EXPORT_COL_POLICIES to the
      // actual column name once you know it (see README "Real QQ client index").
      policies: process.env.QQ_EXPORT_COL_POLICIES || 'policy_numbers',
      policyDelimiter: process.env.QQ_EXPORT_POLICY_DELIMITER || ';'
    }
  },

  review: {
    port: Number(process.env.REVIEW_SERVER_PORT || 8766)
  },

  confidence: {
    auto: Number(process.env.OPS_CONFIDENCE_AUTO || 0.85),
    review: Number(process.env.OPS_CONFIDENCE_REVIEW || 0.55)
  }
};

/** True only when both the mailbox is live AND the agency-approved Anthropic account/retention is confirmed. */
export function llmLiveAllowed() {
  return config.isLive && config.anthropic.liveApproved;
}
