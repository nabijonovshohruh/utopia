/**
 * Preflight check: verifies the environment is configured and the database is
 * usable, WITHOUT contacting Telegram.
 *
 *   npm run doctor
 *
 * Exits 0 when the bot is ready to start, 1 when something needs fixing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config, checkConfig } from '../config.js';
import { openDb } from '../db/index.js';

const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => console.log(`  FAIL  ${m}`);
const warn = (m) => console.log(`  warn  ${m}`);

const problems = [];

console.log('\nRasch Test Bot — configuration check\n');

/* --- .env file ----------------------------------------------------------- */
const envPath = path.resolve('.env');
if (fs.existsSync(envPath)) {
  ok(`.env found at ${envPath}`);
} else {
  bad('.env not found. Copy .env.example to .env and fill it in.');
  problems.push('missing .env');
}

// npm start runs `node --env-file=.env`, so an unset BOT_TOKEN here usually
// means doctor was invoked without that flag rather than a real config gap.
if (!process.env.BOT_TOKEN && !process.env.ADMIN_IDS) {
  warn('No env vars loaded — run this via "npm run doctor" so --env-file=.env applies.');
}

/* --- environment variables ---------------------------------------------- */
console.log('\nEnvironment');
const { errors, warnings } = checkConfig();
for (const e of errors) {
  bad(e);
  problems.push(e);
}
for (const w of warnings) warn(w);

if (!errors.length) {
  const [id, secret] = config.botToken.split(':');
  ok(`BOT_TOKEN looks valid (bot id ${id}, secret ${secret.slice(0, 4)}…${secret.slice(-2)})`);
  ok(`ADMIN_IDS parsed: ${config.adminIds.join(', ')} (${config.adminIds.length} admin(s))`);
}

/* --- database ------------------------------------------------------------ */
console.log('\nDatabase');
try {
  const dir = path.dirname(config.dbPath);
  const existed = fs.existsSync(config.dbPath);
  const db = openDb(config.dbPath);

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);
  const expected = ['tests', 'items', 'grade_bands', 'students', 'submissions', 'responses', 'results'];
  const missing = expected.filter((t) => !tables.includes(t));

  ok(`${existed ? 'Opened' : 'Created'} ${config.dbPath}`);
  ok(`Writable directory: ${dir}`);
  if (missing.length) {
    bad(`Schema incomplete, missing: ${missing.join(', ')}. Run: npm run migrate`);
    problems.push('incomplete schema');
  } else {
    ok(`Schema present (${tables.length} tables)`);
  }

  // Confirm the anchor-immutability trigger is actually installed — the whole
  // anti-deflation guarantee leans on it, and a hand-restored backup or a
  // partial migration can leave it missing.
  const triggers = db
    .prepare("SELECT name FROM sqlite_master WHERE type='trigger'")
    .all()
    .map((r) => r.name);
  if (triggers.includes('trg_items_anchor_frozen') && triggers.includes('trg_results_immutable')) {
    ok(`Anchor-immutability triggers installed (${triggers.length} total)`);
  } else {
    bad('Anchor-immutability triggers are MISSING. Scores would be editable. Run: npm run migrate');
    problems.push('missing triggers');
  }

  const counts = {
    tests: db.prepare('SELECT COUNT(*) c FROM tests').get().c,
    locked: db.prepare("SELECT COUNT(*) c FROM tests WHERE status='locked'").get().c,
    students: db.prepare('SELECT COUNT(*) c FROM students').get().c,
    submissions: db.prepare('SELECT COUNT(*) c FROM submissions').get().c,
    results: db.prepare('SELECT COUNT(*) c FROM results').get().c,
  };
  ok(
    `Contents: ${counts.tests} test(s) (${counts.locked} locked), ${counts.students} student(s), ` +
      `${counts.submissions} submission(s), ${counts.results} result(s)`,
  );
  if (counts.locked === 0) {
    warn('No locked tests yet — students have nothing to take. Try: npm run seed');
  }
  db.close();
} catch (err) {
  bad(`Cannot open the database: ${err.message}`);
  problems.push('database unusable');
}

/* --- runtime ------------------------------------------------------------- */
console.log('\nRuntime');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major > 22 || (major === 22 && minor >= 5)) {
  ok(`Node ${process.versions.node} (node:sqlite available)`);
} else {
  bad(`Node ${process.versions.node} is too old; node:sqlite needs >= 22.5.0.`);
  problems.push('node too old');
}

/* --- verdict ------------------------------------------------------------- */
console.log('');
if (problems.length === 0) {
  console.log('All checks passed. Start the bot with:  npm start\n');
  process.exit(0);
}
console.log(`${problems.length} problem(s) to fix before the bot will run:\n`);
problems.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
console.log('\nFix the items above, then re-run:  npm run doctor\n');
process.exit(1);
