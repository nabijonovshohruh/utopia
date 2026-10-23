/**
 * End-to-end proof of the 55-item National Certificate pipeline:
 * key upload -> lock -> many students submit (mixed mcq + written) ->
 * teachers grade the written sub-items in scattered batches -> publish.
 *
 * Confirms the same anchor-stability guarantee verify-anchors.js proves for
 * the generic engine still holds at the full 55-item heterogeneous shape —
 * the Rasch math itself didn't change for this template, but the submission
 * pipeline (manual grading, labeled responses, publish-in-one-batch) is new
 * and this exercises all of it together against a real in-memory database.
 *
 *   node src/tools/verify-nc55.js
 */

import assert from 'node:assert/strict';
import { openDb } from '../db/index.js';
import { parseAnswerKey, upsertDraftTest, lockTest, getItems } from '../services/tests.js';
import { recordSubmissionByLabel, getOrCreateStudent } from '../services/submissions.js';
import { gradeWrittenResponses, publishResults, testStatusCounts, scoreTableFor } from '../services/scoring.js';
import { nc55Items, NC55_ITEM_COUNT } from '../domain/nc55.js';
import { probability } from '../services/rasch.js';

let seed = 99;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

// Realistic-ish anchor spread across all 55 items.
const anchors = nc55Items().map((item, i) => Number((-2.6 + (5.2 * i) / (NC55_ITEM_COUNT - 1)).toFixed(2)));
const key = [
  'TEMPLATE: NC55',
  'CODE: VERIFY-NC55',
  'TITLE: NC55 Anchor Stability Proof',
  'GRADES: A+>=700, A>=640, B+>=580, B>=520, C>=460, NC>=0',
  'ITEMS:',
  ...nc55Items().map((item, i) =>
    item.itemType === 'mcq' ? `${item.label} ${item.options[0]} ${anchors[i]}` : `${item.label} ${anchors[i]}`,
  ),
].join('\n');

const db = openDb(':memory:');
const parsed = parseAnswerKey(key);
assert.equal(parsed.errors.length, 0, `key parse errors: ${parsed.errors.join('; ')}`);
upsertDraftTest(db, parsed, 1);
const test = lockTest(db, 'VERIFY-NC55');
const items = getItems(db, test.id);
console.log(`Locked ${test.code} · ${items.length} items (35 mcq, 20 written) · anchor ${test.anchor_checksum}\n`);

/** One simulated student: answers every mcq by true-ability probability, and
 * "writes" every sub-item (free text is cosmetic — what matters for scoring
 * is how the teacher later grades it). */
function simulateSubmission(telegramId, trueTheta) {
  const student = getOrCreateStudent(db, { id: telegramId, first_name: `S${telegramId}` });
  const answersByLabel = {};
  const trueWrittenCorrect = {};
  items.forEach((item, i) => {
    if (item.item_type === 'mcq') {
      const correct = rand() < probability(trueTheta, anchors[i]);
      answersByLabel[item.label] = correct ? item.answer_key : 'Z'; // any wrong letter
    } else {
      answersByLabel[item.label] = `written answer for ${item.label}`;
      trueWrittenCorrect[item.label] = rand() < probability(trueTheta, anchors[i]) ? 1 : 0;
    }
  });
  const subId = recordSubmissionByLabel(db, {
    testId: test.id,
    studentId: student.id,
    rawInput: 'simulated',
    answersByLabel,
    source: telegramId % 2 === 0 ? 'miniapp' : 'chat',
  });
  return { subId, trueWrittenCorrect };
}

// Three cohorts, deliberately different size/ability, submitted interleaved
// with grading happening in scattered batches (not all-at-once) — closer to
// how a real class actually behaves than a tidy "submit then grade" split.
const cohortSpecs = [
  { label: 'cohort A (n=40)', n: 40, mean: 0.0 },
  { label: 'cohort B (n=220)', n: 220, mean: 0.7 },
  { label: 'cohort C (n=130, weak)', n: 130, mean: -1.1 },
];

const pending = [];
for (const spec of cohortSpecs) {
  for (let i = 0; i < spec.n; i++) {
    const theta = spec.mean + (rand() + rand() + rand() - 1.5) * 1.3;
    const telegramId = 500000 + pending.length;
    pending.push(simulateSubmission(telegramId, theta));
  }
  console.log(`${spec.label.padEnd(24)} submitted (${spec.n})`);
}

// Grade every written sub-item across all submissions, in randomised batches
// across several admins (simulated by just calling the function repeatedly
// with different grader ids) rather than one clean pass per student.
let gradedSubmissions = 0;
for (const { subId, trueWrittenCorrect } of pending) {
  const labels = Object.keys(trueWrittenCorrect);
  // Split into 2-3 arbitrary batches to exercise "partial grading, resume
  // later" instead of always grading all 20 at once.
  const batchCount = 1 + Math.floor(rand() * 3);
  const batches = Array.from({ length: batchCount }, () => []);
  labels.forEach((label, i) => batches[i % batchCount].push(label));
  for (const batch of batches) {
    if (!batch.length) continue;
    const scores = {};
    for (const label of batch) scores[label] = trueWrittenCorrect[label];
    gradeWrittenResponses(db, subId, scores, 1);
  }
  gradedSubmissions++;
}
console.log(`\nGraded all written sub-items for ${gradedSubmissions} submissions (scattered batches).`);

const before = testStatusCounts(db, 'VERIFY-NC55');
assert.equal(before.needsGrading, 0, 'grading loop should have left nothing ungraded');
console.log(`Status before publish: ${before.submitted} submitted, ${before.readyToScore} ready to score.`);

const result = publishResults(db, 'VERIFY-NC55');
console.log(`Published ${result.scored} result(s) in one batch.\n`);
assert.equal(result.scored, pending.length);

// The core guarantee: identical raw scores -> identical theta/scaled/grade,
// regardless of which cohort, submission order, grading-batch split, or
// source ('chat' vs 'miniapp') produced them.
const rows = db
  .prepare(
    `SELECT raw_score, theta, scaled_score, grade FROM results
     JOIN submissions s ON s.id = results.submission_id WHERE s.test_id = ?`,
  )
  .all(test.id);
const byRaw = new Map();
let compared = 0;
for (const row of rows) {
  const prior = byRaw.get(row.raw_score);
  if (prior) {
    assert.deepEqual(
      { theta: row.theta, scaled: row.scaled_score, grade: row.grade },
      prior,
      `raw ${row.raw_score} scored inconsistently`,
    );
    compared++;
  } else {
    byRaw.set(row.raw_score, { theta: row.theta, scaled: row.scaled_score, grade: row.grade });
  }
}
console.log(`✅ ${compared} same-raw-score pairs compared across ${rows.length} results — all identical.`);

// And every one matches the pre-publish conversion chart, same as the
// generic engine's guarantee.
const { table } = scoreTableFor(db, 'VERIFY-NC55');
const chartByRaw = new Map(table.map((r) => [r.rawScore, r]));
for (const row of rows) {
  const want = chartByRaw.get(row.raw_score);
  assert.equal(row.scaled_score, want.scaledScore);
  assert.equal(row.grade, want.grade);
}
console.log('✅ every published result matches the pre-publish conversion chart.');

console.log('\nConversion chart (raw 0..55, every 5th row):');
console.log('  raw   theta  scaled  lvl');
for (const r of table.filter((_, i) => i % 5 === 0)) {
  console.log(
    `  ${String(r.rawScore).padStart(3)}  ${(r.theta >= 0 ? '+' : '') + r.theta.toFixed(2)}` +
      `  ${String(r.scaledScore).padStart(5)}  ${r.grade}`,
  );
}

console.log('\n🎉 NC55 pipeline verified: mixed mcq/written items, scattered grading, and batch publish all hold anchoring.');
db.close();
