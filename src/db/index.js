import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSchemaUpToDate } from './migrations.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Opens the connection and applies the (additive, idempotent) schema, but
 * does NOT check the schema version — used only by migrate.js, which exists
 * specifically to fix a stale version and so must be able to open one
 * without openDb()'s up-to-date check immediately throwing.
 */
export function openDbUnchecked(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  // WAL lets the bot process and the Mini App's HTTP server hold the same
  // on-disk file open concurrently without "database is locked" errors.
  if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
  return db;
}

/**
 * Opens the database for normal use. Safe on every boot: CREATE TABLE/
 * INDEX/TRIGGER IF NOT EXISTS never touches an existing table's columns, so
 * this alone cannot upgrade a database that predates the 55-item template.
 * `ensureSchemaUpToDate` closes that gap without becoming destructive
 * itself — a brand-new database is stamped at the current version for
 * free, while a genuinely stale on-disk database throws immediately with a
 * clear "run npm run migrate" message instead of booting into a
 * half-broken state that only fails later, confusingly, on the first query
 * that touches a column which doesn't exist yet. The actual (possibly
 * destructive) upgrade only ever runs via the explicit `npm run migrate`
 * script — see src/db/migrations.js.
 */
export function openDb(dbPath) {
  const db = openDbUnchecked(dbPath);
  try {
    ensureSchemaUpToDate(db);
  } catch (err) {
    // Don't leak an open handle on a path we're about to tell the caller is
    // broken — on Windows in particular that leaves the file locked for
    // whatever the operator tries next (including `npm run migrate`).
    db.close();
    throw err;
  }
  return db;
}

/** Runs `fn` inside a transaction, rolling back on throw. */
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
