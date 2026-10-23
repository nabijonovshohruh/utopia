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
 * version 3 — adds students.registered: a student's full_name starts as a
 *             Telegram-profile-derived placeholder and becomes authoritative
 *             (for certificates) only once they've explicitly typed it via
 *             the /start registration flow. Purely additive — one nullable-
 *             defaulted column — so unlike v1->v2 this upgrades safely via
 *             ALTER TABLE even on a database with real student data.
 */
export const CURRENT_VERSION = 3;

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
 * and (independently) which generation of columns do the *tables* already
 * have? `hasV2Shape`/`hasV3Shape` can be true before `upToDate` is — e.g.
 * right after schema.sql's CREATE TABLE IF NOT EXISTS has just built a
 * brand-new database, which is already fully current-shaped but hasn't had
 * its version row written yet.
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
    hasV2Shape: hasColumn(db, 'items', 'label'),
    hasV3Shape: hasColumn(db, 'students', 'registered'),
  };
}

function stamp(db) {
  db.prepare('INSERT OR REPLACE INTO schema_meta (id, version) VALUES (1, ?)').run(CURRENT_VERSION);
}

const V2_TO_V3_ALTER =
  'ALTER TABLE students ADD COLUMN registered INTEGER NOT NULL DEFAULT 0 CHECK (registered IN (0, 1))';

/**
 * Called on every openDb() — including by a running deployment picking up a
 * new release, where nobody necessarily runs `npm run migrate` by hand
 * before the process restarts (e.g. a platform that just redeploys on
 * push). Two cases:
 *
 *   - Fully current-shaped but unstamped (every brand-new database, since
 *     schema.sql creates it that way from scratch): stamp it, free.
 *   - v2-shaped but missing v3's one additive column: apply the same
 *     ALTER TABLE migrate() uses. This is deliberately NOT treated the same
 *     as the v1 case below — it's proven safe at any data volume (see
 *     migrate()'s 'altered' path and test/migrations.test.js), so silently
 *     crash-looping a live deployment until a human remembers to run the
 *     migration script by hand would be strictly worse than just applying
 *     it here.
 *
 * A v1-shaped (or older) database is the one case left untouched: that
 * upgrade is destructive (see migrate()) and only safe to run when there's
 * zero real data, which is exactly the kind of judgement call that belongs
 * in an explicit, operator-run step — not something to silently decide on
 * every boot. That case still throws SchemaOutOfDate.
 */
export function ensureSchemaUpToDate(db) {
  const info = inspectSchema(db);
  if (info.upToDate) return info;
  if (info.hasV2Shape && info.hasV3Shape) {
    stamp(db);
    return { ...info, version: CURRENT_VERSION, upToDate: true };
  }
  if (info.hasV2Shape) {
    db.exec(V2_TO_V3_ALTER);
    stamp(db);
    return { ...info, hasV3Shape: true, version: CURRENT_VERSION, upToDate: true };
  }
  throw new SchemaOutOfDate();
}

/**
 * The explicit, operator-run upgrade (`npm run migrate`).
 *
 * Two upgrade paths, chosen by what the database already has:
 *   - v2 -> v3 is a single additive column (students.registered) — applied
 *     via ALTER TABLE regardless of how much real data exists. Nothing is
 *     dropped or rewritten.
 *   - v1 -> v2 changed CHECK/NOT NULL constraints on existing columns,
 *     which ALTER TABLE can't do; that jump still requires the destructive
 *     rebuild below, and still only runs when there is zero real data.
 */
export function migrate(db) {
  const info = inspectSchema(db);
  if (info.upToDate) return { action: 'none', version: CURRENT_VERSION };

  if (info.hasV2Shape && info.hasV3Shape) {
    stamp(db);
    return { action: 'stamped', version: CURRENT_VERSION };
  }

  if (info.hasV2Shape) {
    db.exec(V2_TO_V3_ALTER);
    stamp(db);
    return { action: 'altered', version: CURRENT_VERSION };
  }

  const counts = {
    submissions: db.prepare('SELECT COUNT(*) c FROM submissions').get().c,
    results: db.prepare('SELECT COUNT(*) c FROM results').get().c,
  };
  if (counts.submissions > 0 || counts.results > 0) {
    throw new MigrationBlocked(counts);
  }

  // Empty of real data: safe to drop the old-shaped tables and recreate them
  // from the current schema (already v3-shaped — schema.sql IS the current
  // target). foreign_keys must be toggled OUTSIDE the transaction (SQLite
  // no-ops the pragma while a transaction is open), so OFF goes here, and
  // schema.sql's own embedded "PRAGMA foreign_keys = ON" is harmlessly
  // ignored while BEGIN...COMMIT is active; ON is restored for real in the
  // `finally` below once the transaction has closed.
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
