import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { parseAnswerKey, upsertDraftTest, lockTest, getItems, getTestByCode } from '../src/services/tests.js';
import {
  recordSubmissionByLabel,
  parseLabeledAnswers,
  getOrCreateStudent,
} from '../src/services/submissions.js';
import { nc55Items } from '../src/domain/nc55.js';

function nc55Fixture(db, code = 'TEST-1234') {
  const items = nc55Items().map((i) => ({
    label: i.label,
    answer: i.itemType === 'mcq' ? i.options[0] : null,
    b: -1,
  }));
  const lines = items.map((i) => (i.answer ? `${i.label} ${i.answer} ${i.b}` : `${i.label} ${i.b}`));
  const key = ['TEMPLATE: NC55', `CODE: ${code}`, 'TITLE: Fixture', 'ITEMS:', ...lines].join('\n');
  upsertDraftTest(db, parseAnswerKey(key), 1);
  return lockTest(db, code);
}

test('recordSubmissionByLabel auto-grades mcq and leaves written items ungraded', () => {
  const db = openDb(':memory:');
  const test = nc55Fixture(db);
  const items = getItems(db, test.id);
  const student = getOrCreateStudent(db, { id: 1, first_name: 'S' });

  const answersByLabel = {};
  for (const item of items) {
    answersByLabel[item.label] = item.item_type === 'mcq' ? item.answer_key : 'free text answer';
  }
  // One mcq item answered wrong, to check correctness really is key-matched.
  answersByLabel['5'] = 'ZZZ';

  const subId = recordSubmissionByLabel(db, {
    testId: test.id,
    studentId: student.id,
    rawInput: 'n/a',
    answersByLabel,
    source: 'miniapp',
  });

  const responses = db
    .prepare(
      `SELECT i.label, i.item_type, r.given, r.correct FROM responses r
       JOIN items i ON i.id = r.item_id WHERE r.submission_id = ?`,
    )
    .all(subId);
  assert.equal(responses.length, 55);

  const written = responses.filter((r) => r.item_type === 'written');
  assert.equal(written.length, 20);
  assert.ok(written.every((r) => r.correct === null));
  assert.ok(written.every((r) => r.given === 'free text answer'));

  const mcq = responses.filter((r) => r.item_type === 'mcq');
  assert.ok(mcq.every((r) => r.correct !== null));
  assert.equal(mcq.find((r) => r.label === '5').correct, 0);
  assert.equal(mcq.find((r) => r.label === '1').correct, 1);

  assert.equal(db.prepare('SELECT source FROM submissions WHERE id = ?').get(subId).source, 'miniapp');
  db.close();
});

test('recordSubmissionByLabel treats a missing label as an omission, not an error', () => {
  const db = openDb(':memory:');
  const test = nc55Fixture(db);
  const student = getOrCreateStudent(db, { id: 2, first_name: 'S' });
  const subId = recordSubmissionByLabel(db, {
    testId: test.id,
    studentId: student.id,
    rawInput: 'n/a',
    answersByLabel: { 1: 'A' }, // everything else omitted
  });
  const row = db
    .prepare(`SELECT correct FROM responses r JOIN items i ON i.id=r.item_id WHERE r.submission_id=? AND i.label='2'`)
    .get(subId);
  assert.equal(row.correct, 0); // omitted mcq = incorrect, same as always
  db.close();
});

/* ------------------------------------------------------------------ */
/* parseLabeledAnswers                                                 */
/* ------------------------------------------------------------------ */

function fakeItems() {
  // A small heterogeneous set: a few mcq items (including a 6-option one)
  // plus two written sub-items, enough to exercise every branch.
  return [
    { label: '1', item_type: 'mcq' },
    { label: '2', item_type: 'mcq' },
    { label: '33', item_type: 'mcq' },
    { label: '36a', item_type: 'written' },
    { label: '36b', item_type: 'written' },
  ];
}

test('parseLabeledAnswers reads a compact mcq line plus separate written lines', () => {
  const text = ['1A 2B 33F', '36a: because the force increases', '36b: F = ma'].join('\n');
  const { answers, error } = parseLabeledAnswers(text, fakeItems());
  assert.equal(error, null);
  assert.deepEqual(answers, {
    1: 'A',
    2: 'B',
    33: 'F',
    '36a': 'because the force increases',
    '36b': 'F = ma',
  });
});

test('parseLabeledAnswers accepts a written answer with no separator at all', () => {
  const { answers } = parseLabeledAnswers('36a because it does', [{ label: '36a', item_type: 'written' }]);
  assert.equal(answers['36a'], 'because it does');
});

test('parseLabeledAnswers preserves punctuation embedded in a written answer', () => {
  const { answers } = parseLabeledAnswers(
    '36a: velocity = distance / time: approx 9.8 m/s^2, roughly.',
    [{ label: '36a', item_type: 'written' }],
  );
  assert.equal(answers['36a'], 'velocity = distance / time: approx 9.8 m/s^2, roughly.');
});

test('parseLabeledAnswers is case-insensitive on the a/b suffix', () => {
  const { answers } = parseLabeledAnswers('36A: text', [{ label: '36a', item_type: 'written' }]);
  assert.equal(answers['36a'], 'text');
});

test('parseLabeledAnswers treats unmentioned items as omitted', () => {
  const { answers, error } = parseLabeledAnswers('1A', fakeItems());
  assert.equal(error, null);
  assert.equal(answers['2'], null);
  assert.equal(answers['36a'], null);
});

test('parseLabeledAnswers rejects a written sub-item answered twice', () => {
  const { error } = parseLabeledAnswers('36a: first\n36a: second', [{ label: '36a', item_type: 'written' }]);
  assert.match(error, /36a answered more than once/);
});

test('parseLabeledAnswers rejects an mcq item answered twice across lines', () => {
  const { error } = parseLabeledAnswers('1A\n1B', fakeItems());
  assert.match(error, /1 answered more than once/);
});

test('parseLabeledAnswers rejects a line it cannot map to any known item', () => {
  const { error } = parseLabeledAnswers('99Z', fakeItems());
  assert.match(error, /Could not read this line/);
});

test('parseLabeledAnswers rejects an empty message', () => {
  assert.equal(parseLabeledAnswers('   \n  ', fakeItems()).error, 'Empty message.');
});

test('parseLabeledAnswers supports the "-" omission convention for mcq', () => {
  const { answers } = parseLabeledAnswers('1- 2B', fakeItems());
  assert.equal(answers['1'], null);
  assert.equal(answers['2'], 'B');
});

test('a prose written answer never gets misread as a run of compact mcq pairs', () => {
  // Deliberately contains digit-letter-adjacent substrings that a naive
  // regex might mistake for "label+answer" pairs.
  const prose = '36a: in 9.8 seconds the object reaches 2m before 3B happens, approximately.';
  const { answers, error } = parseLabeledAnswers(prose, [{ label: '36a', item_type: 'written' }]);
  assert.equal(error, null);
  assert.equal(answers['36a'], prose.slice('36a:'.length).trim());
});
