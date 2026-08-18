/**
 * 🗄️ SQLite connection + schema bootstrap.
 *
 * Single shared connection. better-sqlite3 is synchronous, which is exactly
 * what we want for an ingest server: batches arrive as one HTTP request and are
 * written inside one transaction, so there is no concurrency to interleave.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, SERVER_ROOT } from '../config/env.js';
import { createLogger, EMOJI } from '../core/logger.js';

const log = createLogger('db');
const HERE = path.dirname(fileURLToPath(import.meta.url));

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  fs.mkdirSync(path.dirname(env.db.path), { recursive: true });

  db = new Database(env.db.path);
  log.event(EMOJI.db, 'info', 'opened', { path: env.db.path });

  if (env.db.wal) {
    db.pragma('journal_mode = WAL');
    log.event(EMOJI.db, 'debug', 'journal mode set', { mode: 'WAL' });
  }
  // NORMAL is the right trade-off with WAL: durable across app crashes, only at
  // risk on OS-level power loss, and dramatically faster for bulk inserts.
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('temp_store = MEMORY');

  applySchema(db);
  return db;
}

/**
 * `tsc` does not copy .sql files into dist/, so a compiled build has to reach
 * back into src/. Try the co-located copy first (tsx / dev), then the source
 * tree (compiled build).
 */
function findSchemaFile(): string {
  const candidates = [
    path.join(HERE, 'schema.sql'),
    path.join(SERVER_ROOT, 'src', 'db', 'schema.sql'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(`schema.sql not found. Looked in:\n  ${candidates.join('\n  ')}`);
  }
  return found;
}

function applySchema(database: Database.Database): void {
  const schemaPath = findSchemaFile();
  const sql = fs.readFileSync(schemaPath, 'utf8');
  database.exec(sql);
  migrate(database);

  const tables = database
    .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .get() as { n: number };

  log.event(EMOJI.db, 'info', 'schema applied', { tables: tables.n });
}

/**
 * Additive column migrations.
 *
 * schema.sql uses `CREATE TABLE IF NOT EXISTS`, so a column added to it never
 * reaches a database that already exists. Rather than making you delete the DB
 * on every schema tweak, new columns go in this list and are ALTERed in on
 * boot. Only additive changes belong here — anything that rewrites or drops
 * data needs a real migration.
 */
function migrate(database: Database.Database): void {
  const ADDITIONS: Array<[table: string, column: string, definition: string]> = [
    ['channels', 'backfill_horizon', 'TEXT'],
    ['roles', 'subnet_uid', 'INTEGER'],
  ];

  for (const [table, column, definition] of ADDITIONS) {
    const existing = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (existing.some((c) => c.name === column)) continue;

    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    log.event(EMOJI.db, 'info', 'migration: column added', { table, column });
  }
}

/**
 * Prepared-statement cache.
 *
 * better-sqlite3 does NOT cache statements, and the ingest path runs the same
 * handful of INSERTs millions of times. Re-preparing each one per row is pure
 * waste, so every repository goes through here instead of calling
 * `db.prepare()` inline.
 */
const statementCache = new Map<string, Database.Statement>();

export function prepare(sql: string): Database.Statement {
  let stmt = statementCache.get(sql);
  if (!stmt) {
    stmt = getDb().prepare(sql);
    statementCache.set(sql, stmt);
  }
  return stmt;
}

/** Wrap a function in a transaction. Rolls back automatically if it throws. */
export function transaction<T>(fn: () => T): T {
  return getDb().transaction(fn)();
}

export function closeDb(): void {
  if (!db) return;
  statementCache.clear(); // statements are bound to the connection
  db.close();
  db = null;
  log.event(EMOJI.db, 'info', 'closed');
}

/** Convert a boolean to SQLite's 0/1. Used everywhere in the repositories. */
export const bit = (v: unknown): 0 | 1 => (v ? 1 : 0);
