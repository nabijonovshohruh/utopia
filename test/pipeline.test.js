import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import {
  parseAnswerKey,
  upsertDraftTest,
  lockTest,
  getTestByCode,
  getItems,
} from '../src/services/tests.js';
import { recordSubmission, getOrCreateStudent } from '../src/services/submissions.js';
import { scoreSubmission, scoreAllPending, loadAnchors } from '../src/services/scoring.js';

const KEY = [
  'CODE: T1',
  'TITLE: Pipeline Test',
  'SCALE: 500 + 50*theta',
  'GRADES: A>=600, B>=500, C>=400, NC>=0',
  'ITEMS:',
  '1 A -1.5',
  '2 B -0.5',
  '3 C 0.5',
  '4 D 1.5',
].join('\n');

function fixture({ lock = true } = {}) {
  const db = openDb(':memory:');
  upsertDraftTest(db, parseAnswerKey(KEY), 1);
  if (lock) lockTest(db, 'T1');
  return db;
}

function submit(db, telegramId, answers) {
  const test = getTestByCode(db, 'T1');
  const student = getOrCreateStudent(db, { id: telegramId, first_name: `S${telegramId}` });
  return recordSubmission(db, {
    testId: test.id,
    studentId: student.id,
    rawInput: answers.join(''),
    answers,
  });
}

test('end-to-end: upload, lock, submit, score', () => {
  const db = fixture();
  const id = submit(db, 1, ['A', 'B', 'C', 'X']);
  const { scored } = scoreSubmission(db, id);

  assert.equal(scored.rawScore, 3);
  assert.equal(scored.itemCount, 4);
  assert.ok(scored.theta > 0);
  assert.equal(typeof scored.grade, 'string');

  const stored = db.prepare('SELECT * FROM results WHERE submission_id = ?').get(id);
  assert.equal(stored.raw_score, 3);
  assert.equal(stored.scale_version, 1);
  assert.equal(stored.anchor_checksum, getTestByCode(db, 'T1').anchor_checksum);
  assert.equal(db.prepare('SELECT status FROM submissions WHERE id = ?').get(id).status, 'scored');
  db.close();
});

test('a draft test cannot score anyone', () => {
  const db = fixture({ lock: false });
  const id = submit(db, 2, ['A', 'B', 'C', 'D']);
  assert.throws(() => scoreSubmission(db, id), /must be frozen with \/lock/);
  db.close();
});

test('locking is refused while any anchor is missing', () => {
  const db = openDb(':memory:');
  upsertDraftTest(db, parseAnswerKey('CODE: T2\nTITLE: T\nITEMS:\n1 A -1\n2 B\n'), 1);
  assert.throws(() => lockTest(db, 'T2'), /no anchored difficulty/);
  db.close();
});

test('a locked test cannot be re-uploaded', () => {
  const db = fixture();
  assert.throws(() => upsertDraftTest(db, parseAnswerKey(KEY), 1), /locked and its anchors are frozen/);
  db.close();
});

test('the database blocks anchor and scale edits on a locked test', () => {
  const db = fixture();
  const test = getTestByCode(db, 'T1');

  assert.throws(
    () => db.prepare('UPDATE items SET b_logit = 3 WHERE test_id = ?').run(test.id),
    /anchor_locked/,
  );
  assert.throws(
    () => db.prepare('UPDATE items SET answer_key = ? WHERE test_id = ?').run('Z', test.id),
    /anchor_locked/,
  );
  assert.throws(
    () => db.prepare('UPDATE tests SET scale_slope = 99 WHERE id = ?').run(test.id),
    /scale_locked/,
  );
  assert.throws(
    () => db.prepare('DELETE FROM items WHERE test_id = ?').run(test.id),
    /anchor_locked/,
  );
  assert.throws(
    () =>
      db
        .prepare('INSERT INTO items (test_id, position, answer_key, b_logit) VALUES (?, 99, ?, 0)')
        .run(test.id, 'A'),
    /anchor_locked/,
  );
  db.close();
});

test('issued results are immutable', () => {
  const db = fixture();
  const id = submit(db, 3, ['A', 'B', 'C', 'D']);
  scoreSubmission(db, id);
  assert.throws(
    () => db.prepare('UPDATE results SET scaled_score = 800 WHERE submission_id = ?').run(id),
    /result_immutable/,
  );
  db.close();
});

test('scoring aborts if the anchor fingerprint no longer matches', () => {
  const db = fixture();
  const test = getTestByCode(db, 'T1');
  // Simulate tampering that bypassed the triggers (e.g. a restored backup
  // written with anchored=0, or a migration bug).
  db.prepare('UPDATE items SET anchored = 0 WHERE test_id = ?').run(test.id);
  db.prepare('UPDATE items SET b_logit = -3 WHERE test_id = ? AND position = 1').run(test.id);

  const id = submit(db, 4, ['A', 'B', 'C', 'D']);
  assert.throws(() => scoreSubmission(db, id), /ANCHOR INTEGRITY FAILURE/);
  db.close();
});

test('re-scoring an already-scored submission is a no-op', () => {
  const db = fixture();
  const id = submit(db, 5, ['A', 'B', 'X', 'X']);
  const first = scoreSubmission(db, id);
  const second = scoreSubmission(db, id);

  assert.equal(second.alreadyScored, true);
  assert.equal(second.result.theta, first.result.theta);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM results WHERE submission_id = ?').get(id).c, 1);
  db.close();
});

test('scoreAllPending grades the backlog and skips finished work', () => {
  const db = fixture();
  const ids = [submit(db, 6, ['A', 'X', 'X', 'X']), submit(db, 7, ['A', 'B', 'X', 'X'])];
  scoreSubmission(db, ids[0]);

  const r = scoreAllPending(db, 'T1');
  assert.equal(r.total, 1);
  assert.equal(r.scored, 1);
  assert.deepEqual(r.errors, []);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM results').get().c, 2);
  db.close();
});

test('VOLUME INVARIANCE: raw score maps identically across growing cohorts', () => {
  const db = fixture();
  const seenByRaw = new Map();
  const patterns = [
    ['X', 'X', 'X', 'X'],
    ['A', 'X', 'X', 'X'],
    ['X', 'B', 'X', 'X'],
    ['A', 'B', 'X', 'X'],
    ['X', 'X', 'C', 'D'],
    ['A', 'B', 'C', 'X'],
    ['A', 'B', 'C', 'D'],
  ];

  for (let round = 0; round < 300; round++) {
    const answers = patterns[round % patterns.length];
    const id = submit(db, 1000 + round, answers);
    const { scored } = scoreSubmission(db, id);
    const key = scored.rawScore;
    const snapshot = { theta: scored.theta, scaled: scored.scaledScore, grade: scored.grade };
    if (seenByRaw.has(key)) assert.deepEqual(snapshot, seenByRaw.get(key));
    else seenByRaw.set(key, snapshot);
  }

  assert.equal(db.prepare('SELECT COUNT(*) c FROM results').get().c, 300);
  assert.equal(seenByRaw.size, 5); // raw totals 0..4
  db.close();
});

test('loadAnchors returns the frozen constants verbatim', () => {
  const db = fixture();
  const test = getTestByCode(db, 'T1');
  const { b, scale, bands, checksum } = loadAnchors(db, test);
  assert.deepEqual(b, [-1.5, -0.5, 0.5, 1.5]);
  assert.deepEqual(scale, { intercept: 500, slope: 50, min: 200, max: 800 });
  assert.equal(bands.length, 4);
  assert.equal(checksum, test.anchor_checksum);
  assert.ok(getItems(db, test.id).every((i) => i.anchored === 1));
  db.close();
});
