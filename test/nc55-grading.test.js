import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { parseAnswerKey, upsertDraftTest, lockTest, getItems } from '../src/services/tests.js';
import { recordSubmissionByLabel, getOrCreateStudent } from '../src/services/submissions.js';
import {
  scoreSubmission,
  scoreAllPending,
  publishResults,
  gradeWrittenResponses,
  ungradedCount,
  writtenResponsesFor,
  listNeedingGrading,
  testStatusCounts,
} from '../src/services/scoring.js';
import { nc55Items } from '../src/domain/nc55.js';

function nc55Fixture(db, code = 'TEST-5501') {
  const items = nc55Items().map((i) => ({
    label: i.label,
    answer: i.itemType === 'mcq' ? i.options[0] : null,
    b: -1 + (i.seq % 5) * 0.3,
  }));
  const lines = items.map((i) => (i.answer ? `${i.label} ${i.answer} ${i.b}` : `${i.label} ${i.b}`));
  const key = ['TEMPLATE: NC55', `CODE: ${code}`, 'TITLE: Fixture', 'ITEMS:', ...lines].join('\n');
  upsertDraftTest(db, parseAnswerKey(key), 1);
  return lockTest(db, code);
}

function submitAllCorrect(db, test, telegramId) {
  const items = getItems(db, test.id);
  const student = getOrCreateStudent(db, { id: telegramId, first_name: 'S' });
  const answersByLabel = {};
  for (const item of items) {
    answersByLabel[item.label] = item.item_type === 'mcq' ? item.answer_key : 'a written answer';
  }
  return recordSubmissionByLabel(db, { testId: test.id, studentId: student.id, rawInput: 'x', answersByLabel });
}

test('scoring refuses while any written item is ungraded, with an actionable message', () => {
  const db = openDb(':memory:');
  const test = nc55Fixture(db);
  const subId = submitAllCorrect(db, test, 1);
  assert.equal(ungradedCount(db, subId), 20);
  assert.throws(() => scoreSubmission(db, subId), /20 ungraded written response/);
  db.close();
});

test('gradeWrittenResponses applies scores and scoring succeeds once all 20 are graded', () => {
  const db = openDb(':memory:');
  const test = nc55Fixture(db);
  const subId = submitAllCorrect(db, test, 1);

  const written = writtenResponsesFor(db, subId);
  assert.equal(written.length, 20);
  assert.ok(written.every((r) => r.correct === null));
  assert.ok(written.every((r) => r.given === 'a written answer'));

  const scores = {};
  written.forEach((r, i) => (scores[r.label] = i % 2)); // half 0, half 1
  const result = gradeWrittenResponses(db, subId, scores, 999);
  assert.equal(result.remaining, 0);
  assert.equal(ungradedCount(db, subId), 0);

  const { scored } = scoreSubmission(db, subId);
  // 35 correct mcq + 10 correct written (every other one) = 45
  assert.equal(scored.rawScore, 45);

  const graded = db.prepare("SELECT graded_by, graded_at FROM responses WHERE submission_id=? AND item_id=(SELECT id FROM items WHERE label='36a')").get(subId);
  assert.equal(graded.graded_by, 999);
  assert.ok(graded.graded_at);
  db.close();
});

test('gradeWrittenResponses rejects a non-binary score and applies nothing', () => {
  const db = openDb(':memory:');
  const test = nc55Fixture(db);
  const subId = submitAllCorrect(db, test, 1);
  assert.throws(() => gradeWrittenResponses(db, subId, { '36a': 2 }, 999), /score must be 0 or 1/);
  assert.equal(ungradedCount(db, subId), 20); // nothing partially applied
  db.close();
});

test('gradeWrittenResponses rejects grading an mcq item and a label not on the submission', () => {
  const db = openDb(':memory:');
  const test = nc55Fixture(db);
  const subId = submitAllCorrect(db, test, 1);
  assert.throws(() => gradeWrittenResponses(db, subId, { 1: 1 }, 999), /is not a written item/);
  assert.throws(() => gradeWrittenResponses(db, subId, { '99z': 1 }, 999), /not an item on this submission/);
  db.close();
});

test('gradeWrittenResponses refuses to touch a submission that has already been scored', () => {
  const db = openDb(':memory:');
  const test = nc55Fixture(db);
  const subId = submitAllCorrect(db, test, 1);
  const scores = {};
  getItems(db, test.id)
    .filter((i) => i.item_type === 'written')
    .forEach((i) => (scores[i.label] = 1));
  gradeWrittenResponses(db, subId, scores, 999);
  scoreSubmission(db, subId);

  assert.throws(() => gradeWrittenResponses(db, subId, { '36a': 0 }, 999), /already been scored/);
  db.close();
});

test('testStatusCounts separates needs-grading from ready-to-score from scored', () => {
  const db = openDb(':memory:');
  const test = nc55Fixture(db);
  const subA = submitAllCorrect(db, test, 1); // needs grading
  const subB = submitAllCorrect(db, test, 2); // will be fully graded -> ready
  const subC = submitAllCorrect(db, test, 3); // will be graded + scored

  const scores = {};
  getItems(db, test.id)
    .filter((i) => i.item_type === 'written')
    .forEach((i) => (scores[i.label] = 1));
  gradeWrittenResponses(db, subB, scores, 1);
  gradeWrittenResponses(db, subC, scores, 1);
  scoreSubmission(db, subC);

  const status = testStatusCounts(db, test.code);
  assert.equal(status.submitted, 3);
  assert.equal(status.needsGrading, 1);
  assert.equal(status.readyToScore, 1);
  assert.equal(status.scored, 1);

  const needing = listNeedingGrading(db, test.code);
  assert.equal(needing.length, 1);
  assert.equal(needing[0].id, subA);
  db.close();
});

test('scoreAllPending counts needsGrading separately from hard errors', () => {
  const db = openDb(':memory:');
  const test = nc55Fixture(db);
  submitAllCorrect(db, test, 1); // left ungraded

  const r = scoreAllPending(db, test.code);
  assert.equal(r.total, 1);
  assert.equal(r.scored, 0);
  assert.equal(r.needsGrading, 1);
  assert.deepEqual(r.errors, []);
  db.close();
});

test('publishResults refuses outright if anything still needs grading', () => {
  const db = openDb(':memory:');
  const test = nc55Fixture(db);
  submitAllCorrect(db, test, 1);
  assert.throws(() => publishResults(db, test.code), /still have ungraded written answers/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM results').get().c, 0);
  db.close();
});

test('publishResults scores every ready submission and returns notification data', () => {
  const db = openDb(':memory:');
  const test = nc55Fixture(db);
  const subA = submitAllCorrect(db, test, 111);
  const subB = submitAllCorrect(db, test, 222);

  const scores = {};
  getItems(db, test.id)
    .filter((i) => i.item_type === 'written')
    .forEach((i) => (scores[i.label] = 1));
  gradeWrittenResponses(db, subA, scores, 1);
  gradeWrittenResponses(db, subB, scores, 1);

  const result = publishResults(db, test.code);
  assert.equal(result.scored, 2);
  assert.equal(result.notifications.length, 2);
  const telegramIds = result.notifications.map((n) => n.telegram_id).sort();
  assert.deepEqual(telegramIds, [111, 222]);
  assert.ok(result.notifications.every((n) => n.scaled_score > 0 && n.grade));

  // Calling it again is a safe no-op (nothing left pending).
  const again = publishResults(db, test.code);
  assert.equal(again.scored, 0);
  assert.deepEqual(again.notifications, []);
  db.close();
});
