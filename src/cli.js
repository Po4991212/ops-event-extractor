#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { config } from './config.js';
import { db, migrate } from './db/index.js';
import { allMessagesOrderedByDate, insertGroundTruth, insertMessage, openTasks } from './db/queries.js';
import { normalizeBody } from './normalize/text.js';
import { contentHash } from './dedup/hash.js';
import { parseDailyTasks } from './parsers/dailytasks.js';
import { processMessage } from './events/store.js';
import { replay as runReplay } from './eval/replay.js';
import { pushTask } from './writeback/qq.js';
import { writeDraft } from './writeback/nudges.js';

const program = new Command();
program.name('ops-event-extractor').description('Ops Event Extractor CLI').version('0.1.0');

program.command('migrate').description('Apply the SQLite schema (idempotent).').action(() => {
  migrate(db());
  console.log(`Migrated ${config.dbPath}`);
});

program.command('seed-synthetic')
  .description('Loads data/synthetic/messages.json into the database (source="synthetic").')
  .action(() => {
    const database = migrate(db());
    const file = JSON.parse(fs.readFileSync(path.join(config.syntheticDir, 'messages.json'), 'utf8'));
    let n = 0;
    for (const m of file.messages) {
      const { body_full, body_text } = normalizeBody(m.body_raw);
      const fromMatch = /@([^\s>]+)/.exec(m.from_addr || '');
      const record = {
        id: m.id,
        thread_id: m.thread_id,
        history_id: null,
        internal_date: Date.parse(m.internal_date),
        from_addr: m.from_addr,
        from_domain: fromMatch ? fromMatch[1].toLowerCase() : '',
        to_addrs: '["commercialtx@aiinsure-example.com"]',
        cc_addrs: '[]',
        subject: m.subject,
        label_ids: '["INBOX"]',
        body_text,
        body_full,
        attachment_names: '[]',
        source: 'synthetic',
        fetched_at: Date.now()
      };
      record.content_hash = contentHash(record);
      const res = insertMessage(database, record);
      if (res.changes) n++;
    }
    console.log(`Seeded ${n} synthetic messages (of ${file.messages.length} in the fixture file).`);
  });

program.command('gmail-auth')
  .description('One-time interactive setup: obtains a Gmail OAuth refresh token and saves it to GMAIL_TOKEN_STORE_PATH. Run this once before `sync`.')
  .action(async () => {
    const { runOAuthSetup, SCOPES } = await import('./gmail/auth.js');
    await runOAuthSetup({ scopes: [SCOPES.readonly] });
  });

program.command('sync')
  .description('Syncs the live Gmail mailbox. Requires OPS_MODE=live and configured OAuth credentials.')
  .option('--full', 'force a full sync')
  .action(async (opts) => {
    if (!config.isLive) {
      console.error('sync requires OPS_MODE=live in .env. In synthetic mode, use `seed-synthetic` instead.');
      process.exitCode = 1;
      return;
    }
    const { loadAuthClient } = await import('./gmail/auth.js');
    const { fullSync, incrementalSync } = await import('./gmail/sync.js');
    const database = migrate(db());
    const auth = loadAuthClient();
    const n = opts.full ? await fullSync(auth, database) : await incrementalSync(auth, database);
    console.log(`Synced ${n} new messages.`);
  });

program.command('parse-daily-tasks')
  .description('Extracts ground-truth rows from daily-task-summary messages and prints CSV to stdout.')
  .option('--write-db', 'also insert rows into the ground_truth table')
  .action((opts) => {
    const database = migrate(db());
    const messages = allMessagesOrderedByDate(database);
    const rows = messages.flatMap(m => parseDailyTasks(m));
    if (opts.writeDb) for (const r of rows) insertGroundTruth(database, r);

    const header = 'source_msg_id,section,account_name_raw,kind,due_date,obligation';
    const csvRow = (r) => [r.source_msg_id, r.section, r.account_name_raw, r.kind, r.due_date ?? '', r.obligation]
      .map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',');
    console.log([header, ...rows.map(csvRow)].join('\n'));
    console.error(`(${rows.length} rows${opts.writeDb ? ', written to ground_truth' : ', not written — pass --write-db'})`);
  });

program.command('run')
  .description('Runs every stored message through routing → extraction → resolution → scoring → tasks.')
  .option('--llm', 'allow the LLM tier to run (costs real tokens whenever ANTHROPIC_API_KEY is set — see README "Does this cost tokens"). Off by default.')
  .action(async (opts) => {
    const database = migrate(db());
    const messages = allMessagesOrderedByDate(database);
    let events = 0, autoCount = 0, queued = 0;
    for (const msg of messages) {
      const result = await processMessage(database, msg, { allowLlm: !!opts.llm });
      events += result.events.length;
      autoCount += result.events.filter(e => e.status === 'auto').length;
      queued += result.events.filter(e => e.status === 'queued').length;
    }
    console.log(`Processed ${messages.length} messages → ${events} events (${autoCount} auto, ${queued} queued for review).`);
    if (!opts.llm) console.log('(LLM tier skipped — no tokens spent. Pass --llm to also run classification/extraction on unmatched mail.)');
  });

program.command('replay')
  .description('§7.3: as-of-mode replay + §7.2 metrics against ground_truth.')
  .option('--from <date>', 'ISO date, inclusive')
  .option('--to <date>', 'ISO date, inclusive')
  .option('--as-of-mode', 'accepted for compatibility with docs/SPEC.md §7.3; this is the only mode replay runs in')
  .option('--llm', 'allow the LLM tier to run (costs real tokens whenever ANTHROPIC_API_KEY is set). Off by default.')
  .action(async (opts) => {
    const database = migrate(db());
    const result = await runReplay(database, { from: opts.from, to: opts.to, allowLlm: !!opts.llm });
    console.log(JSON.stringify(result, null, 2));
    if (!opts.llm) console.error('(LLM tier skipped — no tokens spent. Pass --llm to include it.)');
  });

program.command('export-tasks')
  .description('§6.3 CSV export of open tasks — the interim surface until QQ write-back has a verified live contract.')
  .action(() => {
    const database = migrate(db());
    const tasks = openTasks(database);
    const header = 'event_key,kind,account_name_raw,account_id,due_date,sla_first_action,sla_escalate,sla_critical,confidence,obligation';
    const csvRow = (t) => [t.event_key, t.kind, t.account_name_raw, t.account_id, t.due_date ?? '', t.sla_first_action ?? '', t.sla_escalate ?? '', t.sla_critical ?? '', t.confidence, t.obligation]
      .map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',');
    console.log([header, ...tasks.map(csvRow)].join('\n'));
  });

program.command('qq-push-dry-run')
  .description('Demonstrates the QQ write-back dry-run path (§6.3) for every open task.')
  .action(async () => {
    const database = migrate(db());
    for (const t of openTasks(database)) {
      const res = await pushTask({ ...t, account_id: t.account_id }, { live: config.isLive });
      console.log(JSON.stringify(res));
    }
  });

program.command('nudge-drafts')
  .description('Prints both nudge draft variants (§6.2) for every open task. Never sends anything.')
  .action(async () => {
    const database = migrate(db());
    for (const t of openTasks(database)) {
      const res = await writeDraft(t, { live: false });
      console.log(`\n=== ${res.drafts.subject} ===\n--- recommendation ---\n${res.drafts.recommendation}\n--- neutral ---\n${res.drafts.neutral}`);
    }
  });

program.command('refresh-client-index')
  .description('Rebuilds the real client index from QQ Catalyst (§4.4) — writes to QQ_CLIENT_INDEX_PATH, never to src/resolve/index.json.')
  .option('--from-csv', 'import from QQ_EXPORT_PATH (a CSV export) instead of the live API')
  .option('--since <date>', 'ISO start date for the API pull (required unless --from-csv)')
  .action(async (opts) => {
    const { importFromCsvFile, importFromQQApi } = await import('./resolve/importClientIndex.js');
    const outPath = opts.fromCsv
      ? importFromCsvFile()
      : await importFromQQApi({ since: opts.since });
    console.log(`Wrote client index to ${outPath}`);
  });

program.parseAsync(process.argv);
