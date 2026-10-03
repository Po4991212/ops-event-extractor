'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DataModeError } = require('../core/errors');
const { SLA, MISSING_SLA_KINDS, EVENT_KINDS, validateSla } = require('./sla');

const ROOT = path.resolve(__dirname, '..', '..');

function readJsonIfExists(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function envFlag(name, fallback = false) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v === '1' || v.toLowerCase() === 'true';
}

/**
 * Loads configuration. Three independent enablements exist and none of them
 * implies another:
 *   dataMode=live               -> may read real mailboxes
 *   modelMode=astra             -> may transmit content to the model provider
 *   externalWritesApproved + --live -> may perform additive external writes
 */
function load(overrides = {}) {
  const mailboxCfg = readJsonIfExists(path.join(ROOT, 'config', 'mailboxes.json'))
    || readJsonIfExists(path.join(ROOT, 'config', 'mailboxes.example.json'))
    || { mailboxes: [] };
  const holidays = readJsonIfExists(path.join(ROOT, 'config', 'holidays.json')) || { dates: [] };

  const cfg = {
    root: ROOT,
    timezone: process.env.OPS_TIMEZONE || mailboxCfg.timezone || 'America/Chicago',
    dbPath: path.resolve(ROOT, process.env.OPS_DB_PATH || 'var/ops.sqlite'),
    rawStore: path.resolve(ROOT, process.env.OPS_RAW_STORE || 'var/raw'),
    reviewPort: Number(process.env.OPS_REVIEW_PORT || 8766),

    dataMode: (process.env.OPS_DATA_MODE || 'synthetic').toLowerCase(),
    externalWritesApproved: envFlag('OPS_EXTERNAL_WRITES_APPROVED', false),

    model: {
      mode: (process.env.OPS_MODEL_MODE || 'stub').toLowerCase(), // stub | astra
      name: process.env.OPS_MODEL_NAME || 'gpt-6-astra',
      // Empty means: no immutable snapshot pinned. Recorded as a limitation,
      // never filled with an invented snapshot string.
      snapshot: process.env.OPS_MODEL_SNAPSHOT || '',
      baseUrl: process.env.OPS_OPENAI_BASE_URL || 'https://api.openai.com/v1',
      effortClassify: process.env.OPS_REASONING_EFFORT_CLASSIFY || 'low',
      effortExtract: process.env.OPS_REASONING_EFFORT_EXTRACT || 'medium',
      promptVersion: 'extract-prompt-v1',
      schemaVersion: 'event-schema-v1',
    },

    mailboxes: (mailboxCfg.mailboxes || []).map((m) => ({
      id: m.id,
      address: m.address,
      label: m.label,
      configured: Boolean(m.configured && m.address),
    })),

    holidays: new Set(holidays.dates || []),
    holidaySource: holidays.source || 'unknown',

    sla: SLA,
    missingSlaKinds: MISSING_SLA_KINDS,
    eventKinds: EVENT_KINDS,

    // Confidence thresholds. Initial project values to evaluate - not proven
    // probabilities and not a guarantee of accuracy.
    thresholds: { auto: 0.85, review: 0.55 },

    // Learned patterns (src/extract/learned/patterns.js). A pattern needs this
    // many agreements with the model, and none against, before a person may
    // approve it. Once approved, every Nth use is still re-read by the model so
    // a carrier changing its template is caught. Starting values, not tuned.
    learnedPatterns: {
      enabled: envFlag('OPS_LEARNED_PATTERNS', true),
      agreementsToReady: Number(process.env.OPS_LEARNED_AGREEMENTS || 3),
      spotCheckEvery: Number(process.env.OPS_LEARNED_SPOT_CHECK_EVERY || 10),
    },

    ...overrides,
  };

  const slaProblems = validateSla(cfg.sla);
  if (slaProblems.length) throw new Error(`SLA configuration invalid:\n  ${slaProblems.join('\n  ')}`);

  return cfg;
}

/** Live mailbox access fails closed unless explicitly enabled. */
function assertLiveDataAllowed(cfg) {
  if (cfg.dataMode !== 'live') {
    throw new DataModeError(
      'Live mailbox access requires OPS_DATA_MODE=live. Refusing to read real mail in synthetic mode.',
      'DATA_MODE_NOT_LIVE',
    );
  }
}

/** Transmitting content to the model provider is a separate enablement. */
function assertModelTransmissionAllowed(cfg) {
  if (cfg.model.mode !== 'astra') {
    throw new DataModeError(
      'Model transmission requires OPS_MODEL_MODE=astra plus an agency-approved API account and a documented data-handling arrangement.',
      'MODEL_MODE_NOT_LIVE',
    );
  }
}

function unconfiguredMailboxes(cfg) {
  return cfg.mailboxes.filter((m) => !m.configured);
}

module.exports = { load, assertLiveDataAllowed, assertModelTransmissionAllowed, unconfiguredMailboxes, ROOT };
