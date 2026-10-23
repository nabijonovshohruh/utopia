import { tx } from '../db/index.js';
import { getItems } from './tests.js';

const OMITTED = new Set(['-', '*', '.', '_', 'X?', '?']);

/**
 * Parses a student's answer message into N tokens.
 *
 * Accepts, in order of preference:
 *   "1A 2C 3B 4D"      numbered pairs (most robust — survives omissions)
 *   "1. A\n2) C"       numbered, one per line
 *   "A C B D"          delimited tokens in order
 *   "ACBD"             contiguous single letters
 *
 * "-" or "*" marks a deliberate omission (scored 0 but recorded as blank, so
 * omit-vs-wrong stays visible in the item diagnostics).
 */
export function parseAnswers(text, itemCount) {
  const clean = String(text).trim();
  if (!clean) return { answers: null, error: 'Empty message.' };

  // Numbered form. Detected structurally rather than by counting pairs: the
  // matches must tile the entire message (only separators may sit between
  // them) and every index must be in range. A pair count threshold would
  // reject legitimately partial sheets like "1A 3C" on a 4-item test.
  const numbered = [...clean.matchAll(/(\d+)\s*[.)\-:]?\s*([A-Za-z0-9\-*.?_]+)/g)];
  const looksNumbered =
    numbered.length > 0 &&
    tilesWholeString(clean, numbered) &&
    numbered.every((m) => Number(m[1]) >= 1 && Number(m[1]) <= itemCount);
  if (looksNumbered) {
    const answers = new Array(itemCount).fill(null);
    const dupes = [];
    for (const m of numbered) {
      const idx = Number(m[1]) - 1;
      if (answers[idx] !== null) dupes.push(Number(m[1]));
      answers[idx] = normalise(m[2]);
    }
    if (dupes.length) {
      return { answers: null, error: `Item(s) ${[...new Set(dupes)].join(', ')} answered more than once.` };
    }
    return { answers, error: null };
  }

  // Delimited tokens.
  const tokens = clean.split(/[\s,;|]+/).filter(Boolean);
  if (tokens.length === itemCount) {
    return { answers: tokens.map(normalise), error: null };
  }

  // Contiguous letters, e.g. "ABCDABCD".
  const letters = clean.replace(/[\s,;|]/g, '');
  if (/^[A-Za-z\-*.?_]+$/.test(letters) && letters.length === itemCount) {
    return { answers: [...letters].map(normalise), error: null };
  }

  const got = tokens.length === 1 ? letters.length : tokens.length;
  return {
    answers: null,
    error:
      `Expected ${itemCount} answers but read ${got}. Send them as "ABCD…", ` +
      `as "A B C D", or numbered as "1A 2C 3B" (use "-" to skip an item).`,
  };
}

/**
 * True when `matches` cover all of `text` apart from separator characters.
 * Linear scan — deliberately not a nested-quantifier regex, which could
 * backtrack badly on a hostile 4 KB message.
 */
function tilesWholeString(text, matches) {
  const SEPARATORS = /[^\s,;|]/;
  let cursor = 0;
  for (const m of matches) {
    if (SEPARATORS.test(text.slice(cursor, m.index))) return false;
    cursor = m.index + m[0].length;
  }
  return !SEPARATORS.test(text.slice(cursor));
}

function normalise(token) {
  const t = String(token).trim().toUpperCase();
  return OMITTED.has(t) ? null : t;
}

/** Scores a single answer against a key. Omissions are incorrect, not errors. */
export function isCorrect(given, key) {
  if (given === null || given === undefined || given === '') return 0;
  return String(given).trim().toUpperCase() === String(key).trim().toUpperCase() ? 1 : 0;
}

/**
 * Records a submission and its per-item correctness.
 * Correctness is pure key-matching; the Rasch pass happens separately in
 * scoring.js so that re-scoring never has to re-interpret raw text.
 *
 * Positional — assumes every item is mcq, answered in item order. This is
 * the original path, still used for 'custom' template tests (e.g. the
 * DEMO-101 quiz). Templates with a written item need recordSubmissionByLabel
 * instead, since "the 37th item" isn't a stable way to address something a
 * teacher grades later by hand.
 */
export function recordSubmission(db, { testId, studentId, rawInput, answers }) {
  const items = getItems(db, testId);
  if (answers.length !== items.length) {
    throw new Error(`answer count ${answers.length} != item count ${items.length}`);
  }

  return tx(db, () => {
    const info = db
      .prepare('INSERT INTO submissions (test_id, student_id, raw_input) VALUES (?, ?, ?)')
      .run(testId, studentId, rawInput);
    const submissionId = Number(info.lastInsertRowid);

    const ins = db.prepare(
      'INSERT INTO responses (submission_id, item_id, given, correct) VALUES (?, ?, ?, ?)',
    );
    for (let i = 0; i < items.length; i++) {
      ins.run(submissionId, items[i].id, answers[i], isCorrect(answers[i], items[i].answer_key));
    }
    return submissionId;
  });
}

/**
 * Records a submission keyed by item label rather than position — the
 * general path, used for the NC55 template (and by the Mini App, and by
 * parseLabeledAnswers' chat fallback below).
 *
 * mcq items are auto-graded by key match, same as always. Written items are
 * stored with correct = NULL ("submitted, not yet graded") — there is no key
 * to match free text against, so a teacher must grade each sub-item by hand
 * (see scoring.js gradeWrittenResponses) before this submission can be
 * Rasch-scored.
 *
 * @param {Record<string, string|null>} answersByLabel
 */
export function recordSubmissionByLabel(db, { testId, studentId, rawInput, answersByLabel, source = 'chat' }) {
  const items = getItems(db, testId);

  return tx(db, () => {
    const info = db
      .prepare('INSERT INTO submissions (test_id, student_id, raw_input, source) VALUES (?, ?, ?, ?)')
      .run(testId, studentId, rawInput, source);
    const submissionId = Number(info.lastInsertRowid);

    const ins = db.prepare(
      'INSERT INTO responses (submission_id, item_id, given, correct) VALUES (?, ?, ?, ?)',
    );
    for (const item of items) {
      const given = answersByLabel[item.label] ?? null;
      const correct = item.item_type === 'written' ? null : isCorrect(given, item.answer_key);
      ins.run(submissionId, item.id, given, correct);
    }
    return submissionId;
  });
}

function normaliseLabel(raw) {
  return /[a-bA-B]$/.test(raw) ? raw.slice(0, -1) + raw.slice(-1).toLowerCase() : raw;
}

/**
 * Chat fallback for heterogeneous (NC55-shaped) tests, for when the Mini
 * App isn't configured or a student simply prefers typing.
 *
 * mcq items (1-35) may be answered compactly on one line, same style as the
 * plain parseAnswers(): "1A 2B 3C ... 35F". Written sub-items (36a-45b)
 * can't be compacted the same way — their answer is free text, not a single
 * letter — so each gets its own line: "36a: <free text>" (the separator and
 * even the colon are optional; everything after the label is taken
 * verbatim). The two styles may be freely mixed across lines in one
 * message. Items left unmentioned are recorded as omitted (given = null),
 * same convention as "-" in the plain parser.
 *
 * @param {Array} items  this test's items (from getItems), used to know
 *   which labels exist and whether each is mcq or written.
 */
export function parseLabeledAnswers(text, items) {
  const byLabel = new Map(items.map((i) => [i.label, i]));
  const answers = {};
  const errors = [];
  const seen = new Set();

  const lines = String(text)
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return { answers: null, error: 'Empty message.' };

  for (const line of lines) {
    // Compact mcq pairs on one line: "1A 2B 3C ... 35F".
    const pairs = [...line.matchAll(/(\d{1,2})\s*[.)\-:=]?\s*([A-Za-z\-*.?_])(?![A-Za-z0-9])/g)];
    const allPlainMcq = pairs.length > 0 && pairs.every((m) => byLabel.get(m[1])?.item_type === 'mcq');
    if (allPlainMcq && tilesWholeString(line, pairs)) {
      for (const m of pairs) {
        const label = m[1];
        if (seen.has(label)) errors.push(`Item ${label} answered more than once.`);
        seen.add(label);
        answers[label] = normalise(m[2]);
      }
      continue;
    }

    // One item per line: "<label><separator><value>". Value is a single
    // letter for mcq, or free text (possibly containing its own punctuation)
    // for written — captured greedily so embedded colons/dashes survive.
    const single = line.match(/^(\d{1,2}[a-bA-B]?)\s*[:=\-.)]?\s*(.*)$/);
    const label = single ? normaliseLabel(single[1]) : null;
    const item = label ? byLabel.get(label) : null;
    if (single && item) {
      if (seen.has(label)) {
        errors.push(`Item ${label} answered more than once.`);
        continue;
      }
      seen.add(label);
      const value = single[2].trim();
      answers[label] = item.item_type === 'written' ? value || null : normalise(value);
      continue;
    }

    errors.push(`Could not read this line as an answer: "${line}"`);
  }

  if (errors.length) return { answers: null, error: errors.join(' ') };

  for (const item of items) {
    if (!(item.label in answers)) answers[item.label] = null;
  }
  return { answers, error: null };
}

export function getOrCreateStudent(db, from) {
  const fullName = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Student';
  db.prepare(
    `INSERT INTO students (telegram_id, username, full_name) VALUES (?, ?, ?)
     ON CONFLICT(telegram_id) DO UPDATE SET username = excluded.username, full_name = excluded.full_name`,
  ).run(from.id, from.username ?? null, fullName);
  return db.prepare('SELECT * FROM students WHERE telegram_id = ?').get(from.id);
}

export function setActiveTest(db, studentId, testId) {
  db.prepare('UPDATE students SET active_test_id = ? WHERE id = ?').run(testId, studentId);
}

export function latestSubmission(db, studentId, testId) {
  return (
    db
      .prepare(
        'SELECT * FROM submissions WHERE student_id = ? AND test_id = ? ORDER BY id DESC LIMIT 1',
      )
      .get(studentId, testId) ?? null
  );
}

export function hasSubmitted(db, studentId, testId) {
  return Boolean(latestSubmission(db, studentId, testId));
}
