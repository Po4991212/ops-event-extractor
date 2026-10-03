'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Opens the database and applies pending migrations. Re-running is safe:
 * applied migrations are recorded by filename and skipped.
 *
 * Destructive migrations are not treated as reversible. There is no "down"
 * path here; recovery is restore-from-backup, documented in docs/OPERATOR.md.
 */
function open(dbPath, { readonly = false } = {}) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { readonly });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL, sha256 TEXT NOT NULL)`);
  const applied = new Set(db.prepare('SELECT filename FROM schema_migrations').all().map((r) => r.filename));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const { sha256 } = require('../core/hash');
  const ran = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (filename, applied_at, sha256) VALUES (?,?,?)')
        .run(f, new Date().toISOString(), sha256(sql));
    });
    tx();
    ran.push(f);
  }
  return { applied: ran, total: files.length };
}

function initialized(dbPath, cfg) {
  const db = open(dbPath);
  migrate(db);
  return db;
}

/** Append-only audit entry. Callers never update or delete audit rows. */
function audit(db, { actor, action, subjectType = null, subjectId = null, detail = null, at }) {
  db.prepare('INSERT INTO audit_log (at, actor, action, subject_type, subject_id, detail_json) VALUES (?,?,?,?,?,?)')
    .run(at || new Date().toISOString(), actor, action, subjectType, subjectId,
      detail === null ? null : JSON.stringify(detail));
}

/** Wrap a unit of work in a transaction. */
function tx(db, fn) { return db.transaction(fn)(); }

module.exports = { open, migrate, initialized, audit, tx, MIGRATIONS_DIR };
