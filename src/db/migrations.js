import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');

/**
 * version 1 — the original schema (students/tests/items/.../results, mcq-only).
 * version 2 — adds the 55-item National Certificate template support:
 *             items.label/item_type/option_count/parent_question/sub_label/
 *             max_score, nullable items.answer_key, nullable
 *             responses.correct (+graded_by/graded_at), tests.template,
 *             submissions.source.
 */
export const CURRENT_VERSION = 2;

export class SchemaOutOfDate extends Error {
  constructor() {
    super(
      'Database schema is out of date (missing 55-item template support). Run: npm run migrate',
    );
  }
}

export class MigrationBlocked extends Error {
  constructor(counts) {
    super(
      `Refusing to auto-migrate: the database already has real data under the pre-expansion ` +
        `schema (${counts.submissions} submission(s), ${counts.results} result(s)). This tool ` +
        `only auto-upgrades an empty/demo-only database — back this one up and migrate the data ` +
        'by hand (export results, recreate items with the new columns, re-import).',
    );
    this.counts = counts;
  }
}

function hasColumn(db, table, column) {
  return Boolean(db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(table, column));
}

/**
 * Cheap, read-only check: is this connection's schema at CURRENT_VERSION,
 * and (independently) do the *tables* already have the v2 columns?
 * `currentShape` can be true before `upToDate` is — e.g. right after
 * schema.sql's CREATE TABLE IF NOT EXISTS has just built a brand-new
 * database, which is already v2-shaped but hasn't had its version row
 * written yet.
 */
export function inspectSchema(db) {
  // A database old enough to predate this migration system entirely won't
  // have schema_meta at all yet (only schema.sql's own CREATE TABLE IF NOT
  // EXISTS adds it, and that's additive-only against existing tables).
  const hasMetaTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_meta'")
    .get();
  const metaRow = hasMetaTable ? db.prepare('SELECT version FROM schema_meta WHERE id = 1').get() : null;
  return {
    version: metaRow?.version ?? 0,
    upToDate: metaRow?.version === CURRENT_VERSION,
    currentShape: hasColumn(db, 'items', 'label'),
  };
}

function stamp(db) {
  db.prepare('INSERT OR REPLACE INTO schema_meta (id, version) VALUES (1, ?)').run(CURRENT_VERSION);
}

/**
 * Called on every openDb(). Free and non-destructive: if the tables are
 * already v2-shaped (true for every brand-new database, since schema.sql
 * creates them that way from scratch) but just haven't been stamped yet,
 * stamp them. Otherwise leave a stale on-disk database untouched and throw
 * SchemaOutOfDate — fail loudly and immediately at boot rather than letting
 * the process start and fail confusingly on the first query that touches a
 * column which doesn't exist yet.
 */
export function ensureSchemaUpToDate(db) {
  const info = inspectSchema(db);
  if (info.upToDate) return info;
  if (info.currentShape) {
    stamp(db);
    return { ...info, version: CURRENT_VERSION, upToDate: true };
  }
  throw new SchemaOutOfDate();
}

/**
 * The explicit, operator-run upgrade (`npm run migrate`). Only path that
 * may destructively rebuild tables, and only when there is zero real data
 * to lose.
 */
export function migrate(db) {
  const info = inspectSchema(db);
  if (info.upToDate) return { action: 'none', version: CURRENT_VERSION };
  if (info.currentShape) {
    stamp(db);
    return { action: 'stamped', version: CURRENT_VERSION };
  }

  const counts = {
    submissions: db.prepare('SELECT COUNT(*) c FROM submissions').get().c,
    results: db.prepare('SELECT COUNT(*) c FROM results').get().c,
  };
  if (counts.submissions > 0 || counts.results > 0) {
    throw new MigrationBlocked(counts);
  }

  // Empty of real data: safe to drop the old-shaped tables and recreate them
  // from the current schema. foreign_keys must be toggled OUTSIDE the
  // transaction (SQLite no-ops the pragma while a transaction is open), so
  // OFF goes here, and schema.sql's own embedded "PRAGMA foreign_keys = ON"
  // is harmlessly ignored while BEGIN...COMMIT is active; ON is restored
  // for real in the `finally` below once the transaction has closed.
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    for (const table of ['results', 'responses', 'submissions', 'grade_bands', 'items', 'tests', 'students']) {
      db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    db.exec(SCHEMA_SQL);
    stamp(db);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }

  return { action: 'rebuilt', version: CURRENT_VERSION, discarded: counts };
}
