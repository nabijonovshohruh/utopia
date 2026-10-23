import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  probability,
  expectedScore,
  estimateTheta,
  estimateThetaMLE,
  estimateThetaWLE,
  standardError,
  thetaToScaled,
  gradeFor,
  scoreResponses,
  buildScoreTable,
  calibrateAnchors,
  itemDiagnostics,
  DEFAULT_GRADE_BANDS,
} from '../src/services/rasch.js';
import { parseAnswers, isCorrect } from '../src/services/submissions.js';
import { parseAnswerKey } from '../src/services/tests.js';

const B = [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5];
const SCALE = { intercept: 500, slope: 50, min: 200, max: 800 };

test('probability is 0.5 when ability equals difficulty', () => {
  assert.equal(probability(0, 0), 0.5);
  assert.equal(probability(1.7, 1.7), 0.5);
  assert.ok(probability(2, 0) > 0.88);
  assert.ok(probability(-2, 0) < 0.12);
});

test('theta is strictly monotone in raw score', () => {
  let prev = -Infinity;
  for (let r = 0; r <= B.length; r++) {
    const theta = estimateTheta(r, B);
    assert.ok(theta > prev, `raw ${r} did not increase theta`);
    prev = theta;
  }
});

test('WLE is finite at zero and perfect scores', () => {
  for (const r of [0, B.length]) {
    const theta = estimateThetaWLE(r, B);
    assert.ok(Number.isFinite(theta), `raw ${r} gave ${theta}`);
    assert.ok(Math.abs(theta) < 8);
  }
});

test('MLE recovers the ability that generated the expected score', () => {
  for (const trueTheta of [-1.5, -0.5, 0, 0.75, 2]) {
    const raw = expectedScore(trueTheta, B);
    const theta = estimateThetaMLE(raw, B);
    assert.ok(Math.abs(theta - trueTheta) < 1e-4, `wanted ${trueTheta}, got ${theta}`);
  }
});

test('standard error is lowest where the test is most informative', () => {
  // Anchors are centred near 0.25 logits, so SE should be minimal there.
  const seCentre = standardError(0.25, B);
  assert.ok(seCentre < standardError(-3, B));
  assert.ok(seCentre < standardError(3, B));
});

test('scaled score transform is fixed and clamped', () => {
  assert.equal(thetaToScaled(0, SCALE), 500);
  assert.equal(thetaToScaled(1, SCALE), 550);
  assert.equal(thetaToScaled(-2, SCALE), 400);
  assert.equal(thetaToScaled(99, SCALE), 800);
  assert.equal(thetaToScaled(-99, SCALE), 200);
});

test('grade bands map on the boundary inclusively', () => {
  assert.equal(gradeFor(700, DEFAULT_GRADE_BANDS), 'A+');
  assert.equal(gradeFor(699, DEFAULT_GRADE_BANDS), 'A');
  assert.equal(gradeFor(640, DEFAULT_GRADE_BANDS), 'A');
  assert.equal(gradeFor(0, DEFAULT_GRADE_BANDS), 'NC');
});

test('ANCHORING: identical response vectors always score identically', () => {
  const responses = [1, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const first = scoreResponses(responses, B, SCALE, DEFAULT_GRADE_BANDS);
  // Score the same vector a thousand more times, interleaved with every other
  // possible pattern, to prove there is no accumulated state anywhere.
  for (let i = 0; i < 1000; i++) {
    const noise = B.map(() => (Math.random() < 0.5 ? 1 : 0));
    scoreResponses(noise, B, SCALE, DEFAULT_GRADE_BANDS);
    const again = scoreResponses(responses, B, SCALE, DEFAULT_GRADE_BANDS);
    assert.deepEqual(again, first);
  }
});

test('ANCHORING: score depends only on raw total, not which items were right', () => {
  // Sufficiency of the raw score is the defining property of the Rasch model.
  const a = scoreResponses([1, 1, 1, 0, 0, 0, 0, 0, 0, 0], B, SCALE, DEFAULT_GRADE_BANDS);
  const b = scoreResponses([0, 0, 0, 0, 0, 0, 0, 1, 1, 1], B, SCALE, DEFAULT_GRADE_BANDS);
  assert.equal(a.theta, b.theta);
  assert.equal(a.scaledScore, b.scaledScore);
  assert.equal(a.grade, b.grade);
});

test('score table covers every raw score and rises monotonically', () => {
  const table = buildScoreTable(B, SCALE, DEFAULT_GRADE_BANDS);
  assert.equal(table.length, B.length + 1);
  for (let i = 1; i < table.length; i++) {
    assert.ok(table[i].theta > table[i - 1].theta);
    assert.ok(table[i].scaledScore >= table[i - 1].scaledScore);
  }
});

test('scoreResponses rejects an anchor/response length mismatch', () => {
  assert.throws(() => scoreResponses([1, 0], B, SCALE, DEFAULT_GRADE_BANDS), /length mismatch/);
});

test('calibration recovers known difficulties from simulated data', () => {
  const trueB = [-2, -1, -0.5, 0, 0.5, 1, 2, -1.5, 1.5, 0.25];
  const centred = trueB.map((b) => b - trueB.reduce((a, c) => a + c, 0) / trueB.length);

  let seed = 7;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const matrix = [];
  for (let i = 0; i < 1500; i++) {
    const theta = (rand() + rand() + rand() - 1.5) * 2;
    matrix.push(centred.map((b) => (rand() < probability(theta, b) ? 1 : 0)));
  }

  const { b, converged, excludedItems } = calibrateAnchors(matrix);
  assert.ok(converged);
  assert.equal(excludedItems.length, 0);
  for (let j = 0; j < centred.length; j++) {
    // JMLE on 1500 cases should land within ~0.2 logits of truth.
    assert.ok(
      Math.abs(b[j] - centred[j]) < 0.25,
      `item ${j + 1}: recovered ${b[j]}, expected ~${centred[j].toFixed(2)}`,
    );
  }
});

test('calibration refuses degenerate input instead of inventing anchors', () => {
  assert.throws(() => calibrateAnchors([[1, 1, 1]]), /at least 2/);
  assert.throws(() => calibrateAnchors(Array(50).fill([1, 1, 1])), /non-extreme items/);
});

test('item diagnostics flag a deliberately mis-anchored item', () => {
  let seed = 11;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  // Generate data where item 5 is genuinely 2 logits easier than its anchor
  // claims (i.e. the anchor has gone stale / the item leaked).
  const realB = [...B];
  realB[4] = B[4] - 2;
  const matrix = [];
  for (let i = 0; i < 800; i++) {
    const theta = (rand() + rand() + rand() - 1.5) * 2;
    matrix.push(realB.map((b) => (rand() < probability(theta, b) ? 1 : 0)));
  }

  const diag = itemDiagnostics(matrix, B);
  assert.ok(diag[4].stale, 'the mis-anchored item should be flagged');
  // Item is easier than its anchor, so the implied re-estimate is lower.
  assert.ok(
    diag[4].displacement < -1,
    `expected a large negative displacement, got ${diag[4].displacement}`,
  );
  assert.ok(diag[4].observedProportion > diag[4].expectedProportion);
  // The anchors array must be untouched — diagnostics never write back.
  assert.equal(B[4], 0);
});

/* ---------------- parsing ---------------- */

test('answer parsing accepts the documented formats', () => {
  assert.deepEqual(parseAnswers('ABCD', 4).answers, ['A', 'B', 'C', 'D']);
  assert.deepEqual(parseAnswers('A B C D', 4).answers, ['A', 'B', 'C', 'D']);
  assert.deepEqual(parseAnswers('a,b,c,d', 4).answers, ['A', 'B', 'C', 'D']);
  assert.deepEqual(parseAnswers('1A 2B 3C 4D', 4).answers, ['A', 'B', 'C', 'D']);
  assert.deepEqual(parseAnswers('1. A\n2) B\n3 - C\n4: D', 4).answers, ['A', 'B', 'C', 'D']);
});

test('answer parsing records omissions as null', () => {
  assert.deepEqual(parseAnswers('A-CD', 4).answers, ['A', null, 'C', 'D']);
  assert.deepEqual(parseAnswers('1A 3C', 4).answers, ['A', null, 'C', null]);
});

test('answer parsing rejects the wrong count and double answers', () => {
  assert.match(parseAnswers('ABC', 4).error, /Expected 4 answers but read 3/);
  assert.match(parseAnswers('', 4).error, /Empty/);
  assert.match(parseAnswers('1A 1B 2C 3D 4A', 4).error, /more than once/);
});

test('omitted answers are incorrect, never a crash', () => {
  assert.equal(isCorrect(null, 'A'), 0);
  assert.equal(isCorrect('', 'A'), 0);
  assert.equal(isCorrect('a', 'A'), 1);
  assert.equal(isCorrect(' B ', 'b'), 1);
});

test('answer key parsing reads metadata, bands and anchors', () => {
  const parsed = parseAnswerKey(
    [
      '# comment',
      'CODE: phys-1',
      'TITLE: Physics Unit 1',
      'SCALE: 1000 + 100*theta',
      'RANGE: 0..2000',
      'GRADES: Pass>=1000, Fail>=0',
      'ITEMS:',
      '1 A -1.5',
      '2. B 0',
      '3) C 1.25',
    ].join('\n'),
  );
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.meta.code, 'PHYS-1');
  assert.equal(parsed.meta.scale_intercept, 1000);
  assert.equal(parsed.meta.scale_slope, 100);
  assert.equal(parsed.meta.scale_max, 2000);
  assert.deepEqual(parsed.bands, [
    { label: 'Pass', minScaled: 1000 },
    { label: 'Fail', minScaled: 0 },
  ]);
  assert.equal(parsed.items.length, 3);
  assert.deepEqual(parsed.items[2], {
    position: 3,
    label: '3',
    answer_key: 'C',
    b_logit: 1.25,
    item_type: 'mcq',
    option_count: null,
    parent_question: null,
    sub_label: null,
  });
});

test('answer key parsing catches gaps, duplicates and absurd difficulties', () => {
  const gap = parseAnswerKey('CODE: X\nTITLE: Y\nITEMS:\n1 A 0\n3 B 0');
  assert.ok(gap.errors.some((e) => /no gaps/.test(e)));

  const dup = parseAnswerKey('CODE: X\nTITLE: Y\nITEMS:\n1 A 0\n1 B 0');
  assert.ok(dup.errors.some((e) => /duplicate item/.test(e)));

  const wild = parseAnswerKey('CODE: X\nTITLE: Y\nITEMS:\n1 A 99');
  assert.ok(wild.errors.some((e) => /plausible/.test(e)));

  // CODE is optional now — it's auto-generated at upsert time if omitted —
  // but TITLE is still required.
  const noTitle = parseAnswerKey('ITEMS:\n1 A 0');
  assert.ok(noTitle.errors.some((e) => /missing TITLE/.test(e)));
  assert.equal(noTitle.meta.code, null);

  const noCode = parseAnswerKey('TITLE: Y\nITEMS:\n1 A 0');
  assert.ok(!noCode.errors.some((e) => /CODE/.test(e)));
});
