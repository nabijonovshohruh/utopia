import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnswerKey } from '../src/services/tests.js';
import { gradeFor, thetaToScaled } from '../src/services/rasch.js';
import { nc55Items, NC55_GRADE_BANDS, NC55_DEFAULT_SCALE } from '../src/domain/nc55.js';

function nc55Key({ extra = [] } = {}) {
  const lines = nc55Items().map((i) =>
    i.itemType === 'mcq' ? `${i.label} ${i.options[0]} -1.0` : `${i.label} -1.0`,
  );
  return ['TEMPLATE: NC55', 'CODE: GSCALE-1', 'TITLE: Grade Scale Fixture', ...extra, 'ITEMS:', ...lines].join('\n');
}

test('an NC55 key with no SCALE/RANGE/GRADES header gets the ball-scale defaults', () => {
  const parsed = parseAnswerKey(nc55Key());
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.meta.scale_intercept, 50);
  assert.equal(parsed.meta.scale_slope, 10);
  assert.equal(parsed.meta.scale_min, 0);
  assert.equal(parsed.meta.scale_max, 100);
  assert.deepEqual(parsed.bands, NC55_GRADE_BANDS);
});

test('an explicit SCALE/RANGE/GRADES header still overrides the NC55 default', () => {
  const parsed = parseAnswerKey(
    nc55Key({ extra: ['SCALE: 500 + 50*theta', 'RANGE: 200..800', 'GRADES: Pass>=500, Fail>=0'] }),
  );
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.meta.scale_intercept, 500);
  assert.equal(parsed.meta.scale_slope, 50);
  assert.deepEqual(parsed.bands, [
    { label: 'Pass', minScaled: 500 },
    { label: 'Fail', minScaled: 0 },
  ]);
});

test('a custom (non-NC55) key is unaffected by the NC55 defaults', () => {
  const parsed = parseAnswerKey('CODE: C1\nTITLE: Custom\nITEMS:\n1 A -1\n2 B 0');
  assert.equal(parsed.meta.scale_intercept, 500);
  assert.equal(parsed.meta.scale_slope, 50);
  assert.equal(parsed.meta.scale_min, 200);
  assert.equal(parsed.meta.scale_max, 800);
});

test('the certificate grade thresholds match the specified ball ranges exactly', () => {
  const cases = [
    [0, 'Sertifikat berilmaydi'],
    [45, 'Sertifikat berilmaydi'],
    [46, 'C'],
    [50, 'C'],
    [51, 'C+'],
    [55, 'C+'],
    [56, 'B'],
    [60, 'B'],
    [61, 'A'],
    [64, 'A'],
    [65, 'A+'],
    [100, 'A+'],
  ];
  for (const [ball, expected] of cases) {
    assert.equal(gradeFor(ball, NC55_GRADE_BANDS), expected, `ball=${ball}`);
  }
});

test('thetaToScaled with the NC55 default scale clamps to the 0-100 ball range', () => {
  // NC55_DEFAULT_SCALE uses snake_case keys to match the meta/DB convention
  // (it's merged straight into parseAnswerKey's meta object); thetaToScaled
  // takes the camelCase shape rasch.js uses everywhere else.
  const scale = {
    intercept: NC55_DEFAULT_SCALE.scale_intercept,
    slope: NC55_DEFAULT_SCALE.scale_slope,
    min: NC55_DEFAULT_SCALE.scale_min,
    max: NC55_DEFAULT_SCALE.scale_max,
  };
  assert.equal(thetaToScaled(0, scale), 50);
  assert.equal(thetaToScaled(1.5, scale), 65);
  assert.equal(thetaToScaled(-0.4, scale), 46);
  assert.equal(thetaToScaled(99, scale), 100);
  assert.equal(thetaToScaled(-99, scale), 0);
});
