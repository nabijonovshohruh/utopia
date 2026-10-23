/**
 * Creates a locked demo test so you can exercise the bot immediately.
 *   npm run seed
 */

import { openDb } from '../db/index.js';
import { config } from '../config.js';
import { parseAnswerKey, upsertDraftTest, lockTest, getTestByCode } from '../services/tests.js';
import { scoreTableFor } from '../services/scoring.js';

const KEYS = ['A', 'B', 'C', 'D'];
const N = 20;

// A realistic spread of anchored difficulties, easiest first.
const anchors = [
  -2.4, -2.0, -1.7, -1.4, -1.1, -0.9, -0.6, -0.4, -0.2, 0.0,
  0.2, 0.4, 0.7, 0.9, 1.1, 1.4, 1.7, 2.0, 2.3, 2.7,
];

const keyText = [
  'CODE: DEMO-101',
  'TITLE: Demo Placement Test',
  'SCALE: 500 + 50*theta',
  'RANGE: 200..800',
  'GRADES: A+>=700, A>=640, B+>=580, B>=520, C>=460, NC>=0',
  'ITEMS:',
  ...anchors.map((b, i) => `${i + 1} ${KEYS[(i * 3) % 4]} ${b}`),
].join('\n');

const db = openDb(config.dbPath);

if (getTestByCode(db, 'DEMO-101')) {
  console.log('DEMO-101 already exists — nothing to do.');
} else {
  const parsed = parseAnswerKey(keyText);
  if (parsed.errors.length) {
    console.error('Seed key failed to parse:', parsed.errors);
    process.exit(1);
  }
  upsertDraftTest(db, parsed, config.adminIds[0] ?? 0);
  const test = lockTest(db, 'DEMO-101');
  console.log(`Seeded and locked DEMO-101 (${N} items)`);
  console.log(`Anchor fingerprint: ${test.anchor_checksum}`);
}

const { table } = scoreTableFor(db, 'DEMO-101');
console.log('\nraw  theta  scaled  level');
for (const r of table) {
  console.log(
    `${String(r.rawScore).padStart(3)}  ${(r.theta >= 0 ? '+' : '') + r.theta.toFixed(2)}` +
      `  ${String(r.scaledScore).padStart(5)}  ${r.grade}`,
  );
}
console.log('\nStudents can now send:  /test DEMO-101');
db.close();
