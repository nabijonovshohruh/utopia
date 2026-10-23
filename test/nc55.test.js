import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NC55_ITEM_COUNT,
  LETTERS4,
  LETTERS6,
  optionsForSeq,
  labelToSeq,
  seqToLabel,
  writtenParentQuestions,
  nc55Items,
  nc55Blocks,
  validateNc55Structure,
} from '../src/domain/nc55.js';

test('nc55Items produces exactly 55 items in strict seq order', () => {
  const items = nc55Items();
  assert.equal(items.length, NC55_ITEM_COUNT);
  items.forEach((item, i) => assert.equal(item.seq, i + 1));
});

test('items 1-32 are 4-option mcq, 33-35 are 6-option mcq', () => {
  const items = nc55Items();
  for (let i = 0; i < 32; i++) {
    assert.equal(items[i].itemType, 'mcq');
    assert.deepEqual(items[i].options, LETTERS4);
    assert.equal(items[i].label, String(i + 1));
  }
  for (let i = 32; i < 35; i++) {
    assert.equal(items[i].itemType, 'mcq');
    assert.deepEqual(items[i].options, LETTERS6);
  }
});

test('items 36-55 are 20 written sub-items under parents 36..45', () => {
  const items = nc55Items().slice(35);
  assert.equal(items.length, 20);
  for (let q = 36; q <= 45; q++) {
    const a = items[(q - 36) * 2];
    const b = items[(q - 36) * 2 + 1];
    assert.equal(a.label, `${q}a`);
    assert.equal(b.label, `${q}b`);
    assert.equal(a.itemType, 'written');
    assert.equal(a.parentQuestion, q);
    assert.equal(a.subLabel, 'a');
    assert.equal(b.subLabel, 'b');
    assert.equal(a.options, null);
  }
});

test('optionsForSeq matches the three regions', () => {
  assert.deepEqual(optionsForSeq(1), LETTERS4);
  assert.deepEqual(optionsForSeq(32), LETTERS4);
  assert.deepEqual(optionsForSeq(33), LETTERS6);
  assert.deepEqual(optionsForSeq(35), LETTERS6);
  assert.equal(optionsForSeq(36), null);
  assert.equal(optionsForSeq(55), null);
});

test('labelToSeq / seqToLabel are exact inverses across all 55 items', () => {
  for (const item of nc55Items()) {
    assert.equal(labelToSeq(item.label), item.seq, `labelToSeq(${item.label})`);
    assert.equal(seqToLabel(item.seq), item.label, `seqToLabel(${item.seq})`);
  }
});

test('labelToSeq rejects out-of-range and malformed labels', () => {
  assert.equal(labelToSeq('0'), null);
  assert.equal(labelToSeq('56'), null);
  assert.equal(labelToSeq('35a'), null); // 35 is mcq, not written
  assert.equal(labelToSeq('46a'), null); // past the written range
  assert.equal(labelToSeq('36c'), null); // only a/b exist
  assert.equal(labelToSeq('abc'), null);
  assert.equal(labelToSeq(''), null);
});

test('labelToSeq accepts lowercase and uppercase sub-labels identically', () => {
  assert.equal(labelToSeq('36A'), labelToSeq('36a'));
  assert.equal(labelToSeq('45B'), labelToSeq('45b'));
});

test('writtenParentQuestions is 36..45', () => {
  assert.deepEqual(writtenParentQuestions(), [36, 37, 38, 39, 40, 41, 42, 43, 44, 45]);
});

test('nc55Blocks groups into 45 visual questions', () => {
  const blocks = nc55Blocks();
  assert.equal(blocks.length, 45); // 32 + 3 mcq blocks + 10 written blocks
  const mcqBlocks = blocks.filter((b) => b.type === 'mcq');
  const writtenBlocks = blocks.filter((b) => b.type === 'written');
  assert.equal(mcqBlocks.length, 35);
  assert.equal(writtenBlocks.length, 10);
  for (const wb of writtenBlocks) {
    assert.equal(wb.subs.length, 2);
    assert.equal(wb.subs[0].label, `${wb.parentQuestion}a`);
    assert.equal(wb.subs[1].label, `${wb.parentQuestion}b`);
  }
});

test('validateNc55Structure accepts a conforming item set', () => {
  const rows = nc55Items().map((i) => ({
    position: i.seq,
    label: i.label,
    item_type: i.itemType,
    option_count: i.optionCount,
    parent_question: i.parentQuestion,
    sub_label: i.subLabel,
    answer_key: i.itemType === 'mcq' ? i.options[0] : null,
  }));
  assert.deepEqual(validateNc55Structure(rows), []);
});

test('validateNc55Structure rejects the wrong item count without false positives', () => {
  const rows = nc55Items()
    .slice(0, 54)
    .map((i) => ({
      position: i.seq,
      label: i.label,
      item_type: i.itemType,
      option_count: i.optionCount,
      parent_question: i.parentQuestion,
      sub_label: i.subLabel,
      answer_key: i.itemType === 'mcq' ? i.options[0] : null,
    }));
  const errors = validateNc55Structure(rows);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /expected exactly 55/);
});

test('validateNc55Structure flags a written item that was given an answer key', () => {
  const rows = nc55Items().map((i) => ({
    position: i.seq,
    label: i.label,
    item_type: i.itemType,
    option_count: i.optionCount,
    parent_question: i.parentQuestion,
    sub_label: i.subLabel,
    answer_key: i.itemType === 'mcq' ? i.options[0] : i.label === '36a' ? 'A' : null,
  }));
  const errors = validateNc55Structure(rows);
  assert.ok(errors.some((e) => /36a: written sub-items must not have an answer key/.test(e)));
});

test('validateNc55Structure flags an mcq answer outside its option domain', () => {
  const rows = nc55Items().map((i) => ({
    position: i.seq,
    label: i.label,
    item_type: i.itemType,
    option_count: i.optionCount,
    parent_question: i.parentQuestion,
    sub_label: i.subLabel,
    answer_key: i.itemType === 'mcq' ? (i.label === '34' ? 'Z' : i.options[0]) : null,
  }));
  const errors = validateNc55Structure(rows);
  assert.ok(errors.some((e) => /item 34: answer key "Z" is not one of/.test(e)));
});

test('validateNc55Structure flags a missing item', () => {
  const rows = nc55Items()
    .filter((i) => i.label !== '20')
    .map((i) => ({
      position: i.seq,
      label: i.label,
      item_type: i.itemType,
      option_count: i.optionCount,
      parent_question: i.parentQuestion,
      sub_label: i.subLabel,
      answer_key: i.itemType === 'mcq' ? i.options[0] : null,
    }));
  // Length is now 54, so the count check fires first — that's correct
  // behaviour (a precise count mismatch is more actionable than guessing
  // which single item is missing from a shifted list).
  const errors = validateNc55Structure(rows);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /expected exactly 55/);
});
