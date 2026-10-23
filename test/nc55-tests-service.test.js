import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import {
  parseAnswerKey,
  upsertDraftTest,
  lockTest,
  getTestByCode,
  getItems,
  generateUniqueCode,
} from '../src/services/tests.js';
import { nc55Items } from '../src/domain/nc55.js';

/** Builds a syntactically valid 55-item NC55 key, optionally damaged by `mutate`. */
function nc55Key({ code = 'TEST-9001', title = 'National Certificate', mutate } = {}) {
  let items = nc55Items().map((i) => ({
    label: i.label,
    answer: i.itemType === 'mcq' ? i.options[0] : null,
    b: -2 + (i.seq % 10) * 0.4,
  }));
  if (mutate) items = mutate(items);

  const lines = items.map((i) => (i.answer ? `${i.label} ${i.answer} ${i.b}` : `${i.label} ${i.b}`));
  return [
    'TEMPLATE: NC55',
    code ? `CODE: ${code}` : null,
    `TITLE: ${title}`,
    'GRADES: A+>=700, A>=640, B+>=580, B>=520, C>=460, NC>=0',
    'ITEMS:',
    ...lines,
  ]
    .filter((l) => l !== null)
    .join('\n');
}

test('a well-formed NC55 key parses with zero errors and the right shape', () => {
  const parsed = parseAnswerKey(nc55Key());
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.meta.template, 'nc55');
  assert.equal(parsed.items.length, 55);
  assert.equal(parsed.items.filter((i) => i.item_type === 'mcq').length, 35);
  assert.equal(parsed.items.filter((i) => i.item_type === 'written').length, 20);
});

test('mcq answers outside the item option domain are rejected', () => {
  const key = nc55Key({ mutate: (items) => items.map((i) => (i.label === '34' ? { ...i, answer: 'Z' } : i)) });
  const parsed = parseAnswerKey(key);
  assert.ok(parsed.errors.some((e) => /item 34 answer "Z" is not one of ABCDEF/.test(e)));
});

test('item 33-35 accept the 6th option letter that 1-32 would reject', () => {
  const key = nc55Key({ mutate: (items) => items.map((i) => (i.label === '33' ? { ...i, answer: 'F' } : i)) });
  assert.deepEqual(parseAnswerKey(key).errors, []);

  const badEarly = nc55Key({ mutate: (items) => items.map((i) => (i.label === '5' ? { ...i, answer: 'E' } : i)) });
  assert.ok(parseAnswerKey(badEarly).errors.some((e) => /item 5 answer "E" is not one of ABCD\b/.test(e)));
});

test('a written sub-item given an answer key is rejected with a specific message', () => {
  const broken = nc55Key().replace(/^36a .+$/m, '36a A -1.2');
  const parsed = parseAnswerKey(broken);
  assert.ok(
    parsed.errors.some((e) => /written sub-item "36a" must not have an answer key \(got "A"\)/.test(e)),
  );
});

test('a missing written sub-item is reported by validateNc55Structure, not the gap-check', () => {
  const key = nc55Key({ mutate: (items) => items.filter((i) => i.label !== '40b') });
  const parsed = parseAnswerKey(key);
  assert.ok(parsed.errors.some((e) => /expected exactly 55/.test(e)));
  assert.ok(!parsed.errors.some((e) => /no gaps/.test(e)));
});

test('a duplicate written label is caught before structure validation runs', () => {
  const key = nc55Key() + '\n36a -1.0'; // 36a now appears twice
  const parsed = parseAnswerKey(key);
  assert.ok(parsed.errors.some((e) => /duplicate item 36a/.test(e)));
});

test('written items may omit the difficulty for later calibration, same as mcq', () => {
  const key = nc55Key().replace(/^36a .+$/m, '36a');
  const parsed = parseAnswerKey(key);
  const item = parsed.items.find((i) => i.label === '36a');
  assert.equal(item.b_logit, null);
});

test('upsertDraftTest auto-generates a code when CODE is omitted', () => {
  const db = openDb(':memory:');
  const parsed = parseAnswerKey(nc55Key({ code: null }));
  const test1 = upsertDraftTest(db, parsed, 1);
  assert.match(test1.code, /^TEST-\d{4}$/);

  // A second upload without a code gets a different generated code.
  const parsed2 = parseAnswerKey(nc55Key({ code: null, title: 'Other' }));
  const test2 = upsertDraftTest(db, parsed2, 1);
  assert.notEqual(test1.code, test2.code);
  db.close();
});

test('generateUniqueCode never collides with an existing test', () => {
  const db = openDb(':memory:');
  const codes = new Set();
  for (let i = 0; i < 25; i++) {
    const code = generateUniqueCode(db);
    assert.ok(!codes.has(code));
    codes.add(code);
    db.prepare("INSERT INTO tests (code, title) VALUES (?, 'x')").run(code);
  }
  db.close();
});

test('locking an NC55 test stores full item metadata and validates structure again', () => {
  const db = openDb(':memory:');
  upsertDraftTest(db, parseAnswerKey(nc55Key({ code: 'TEST-7001' })), 1);
  const test = lockTest(db, 'TEST-7001');
  assert.equal(test.template, 'nc55');

  const items = getItems(db, test.id);
  assert.equal(items.length, 55);
  const written36a = items.find((i) => i.label === '36a');
  assert.equal(written36a.item_type, 'written');
  assert.equal(written36a.parent_question, 36);
  assert.equal(written36a.sub_label, 'a');
  assert.equal(written36a.answer_key, null);
  assert.equal(written36a.anchored, 1);

  const mcq33 = items.find((i) => i.label === '33');
  assert.equal(mcq33.option_count, 6);
  db.close();
});

test('locking refuses a structurally broken NC55 test even if every anchor is present', () => {
  const db = openDb(':memory:');
  // Bypass parse-time validation by uploading valid NC55, then corrupting a
  // draft item directly — simulates a bug elsewhere writing bad rows, which
  // lockTest must still catch since it is the actual gate before scoring.
  const test = upsertDraftTest(db, parseAnswerKey(nc55Key({ code: 'TEST-7002' })), 1);
  db.prepare("UPDATE items SET option_count = 5 WHERE test_id = ? AND label = '10'").run(test.id);
  assert.throws(() => lockTest(db, 'TEST-7002'), /does not conform to the NC55 template/);
  db.close();
});

test('a custom (legacy) test is unaffected by NC55 validation', () => {
  const db = openDb(':memory:');
  const key = 'CODE: OLD1\nTITLE: Legacy quiz\nITEMS:\n1 A -1\n2 B 0\n3 C 1';
  const parsed = parseAnswerKey(key);
  assert.equal(parsed.meta.template, 'custom');
  upsertDraftTest(db, parsed, 1);
  const test = lockTest(db, 'OLD1');
  assert.equal(test.template, 'custom');
  db.close();
});
