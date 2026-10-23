import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { migrate, inspectSchema, ensureSchemaUpToDate, MigrationBlocked, SchemaOutOfDate, CURRENT_VERSION } from '../src/db/migrations.js';
import { openDb, openDbUnchecked } from '../src/db/index.js';

const OLD_SCHEMA = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE students (id INTEGER PRIMARY KEY, telegram_id INTEGER NOT NULL UNIQUE, username TEXT, full_name TEXT, active_test_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE tests (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', scale_intercept REAL NOT NULL DEFAULT 500, scale_slope REAL NOT NULL DEFAULT 50, scale_min INTEGER NOT NULL DEFAULT 200, scale_max INTEGER NOT NULL DEFAULT 800, scale_version INTEGER NOT NULL DEFAULT 1, anchor_checksum TEXT, anchor_source TEXT, auto_grade INTEGER NOT NULL DEFAULT 1, locked_at TEXT, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE items (id INTEGER PRIMARY KEY, test_id INTEGER NOT NULL, position INTEGER NOT NULL, answer_key TEXT NOT NULL, b_logit REAL, anchored INTEGER NOT NULL DEFAULT 0, UNIQUE(test_id,position));
  CREATE TABLE grade_bands (id INTEGER PRIMARY KEY, test_id INTEGER NOT NULL, label TEXT NOT NULL, min_scaled INTEGER NOT NULL, UNIQUE(test_id,label));
  CREATE TABLE submissions (id INTEGER PRIMARY KEY, test_id INTEGER NOT NULL, student_id INTEGER NOT NULL, raw_input TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'submitted', submitted_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE responses (id INTEGER PRIMARY KEY, submission_id INTEGER NOT NULL, item_id INTEGER NOT NULL, given TEXT, correct INTEGER NOT NULL, UNIQUE(submission_id,item_id));
  CREATE TABLE results (id INTEGER PRIMARY KEY, submission_id INTEGER NOT NULL UNIQUE, raw_score INTEGER NOT NULL, item_count INTEGER NOT NULL, theta REAL NOT NULL, se REAL NOT NULL, scaled_score INTEGER NOT NULL, grade TEXT NOT NULL, scale_version INTEGER NOT NULL, anchor_checksum TEXT NOT NULL, method TEXT NOT NULL, engine_version TEXT NOT NULL, verified_by INTEGER, scored_at TEXT NOT NULL DEFAULT (datetime('now')));
`;

function oldShapedDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(OLD_SCHEMA);
  return db;
}

test('a brand-new database is already v2-shaped, just needs stamping', () => {
  const db = openDbUnchecked(':memory:');
  assert.deepEqual(inspectSchema(db), { version: 0, upToDate: false, currentShape: true });

  const result = migrate(db);
  assert.deepEqual(result, { action: 'stamped', version: CURRENT_VERSION });
  assert.equal(inspectSchema(db).upToDate, true);
  db.close();
});

test('migrate is idempotent once stamped', () => {
  const db = openDbUnchecked(':memory:');
  migrate(db);
  assert.deepEqual(migrate(db), { action: 'none', version: CURRENT_VERSION });
  db.close();
});

test('openDb() auto-stamps a fresh database without needing migrate', () => {
  const db = openDb(':memory:'); // throws if this were stale; must not be
  assert.equal(inspectSchema(db).upToDate, true);
  db.close();
});

test('an empty old-shaped database is safely rebuilt', () => {
  const db = oldShapedDb();
  assert.deepEqual(inspectSchema(db), { version: 0, upToDate: false, currentShape: false });

  const result = migrate(db);
  assert.equal(result.action, 'rebuilt');
  assert.equal(result.version, CURRENT_VERSION);
  assert.deepEqual(result.discarded, { submissions: 0, results: 0 });

  const info = inspectSchema(db);
  assert.equal(info.upToDate, true);
  assert.equal(info.currentShape, true);

  // The rebuilt table actually accepts a written item now (nullable answer_key).
  db.prepare(
    "INSERT INTO tests (code, title) VALUES ('X', 'Y')",
  ).run();
  const testId = db.prepare("SELECT id FROM tests WHERE code='X'").get().id;
  assert.doesNotThrow(() =>
    db
      .prepare(
        `INSERT INTO items (test_id, position, label, item_type, parent_question, sub_label)
         VALUES (?, 36, '36a', 'written', 36, 'a')`,
      )
      .run(testId),
  );
  db.close();
});

test('migrate refuses to touch an old-shaped database with real submissions', () => {
  const db = oldShapedDb();
  db.prepare("INSERT INTO students (telegram_id, full_name) VALUES (1, 'S')").run();
  db.prepare("INSERT INTO tests (code, title) VALUES ('X', 'Y')").run();
  db.prepare(
    "INSERT INTO items (test_id, position, answer_key) VALUES (1, 1, 'A')",
  ).run();
  db.prepare(
    "INSERT INTO submissions (test_id, student_id, raw_input) VALUES (1, 1, 'A')",
  ).run();

  assert.throws(() => migrate(db), MigrationBlocked);
  // Nothing was touched: the old table still has its one submission.
  assert.equal(db.prepare('SELECT COUNT(*) c FROM submissions').get().c, 1);
  assert.equal(inspectSchema(db).currentShape, false);
  db.close();
});

test('migrate refuses to touch an old-shaped database with real results', () => {
  const db = oldShapedDb();
  db.prepare(
    `INSERT INTO results (submission_id, raw_score, item_count, theta, se, scaled_score, grade,
                          scale_version, anchor_checksum, method, engine_version)
     VALUES (1, 1, 1, 0, 0.5, 500, 'C', 1, 'abc', 'wle', 'v1')`,
  ).run();

  assert.throws(() => migrate(db), MigrationBlocked);
  try {
    migrate(db);
    assert.fail('expected migrate to throw');
  } catch (err) {
    assert.equal(err.counts.results, 1);
  }
  db.close();
});

test('ensureSchemaUpToDate throws SchemaOutOfDate for a stale on-disk database without touching it', () => {
  const dbPath = path.join(os.tmpdir(), `nc55-migration-test-${Date.now()}.sqlite`);
  try {
    const raw = new DatabaseSync(dbPath);
    raw.exec(OLD_SCHEMA);
    raw.close();

    assert.throws(() => openDb(dbPath), SchemaOutOfDate);

    // Confirm it really is untouched — still old-shaped, openable directly.
    const check = new DatabaseSync(dbPath);
    assert.equal(inspectSchema(check).currentShape, false);
    check.close();
  } finally {
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  }
});

test('ensureSchemaUpToDate is silent for an already-current on-disk database', () => {
  const dbPath = path.join(os.tmpdir(), `nc55-migration-test-ok-${Date.now()}.sqlite`);
  try {
    const db1 = openDb(dbPath);
    db1.close();
    assert.doesNotThrow(() => {
      const db2 = openDb(dbPath);
      db2.close();
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  }
});
