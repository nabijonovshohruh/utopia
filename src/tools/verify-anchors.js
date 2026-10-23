/**
 * Demonstrates the central guarantee: scores do not deflate or drift as
 * submission volume grows.
 *
 * Runs the full pipeline end-to-end on an in-memory database against three
 * cohorts of wildly different size and ability, then asserts that identical
 * raw scores produced identical theta / scaled score / grade every time.
 *
 *   node src/tools/verify-anchors.js
 */

import assert from 'node:assert/strict';
import { openDb } from '../db/index.js';
import { parseAnswerKey, upsertDraftTest, lockTest } from '../services/tests.js';
import { recordSubmission, getOrCreateStudent } from '../services/submissions.js';
import { scoreSubmission, scoreTableFor, anchorDriftReport } from '../services/scoring.js';
import { probability, buildScoreTable } from '../services/rasch.js';

const N_ITEMS = 30;
const KEYS = ['A', 'B', 'C', 'D'];

// Fixed anchors spread over roughly -2.5..+2.5 logits.
const anchors = Array.from({ length: N_ITEMS }, (_, i) =>
  Number((-2.5 + (5 * i) / (N_ITEMS - 1)).toFixed(2)),
);
const keyText = [
  'CODE: DEMO-ANCHOR',
  'TITLE: Anchor Stability Demo',
  'SCALE: 500 + 50*theta',
  'RANGE: 200..800',
  'GRADES: A+>=700, A>=640, B+>=580, B>=520, C>=460, NC>=0',
  'ITEMS:',
  ...anchors.map((b, i) => `${i + 1} ${KEYS[i % 4]} ${b}`),
].join('\n');

const db = openDb(':memory:');
const parsed = parseAnswerKey(keyText);
assert.equal(parsed.errors.length, 0, `key parse errors: ${parsed.errors.join('; ')}`);
upsertDraftTest(db, parsed, 1);
const test = lockTest(db, 'DEMO-ANCHOR');
console.log(`Locked DEMO-ANCHOR · ${N_ITEMS} items · anchors ${test.anchor_checksum}\n`);

// Deterministic PRNG so the run is reproducible.
let seed = 42;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

/** Simulates a cohort of `n` students with mean ability `meanTheta`. */
function runCohort(label, n, meanTheta) {
  const observed = new Map(); // rawScore -> {theta, scaled, grade}
  for (let s = 0; s < n; s++) {
    const trueTheta = meanTheta + (rand() + rand() + rand() - 1.5) * 1.2;
    const answers = anchors.map((b, i) =>
      rand() < probability(trueTheta, b) ? KEYS[i % 4] : KEYS[(i + 1) % 4],
    );

    const student = getOrCreateStudent(db, {
      id: 100000 + s + label.length * 1e6,
      first_name: `${label}-${s}`,
      username: null,
    });
    const subId = recordSubmission(db, {
      testId: test.id,
      studentId: student.id,
      rawInput: answers.join(''),
      answers,
    });
    const { scored } = scoreSubmission(db, subId);

    const prior = observed.get(scored.rawScore);
    const current = { theta: scored.theta, scaled: scored.scaledScore, grade: scored.grade };
    if (prior) {
      assert.deepEqual(current, prior, `raw ${scored.rawScore} scored differently within ${label}`);
    } else {
      observed.set(scored.rawScore, current);
    }
  }

  const stats = db
    .prepare(
      `SELECT COUNT(*) n, AVG(theta) mt, AVG(scaled_score) ms
       FROM results r JOIN submissions s ON s.id = r.submission_id WHERE s.test_id = ?`,
    )
    .get(test.id);
  console.log(
    `${label.padEnd(22)} n=${String(n).padStart(5)}  ` +
      `cohort mean θ ${meanTheta.toFixed(2)}  ` +
      `cumulative: ${String(stats.n).padStart(5)} results, mean θ ${stats.mt.toFixed(3)}, ` +
      `mean scaled ${Math.round(stats.ms)}`,
  );
  return observed;
}

// Reference chart, computed from the anchors alone before anyone sits the test.
const reference = new Map(
  buildScoreTable(
    anchors,
    { intercept: 500, slope: 50, min: 200, max: 800 },
    parsed.bands,
  ).map((r) => [r.rawScore, r]),
);

// Three cohorts: small, then huge, then a deliberately weak one. A
// cohort-relative (norm-referenced) scorer would deflate here; an anchored
// one cannot.
const cohorts = [
  runCohort('cohort A (n=50)', 50, 0.0),
  runCohort('cohort B (n=3000)', 3000, 0.6),
  runCohort('cohort C (n=1500 weak)', 1500, -1.4),
];

console.log('\nCross-cohort invariance check…');
let compared = 0;
for (const [raw, first] of cohorts[0]) {
  for (const cohort of cohorts.slice(1)) {
    const later = cohort.get(raw);
    if (!later) continue;
    assert.deepEqual(
      later,
      first,
      `DEFLATION DETECTED: raw ${raw} => ${JSON.stringify(first)} in cohort A ` +
        `but ${JSON.stringify(later)} later`,
    );
    compared++;
  }
}

// And every observed score must match the chart published before launch.
for (const cohort of cohorts) {
  for (const [raw, got] of cohort) {
    const want = reference.get(raw);
    assert.equal(got.scaled, want.scaledScore, `raw ${raw}: scaled drifted from the published chart`);
    assert.equal(got.grade, want.grade, `raw ${raw}: grade drifted from the published chart`);
    assert.ok(Math.abs(got.theta - want.theta) < 1e-3, `raw ${raw}: theta drifted`);
  }
}

console.log(`✅ ${compared} cross-cohort comparisons identical`);
console.log('✅ every score matches the pre-launch conversion chart');

// The anchors themselves must be byte-identical after 4550 submissions.
const after = db.prepare('SELECT * FROM tests WHERE id = ?').get(test.id);
assert.equal(after.anchor_checksum, test.anchor_checksum);
console.log(`✅ anchor fingerprint unchanged: ${after.anchor_checksum}`);

// The database must physically refuse an anchor edit.
try {
  db.prepare('UPDATE items SET b_logit = 0 WHERE test_id = ?').run(test.id);
  assert.fail('expected the anchor-immutability trigger to abort this UPDATE');
} catch (err) {
  assert.match(err.message, /anchor_locked/);
  console.log('✅ database rejected a direct anchor UPDATE: ' + err.message.split(':')[1].trim());
}

const { table } = scoreTableFor(db, 'DEMO-ANCHOR');
console.log('\nConversion chart (unchanged by all 4550 submissions):');
console.log('  raw   theta  scaled  lvl');
for (const r of table.filter((_, i) => i % 3 === 0)) {
  console.log(
    `  ${String(r.rawScore).padStart(3)}  ${(r.theta >= 0 ? '+' : '') + r.theta.toFixed(2)}` +
      `  ${String(r.scaledScore).padStart(5)}  ${r.grade}`,
  );
}

const drift = anchorDriftReport(db, 'DEMO-ANCHOR');
const stale = drift.diagnostics.filter((d) => d.stale);
console.log(
  `\nAnchor health across all cohorts: ${stale.length}/${N_ITEMS} items flagged stale ` +
    `(diagnostic only, never written back).`,
);
console.log('\n🎉 Anchoring verified: volume does not move the scale.');
db.close();
