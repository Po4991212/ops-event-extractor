#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./config');
const { open, migrate } = require('./db/db');
const { makeClock } = require('./core/clock');
const { make: makeLogger } = require('./core/logger');

/**
 * Every command below exists. Nothing is listed here or in the README that has
 * not been run.
 *
 * Commands that would change something outside this process take --live, and
 * --live on its own is not enough: OPS_EXTERNAL_WRITES_APPROVED=1 must also be
 * set. Without both, the command builds the identical payload and shows it
 * instead of sending it.
 */
function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      out.flags[k] = v === undefined ? true : v;
    } else out._.push(a);
  }
  return out;
}

function ctx(flags) {
  // Only pass overrides that were actually supplied; handing load() an
  // undefined value would overwrite a perfectly good default with nothing.
  const overrides = {};
  if (flags.db) overrides.dbPath = flags.db;
  if (flags.mode) overrides.dataMode = flags.mode;
  const cfg = load(overrides);
  const db = open(cfg.dbPath);
  const clock = makeClock(cfg.timezone, flags.now);
  const log = makeLogger({ level: flags.verbose ? 'debug' : 'info' });
  return { cfg, db, clock, log };
}

const COMMANDS = {
  async init(flags) {
    const { cfg, db } = ctx(flags);
    const applied = migrate(db);
    console.log(`database ready at ${cfg.dbPath}`);
    console.log(`migrations applied: ${applied.applied.length ? applied.applied.join(', ') : 'none (already current)'}`);
    const unconfigured = require('./config').unconfiguredMailboxes(cfg);
    if (unconfigured.length) {
      console.log(`\n${unconfigured.length} mailbox(es) are placeholders and will be skipped:`);
      for (const m of unconfigured) console.log(`  ${m.id} - ${m.note || 'address not supplied'}`);
      console.log('Fill them in config/mailboxes.json before the live run.');
    }
  },

  async 'seed-synthetic'(flags) {
    const { cfg, db, clock } = ctx(flags);
    migrate(db);
    const { seedReferenceData, seedMessages } = require('./eval/corpus');
    const ref = seedReferenceData(db, clock);
    const msgs = seedMessages(db, cfg, clock, { upTo: flags.upTo || null });
    console.log(`seeded ${ref.accounts} accounts, ${ref.policies} policies, ${ref.activity} AMS activity rows`);
    console.log(`seeded ${msgs.stored} synthetic messages`);
  },

  async 'sync-gmail'(flags) {
    const { cfg, db, clock, log } = ctx(flags);
    migrate(db);
    require('./config').assertLiveDataAllowed(cfg);
    const { syncMailbox } = require('./ingest/sync');
    const { GmailHttpTransport } = require('./ingest/gmail-client');
    const transport = new GmailHttpTransport(cfg);
    let total = 0;
    for (const mb of cfg.mailboxes.filter((m) => m.configured)) {
      const r = await syncMailbox(db, cfg, clock, transport, mb, { log });
      console.log(`${mb.id}: ${r.stored} stored, ${r.skipped} already present, mode ${r.mode}`);
      total += r.stored;
    }
    console.log(`total new messages: ${total}`);
  },

  async process(flags) {
    const { cfg, db, clock, log } = ctx(flags);
    migrate(db);
    const { processAll } = require('./extract/pipeline');
    const opts = { log };
    if (!flags['parsers-only']) {
      opts.modelExtractor = require('./extract/model/extractor').makeExtractor(db, cfg, clock);
    }
    const s = await processAll(db, cfg, clock, opts);
    console.log(`messages ${s.messages} | events ${s.events} | accepted ${s.accepted} | held ${s.quarantined} `
      + `| tasks ${s.tasks} | deferred ${s.deferred} | noise ${s.noise}`);
    if (s.quarantined) console.log(`${s.quarantined} item(s) held back - review them with: npm run ops -- review`);
  },

  async sweep(flags) {
    const { cfg, db, clock } = ctx(flags);
    migrate(db);
    const { runSweep } = require('./tasks/sweeps');
    const r = runSweep(db, cfg, clock, { name: flags.name || 'default' });
    console.log(`examined ${r.tasksExamined} tasks, fired ${r.fired.length} reminder(s)`);
    for (const f of r.fired.slice(0, 20)) console.log(`  ${f.level} on ${f.task}`);
    if (r.fired.length > 20) console.log(`  ... ${r.fired.length - 20} more`);
  },

  async fulfillment(flags) {
    const { cfg, db, clock } = ctx(flags);
    migrate(db);
    const r = require('./tasks/fulfillment').check(db, cfg, clock);
    console.log(`closed ${r.closed.length} | needs review ${r.candidates.length} | reopened ${r.reopened.length} | rejected ${r.rejected.length}`);
    for (const c of r.candidates) console.log(`  needs a person: ${c.task} - ${c.checks.object.why}; ${c.checks.amount.why}`);
    for (const x of r.reopened) console.log(`  reopened after reversal: ${x.task}`);
  },

  async review(flags) {
    const { cfg, db, clock } = ctx(flags);
    migrate(db);
    const { createServer } = require('./review/server');
    const port = Number(flags.port || cfg.reviewPort);
    const { listen } = createServer(db, cfg, clock, { port });
    listen(() => console.log(`review console on http://127.0.0.1:${port} (loopback only; Ctrl+C to stop)`));
  },

  async replay(flags) {
    const { cfg, db, clock } = ctx(flags);
    migrate(db);
    const { seedReferenceData, seedMessages } = require('./eval/corpus');
    if (flags.fresh) {
      seedReferenceData(db, clock);
      seedMessages(db, cfg, clock);
    }
    const modelExtractor = require('./extract/model/extractor').makeExtractor(db, cfg, clock);
    const r = await require('./eval/replay').replay(db, cfg, { modelExtractor });
    console.log(`replayed ${r.processed} messages in arrival order, advancing the clock to each`);
  },

  async eval(flags) {
    const { cfg, db, clock } = ctx(flags);
    migrate(db);
    const { seedReferenceData, seedMessages, keyToMessageId } = require('./eval/corpus');
    seedReferenceData(db, clock);
    seedMessages(db, cfg, clock);
    const modelExtractor = require('./extract/model/extractor').makeExtractor(db, cfg, clock);
    await require('./eval/replay').replay(db, cfg, { modelExtractor });
    const m = require('./eval/metrics').score(db, keyToMessageId());
    console.log(require('./eval/metrics').format(m));
    if (flags.json) fs.writeFileSync(flags.json, JSON.stringify(m, null, 2));
  },

  async 'export-csv'(flags) {
    const { db } = ctx(flags);
    migrate(db);
    const csv = require('./export/csv').exportTasks(db);
    const out = flags.out || 'out/tasks.csv';
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, csv);
    console.log(`wrote ${out} (${csv.split('\n').length - 2} rows)`);
  },

  async 'qq-dryrun'(flags) {
    const { cfg, db, clock } = ctx(flags);
    migrate(db);
    const { enqueue, dispatch } = require('./writeback/outbox');
    const { buildNote, makeDispatcher } = require('./writeback/qq-adapter');
    const tasks = db.prepare(`SELECT t.*, o.account_id, o.policy_ref, o.obligation_subject, o.stated_deadline,
        (SELECT COUNT(*) FROM source_links s WHERE s.obligation_id = o.id) AS source_count
      FROM tasks t JOIN obligations o ON o.id = t.obligation_id
      WHERE t.status NOT IN ('completed','dismissed') AND o.account_id IS NOT NULL`).all();
    for (const t of tasks) enqueue(db, clock, { kind: 'qq_note', target: t.account_id, taskId: t.id, payload: buildNote(t, t) });
    const r = await dispatch(db, cfg, clock, { live: Boolean(flags.live), dispatcher: makeDispatcher(cfg) });
    console.log(`write mode: ${r.mode.live ? 'LIVE' : 'dry run'} - ${r.mode.reason}`);
    console.log(`queued ${tasks.length} | dry run ${r.dryRun.length} | sent ${r.sent.length} | unknown ${r.unknown.length} | failed ${r.failed.length}`);
    for (const d of r.dryRun.slice(0, 3)) {
      console.log(`\nwould POST to ${d.target}:`);
      console.log(`  ${d.payload.subject}`);
      console.log(d.payload.body.split('\n').map((l) => `  ${l}`).join('\n'));
    }
    if (r.dryRun.length > 3) console.log(`\n... ${r.dryRun.length - 3} more withheld payloads`);
  },

  async 'scan-nosend'(flags) {
    const root = flags.root || process.cwd();
    const r = require('./security/no-send-scan').scan(root);
    console.log(`scanned ${r.files} files in ${r.targets.join(', ')} against policy ${r.policyVersion}`);
    if (!r.findings.length) { console.log('no send capability found'); return; }
    for (const f of r.findings) console.log(`  ${f.file}:${f.line} [${f.patternId}] ${f.why}\n      ${f.context}`);
    process.exitCode = 1;
  },

  async 'check-leakage'(flags) {
    const r = require('./eval/leakage').check(flags.root || process.cwd(), { privateListPath: flags.privateList });
    console.log(`scanned ${r.filesScanned} files`);
    console.log(`private name list: ${r.privateList.reason}`);
    for (const f of r.findings) console.log(`  ${f.file}: ${f.kind} (${f.evidence})`);
    console.log(`verdict: ${r.verdict}`);
    if (r.findings.length) process.exitCode = 1;
  },

  async status(flags) {
    const { cfg, db } = ctx(flags);
    migrate(db);
    const q = (sql) => db.prepare(sql).get().c;
    console.log(`data mode: ${cfg.dataMode} | extraction: ${cfg.model.mode} | timezone: ${cfg.timezone}`);
    console.log(`messages ${q('SELECT COUNT(*) c FROM messages')} | obligations ${q('SELECT COUNT(*) c FROM obligations')}`);
    console.log(`open tasks ${q("SELECT COUNT(*) c FROM tasks WHERE status NOT IN ('completed','dismissed')")} `
      + `| urgent ${q('SELECT COUNT(*) c FROM tasks WHERE urgent = 1')} `
      + `| held ${q('SELECT COUNT(*) c FROM quarantine WHERE triaged_at IS NULL')}`);
    console.log(`escalations fired ${q('SELECT COUNT(*) c FROM task_escalations')} | outbox pending ${q("SELECT COUNT(*) c FROM outbox WHERE status = 'pending'")}`);
    const missing = db.prepare("SELECT kind, COUNT(*) c FROM tasks WHERE missing_sla = 1 GROUP BY kind").all();
    if (missing.length) {
      console.log(`\nkinds with no agreed SLA (surfaced for a person to set):`);
      for (const m of missing) console.log(`  ${m.kind}: ${m.c}`);
    }
  },
};

async function main() {
  const { _, flags } = parseArgs(process.argv.slice(2));
  const cmd = _[0];
  if (!cmd || flags.help || !COMMANDS[cmd]) {
    console.log(`Usage: npm run ops -- <command> [options]

  init                 create or migrate the database
  seed-synthetic       load the synthetic corpus and reference data
  sync-gmail           read mail (requires OPS_DATA_MODE=live and Gmail credentials)
  process              route, parse, extract, gate and schedule
  sweep                fire timers and silence escalations
  fulfillment          match obligations against AMS evidence
  review               start the loopback review console
  replay               reprocess chronologically, advancing the clock
  eval                 replay and score against the labelled corpus
  export-csv           write open tasks to CSV
  qq-dryrun            build AMS notes and show them without sending
  scan-nosend          fail if any send capability appears in the source
  check-leakage        fail if real names or secrets appear in the tree
  status               counts and configuration

Options: --db=PATH --now=ISO --live --parsers-only --port=N --json=PATH --out=PATH --fresh --verbose`);
    process.exitCode = cmd ? 1 : 0;
    return;
  }
  await COMMANDS[cmd](flags);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`${e.code ? `[${e.code}] ` : ''}${e.message}`);
    if (process.env.OPS_DEBUG) console.error(e.stack);
    process.exitCode = 1;
  });
}

module.exports = { COMMANDS, parseArgs };
