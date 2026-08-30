import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';

let _db = null;

function openDb(dbPath = config.dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const database = new Database(dbPath);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  return database;
}

/** Applies schema.sql (idempotent: every statement is CREATE ... IF NOT EXISTS) and records it. */
export function migrate(database = db()) {
  const schemaPath = path.join(config.root, 'src', 'db', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  database.exec(sql);
  const already = database.prepare('SELECT 1 FROM schema_migrations WHERE version = 1').get();
  if (!already) {
    database.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (1, ?, ?)')
      .run('initial_schema', Date.now());
  }
  return database;
}

/** Lazily opens the singleton connection. Tests pass their own path via openDb(). */
export function db() {
  if (!_db) _db = openDb();
  return _db;
}

export function closeDb() {
  if (_db) { _db.close(); _db = null; }
}

export { openDb };
