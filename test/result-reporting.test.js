import { test } from 'node:test';
import assert from 'node:assert/strict';
import { studentReport } from '../src/bot/format.js';
import { openDb } from '../src/db/index.js';
import { parseAnswerKey, upsertDraftTest, lockTest, getBands } from '../src/services/tests.js';
import { recordSubmission, getOrCreateStudent, registerFullName } from '../src/services/submissions.js';
import { scoreSubmission, listResults, listPending } from '../src/services/scoring.js';

test('studentReport includes the registered name when given, and omits the line when not', () => {
  const test_ = {
    title: 'T',
    code: 'C1',
    anchor_checksum: 'abcdef1234567890',
    scale_version: 1,
  };
  const scored = {
    rawScore: 3,
    itemCount: 4,
    percentCorrect: 75,
    theta: 0.5,
    se: 0.4,
    scaledScore: 525,
    scaledSe: 20,
    grade: 'B',
  };
  const bands = [{ label: 'B', minScaled: 500 }];

  const withName = studentReport({ test: test_, scored, submissionId: 1, bands, studentName: 'Shohruh Nabijonov' });
  assert.match(withName, /Ism-Familiya: <b>Shohruh Nabijonov<\/b>/);

  const withoutName = studentReport({ test: test_, scored, submissionId: 1, bands });
  assert.ok(!withoutName.includes('Ism-Familiya'));
});

test('studentReport escapes HTML-special characters in the name (defense in depth)', () => {
  const report = studentReport({
    test: { title: 'T', code: 'C', anchor_checksum: 'x'.repeat(10), scale_version: 1 },
    scored: { rawScore: 1, itemCount: 1, percentCorrect: 100, theta: 0, se: 0.1, scaledScore: 500, scaledSe: 5, grade: 'B' },
    submissionId: 1,
    bands: [{ label: 'B', minScaled: 0 }],
    studentName: '<script>alert(1)</script>',
  });
  assert.ok(!report.includes('<script>'));
  assert.match(report, /&lt;script&gt;/);
});

test('end-to-end: a registered name appears in /result-equivalent data and admin listings', () => {
  const db = openDb(':memory:');
  const key = [
    'CODE: RR1',
    'TITLE: Reporting Fixture',
    'GRADES: A>=600, B>=500, C>=400, NC>=0',
    'ITEMS:',
    '1 A -1.0',
    '2 B 0.0',
    '3 C 1.0',
  ].join('\n');
  upsertDraftTest(db, parseAnswerKey(key), 1);
  const test_ = lockTest(db, 'RR1');

  const student = getOrCreateStudent(db, { id: 999, first_name: 'Placeholder' });
  registerFullName(db, 999, 'Shohruh Nabijonov');
  const registered = getOrCreateStudent(db, { id: 999 });
  assert.equal(registered.full_name, 'Shohruh Nabijonov');

  const subId = recordSubmission(db, {
    testId: test_.id,
    studentId: registered.id,
    rawInput: 'ABC',
    answers: ['A', 'B', 'C'],
  });

  // Unscored: shows up in /pending by the registered name.
  const pending = listPending(db);
  assert.equal(pending.find((p) => p.id === subId).full_name, 'Shohruh Nabijonov');

  const { scored } = scoreSubmission(db, subId);
  const report = studentReport({
    test: test_,
    scored,
    submissionId: subId,
    bands: getBands(db, test_.id),
    studentName: registered.full_name,
  });
  assert.match(report, /Ism-Familiya: <b>Shohruh Nabijonov<\/b>/);
  assert.match(report, /Reporting Fixture/);
  assert.match(report, new RegExp(`${scored.scaledScore}`));
  assert.match(report, new RegExp(scored.grade));

  // Scored: shows up in the ranked /results listing by the registered name too.
  const results = listResults(db, 'RR1');
  assert.equal(results[0].full_name, 'Shohruh Nabijonov');
  db.close();
});
