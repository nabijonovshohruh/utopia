import { scoreResponses, itemDiagnostics, personFit, buildScoreTable } from './rasch.js';
import { anchorChecksum, getItems, getBands, getTestByCode, scaleOf } from './tests.js';
import { tx } from '../db/index.js';

/**
 * Loads the frozen calibration constants for a locked test and verifies they
 * still match the checksum recorded at lock time.
 *
 * This is the gate between storage and the measurement engine. If anything
 * about the anchors or the reporting transform has changed since the test was
 * locked, scoring aborts rather than quietly issuing scores on a different
 * scale from the ones already in students' hands.
 */
export function loadAnchors(db, test) {
  if (test.status !== 'locked') {
    throw new Error(
      `Test ${test.code} is a ${test.status}, not locked. Anchors must be frozen with /lock before scoring.`,
    );
  }
  const items = getItems(db, test.id);
  if (items.some((i) => i.b_logit === null)) {
    throw new Error(`Test ${test.code} has unanchored items; refusing to score.`);
  }

  const checksum = anchorChecksum(items, test);
  if (checksum !== test.anchor_checksum) {
    throw new Error(
      `ANCHOR INTEGRITY FAILURE on ${test.code}: expected ${test.anchor_checksum}, computed ${checksum}. ` +
        'The frozen item difficulties or score transform were altered. Scoring is blocked.',
    );
  }

  return {
    items,
    b: items.map((i) => i.b_logit),
    scale: scaleOf(test),
    bands: getBands(db, test.id),
    checksum,
  };
}

/** Number of responses on a submission still waiting on a teacher's grade. */
export function ungradedCount(db, submissionId) {
  return db
    .prepare('SELECT COUNT(*) c FROM responses WHERE submission_id = ? AND correct IS NULL')
    .get(submissionId).c;
}

/**
 * Scores one submission and writes an immutable result row.
 *
 * Idempotent: a submission that already has a result returns it untouched.
 * Re-running the grader over the whole history is therefore safe and is a
 * no-op on already-issued scores.
 *
 * Refuses to run while any response is ungraded (correct IS NULL) — a
 * written sub-item nobody has read yet. Scoring an incomplete response
 * vector would quietly treat "not graded" as "wrong," which is a different
 * claim than anyone intended to make.
 */
export function scoreSubmission(db, submissionId, { verifiedBy = null, method = 'wle' } = {}) {
  const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId);
  if (!sub) throw new Error(`No submission #${submissionId}`);

  const existing = db.prepare('SELECT * FROM results WHERE submission_id = ?').get(submissionId);
  if (existing) return { result: existing, alreadyScored: true };

  const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(sub.test_id);
  const { items, b, scale, bands, checksum } = loadAnchors(db, test);

  const rows = db.prepare('SELECT item_id, correct FROM responses WHERE submission_id = ?').all(submissionId);
  const ungraded = rows.filter((r) => r.correct === null).length;
  if (ungraded > 0) {
    throw new Error(
      `Submission #${submissionId} has ${ungraded} ungraded written response(s). Grade them ` +
        `(see /writing ${submissionId}) before this can be Rasch-scored.`,
    );
  }

  const byItem = new Map(rows.map((r) => [r.item_id, r.correct]));
  const responses = items.map((i) => byItem.get(i.id) ?? 0);

  const scored = scoreResponses(responses, b, scale, bands, { method });

  db.prepare(
    `INSERT INTO results (submission_id, raw_score, item_count, theta, se, scaled_score, grade,
                          scale_version, anchor_checksum, method, engine_version, verified_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    submissionId,
    scored.rawScore,
    scored.itemCount,
    scored.theta,
    scored.se,
    scored.scaledScore,
    scored.grade,
    test.scale_version,
    checksum,
    scored.method,
    scored.engineVersion,
    verifiedBy,
  );
  db.prepare("UPDATE submissions SET status = 'scored' WHERE id = ?").run(submissionId);

  return {
    result: db.prepare('SELECT * FROM results WHERE submission_id = ?').get(submissionId),
    scored,
    alreadyScored: false,
  };
}

/**
 * Grades every pending submission on a test that is actually ready
 * (fully graded). Submissions still waiting on written-item grading are
 * counted separately in `needsGrading`, not lumped into `errors` — that
 * distinction is what lets a UI say "N still need grading" instead of just
 * "N failed."
 */
export function scoreAllPending(db, code) {
  const test = getTestByCode(db, code);
  if (!test) throw new Error(`No test with code ${code}`);
  loadAnchors(db, test); // fail fast before touching any rows

  const pending = db
    .prepare(
      `SELECT s.id FROM submissions s
       LEFT JOIN results r ON r.submission_id = s.id
       WHERE s.test_id = ? AND r.id IS NULL AND s.status != 'rejected'
       ORDER BY s.id`,
    )
    .all(test.id);

  const errors = [];
  const scoredIds = [];
  let needsGrading = 0;
  for (const row of pending) {
    if (ungradedCount(db, row.id) > 0) {
      needsGrading++;
      continue;
    }
    try {
      scoreSubmission(db, row.id);
      scoredIds.push(row.id);
    } catch (err) {
      errors.push(`#${row.id}: ${err.message}`);
    }
  }
  return { scored: scoredIds.length, scoredIds, total: pending.length, needsGrading, errors };
}

/**
 * The teacher's "Calculate & Publish Results" action: scores every
 * fully-graded pending submission on a test in one batch and returns
 * everything needed to notify each newly-scored student.
 *
 * Refuses outright if any submission still needs written-item grading —
 * publishing is all-or-nothing by design (partial publishing would mean two
 * students who submitted identical answers could end up notified at
 * different times with no record of why, which is confusing for no benefit
 * here: grading the last few ungraded answers is cheap, and "everyone finds
 * out together" is the actual requirement).
 */
export function publishResults(db, code) {
  const status = testStatusCounts(db, code);
  if (status.needsGrading > 0) {
    throw new Error(
      `${status.needsGrading} submission(s) still have ungraded written answers — grade them first ` +
        '(see /pending). Publishing scores the whole batch at once, not partially.',
    );
  }

  const result = scoreAllPending(db, code);
  if (!result.scoredIds.length) return { ...result, notifications: [] };

  const placeholders = result.scoredIds.map(() => '?').join(',');
  const notifications = db
    .prepare(
      `SELECT r.submission_id, st.telegram_id, t.title, r.raw_score, r.item_count, r.scaled_score, r.grade
       FROM results r
       JOIN submissions s ON s.id = r.submission_id
       JOIN students st   ON st.id = s.student_id
       JOIN tests t       ON t.id = s.test_id
       WHERE r.submission_id IN (${placeholders})`,
    )
    .all(...result.scoredIds);
  return { ...result, notifications };
}

/**
 * Applies a teacher's manual 0/1 grades to a submission's written
 * sub-items. Refuses once the submission has already been scored — the
 * issued result reflects the responses as they stood at scoring time, and
 * silently changing one afterward would make the two inconsistent with no
 * record of it. A genuine post-hoc correction is an out-of-band operator
 * decision, not something this grades through.
 *
 * @param {Record<string, 0|1|'0'|'1'>} scoresByLabel  e.g. { '36a': 1, '36b': 0 }
 */
export function gradeWrittenResponses(db, submissionId, scoresByLabel, graderId) {
  const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId);
  if (!sub) throw new Error(`No submission #${submissionId}`);
  if (db.prepare('SELECT 1 FROM results WHERE submission_id = ?').get(submissionId)) {
    throw new Error(`#${submissionId} has already been scored; its responses cannot be re-graded.`);
  }

  const items = db
    .prepare(
      `SELECT i.id, i.label, i.item_type FROM responses r
       JOIN items i ON i.id = r.item_id WHERE r.submission_id = ?`,
    )
    .all(submissionId);
  const byLabel = new Map(items.map((i) => [i.label, i]));

  const applied = [];
  const errors = [];
  for (const [label, rawScore] of Object.entries(scoresByLabel)) {
    const item = byLabel.get(label);
    if (!item) {
      errors.push(`${label}: not an item on this submission`);
      continue;
    }
    if (item.item_type !== 'written') {
      errors.push(`${label}: is not a written item (it's auto-graded)`);
      continue;
    }
    const score = Number(rawScore);
    if (score !== 0 && score !== 1) {
      errors.push(`${label}: score must be 0 or 1, got "${rawScore}"`);
      continue;
    }
    applied.push({ itemId: item.id, label, score });
  }
  if (errors.length) throw new Error(`Grading rejected: ${errors.join('; ')}`);

  tx(db, () => {
    const upd = db.prepare(
      "UPDATE responses SET correct = ?, graded_by = ?, graded_at = datetime('now') WHERE submission_id = ? AND item_id = ?",
    );
    for (const a of applied) upd.run(a.score, graderId, submissionId, a.itemId);
  });

  return { gradedLabels: applied.map((a) => a.label), remaining: ungradedCount(db, submissionId) };
}

/** The written sub-items on a submission, with the student's free text and current grade (if any). */
export function writtenResponsesFor(db, submissionId) {
  return db
    .prepare(
      `SELECT i.label, i.parent_question, i.sub_label, r.given, r.correct
       FROM responses r JOIN items i ON i.id = r.item_id
       WHERE r.submission_id = ? AND i.item_type = 'written'
       ORDER BY i.position`,
    )
    .all(submissionId);
}

/** Submissions on a test that still have at least one ungraded written response. */
export function listNeedingGrading(db, code) {
  const test = getTestByCode(db, code);
  if (!test) throw new Error(`No test with code ${code}`);
  return db
    .prepare(
      `SELECT s.id, st.full_name, st.username,
              (SELECT COUNT(*) FROM responses WHERE submission_id = s.id AND correct IS NULL) AS ungraded
       FROM submissions s
       JOIN students st ON st.id = s.student_id
       LEFT JOIN results r ON r.submission_id = s.id
       WHERE s.test_id = ? AND r.id IS NULL AND s.status != 'rejected'
         AND EXISTS (SELECT 1 FROM responses WHERE submission_id = s.id AND correct IS NULL)
       ORDER BY s.id`,
    )
    .all(test.id);
}

/** Submission-count breakdown for a test: submitted / needs grading / ready to score / scored. */
export function testStatusCounts(db, code) {
  const test = getTestByCode(db, code);
  if (!test) throw new Error(`No test with code ${code}`);
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS submitted,
         SUM(CASE WHEN r.id IS NOT NULL THEN 1 ELSE 0 END) AS scored,
         SUM(CASE WHEN r.id IS NULL AND EXISTS (
               SELECT 1 FROM responses WHERE submission_id = s.id AND correct IS NULL
             ) THEN 1 ELSE 0 END) AS needsGrading,
         SUM(CASE WHEN r.id IS NULL AND NOT EXISTS (
               SELECT 1 FROM responses WHERE submission_id = s.id AND correct IS NULL
             ) THEN 1 ELSE 0 END) AS readyToScore
       FROM submissions s
       LEFT JOIN results r ON r.submission_id = s.id
       WHERE s.test_id = ? AND s.status != 'rejected'`,
    )
    .get(test.id);
  return {
    test,
    submitted: row.submitted,
    scored: row.scored ?? 0,
    needsGrading: row.needsGrading ?? 0,
    readyToScore: row.readyToScore ?? 0,
  };
}

export function getResultBundle(db, submissionId) {
  return (
    db
      .prepare(
        `SELECT r.*, s.submitted_at, s.status AS submission_status, t.code, t.title,
                t.scale_slope, st.full_name, st.telegram_id
         FROM results r
         JOIN submissions s ON s.id = r.submission_id
         JOIN tests t       ON t.id = s.test_id
         JOIN students st   ON st.id = s.student_id
         WHERE r.submission_id = ?`,
      )
      .get(submissionId) ?? null
  );
}

export function listResults(db, code, limit = 50) {
  const test = getTestByCode(db, code);
  if (!test) throw new Error(`No test with code ${code}`);
  return db
    .prepare(
      `SELECT r.raw_score, r.theta, r.scaled_score, r.grade, r.submission_id,
              st.full_name, st.username, st.telegram_id
       FROM results r
       JOIN submissions s ON s.id = r.submission_id
       JOIN students st   ON st.id = s.student_id
       WHERE s.test_id = ?
       ORDER BY r.scaled_score DESC, st.full_name
       LIMIT ?`,
    )
    .all(test.id, limit);
}

export function listPending(db, limit = 30) {
  return db
    .prepare(
      `SELECT s.id, s.submitted_at, t.code, st.full_name, st.username,
              (SELECT COUNT(*) FROM responses WHERE submission_id = s.id AND correct = 1) AS raw_score,
              (SELECT COUNT(*) FROM responses WHERE submission_id = s.id AND correct IS NULL) AS ungraded,
              (SELECT COUNT(*) FROM items WHERE test_id = t.id) AS item_count
       FROM submissions s
       JOIN tests t     ON t.id = s.test_id
       JOIN students st ON st.id = s.student_id
       LEFT JOIN results r ON r.submission_id = s.id
       WHERE r.id IS NULL AND s.status != 'rejected'
       ORDER BY s.id
       LIMIT ?`,
    )
    .all(limit);
}

/**
 * Cohort-level anchor health report.
 * Read-only by construction: it computes what the data would do to the
 * anchors, and writes nothing. Acting on it requires a human and a new test.
 */
export function anchorDriftReport(db, code) {
  const test = getTestByCode(db, code);
  if (!test) throw new Error(`No test with code ${code}`);
  const { items, b } = loadAnchors(db, test);

  const subs = db
    .prepare(
      `SELECT s.id FROM submissions s
       JOIN results r ON r.submission_id = s.id
       WHERE s.test_id = ? ORDER BY s.id`,
    )
    .all(test.id);
  if (subs.length < 10) {
    throw new Error(`Only ${subs.length} scored submission(s) on ${code}; need 10+ for a drift report.`);
  }

  const byItem = new Map(items.map((it, idx) => [it.id, idx]));
  const matrix = subs.map((sub) => {
    const row = new Array(items.length).fill(0);
    for (const r of db.prepare('SELECT item_id, correct FROM responses WHERE submission_id = ?').all(sub.id)) {
      const idx = byItem.get(r.item_id);
      if (idx !== undefined) row[idx] = r.correct;
    }
    return row;
  });

  const diagnostics = itemDiagnostics(matrix, b);
  const mean = db
    .prepare(
      `SELECT AVG(r.theta) AS mean_theta, AVG(r.scaled_score) AS mean_scaled, COUNT(*) AS n
       FROM results r JOIN submissions s ON s.id = r.submission_id WHERE s.test_id = ?`,
    )
    .get(test.id);

  return { test, diagnostics, cohort: mean, sampleSize: subs.length };
}

export function scoreTableFor(db, code) {
  const test = getTestByCode(db, code);
  if (!test) throw new Error(`No test with code ${code}`);
  const { b, scale, bands } = loadAnchors(db, test);
  return { test, table: buildScoreTable(b, scale, bands) };
}

export function submissionFit(db, submissionId) {
  const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId);
  if (!sub) throw new Error(`No submission #${submissionId}`);
  const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(sub.test_id);
  const { items, b } = loadAnchors(db, test);
  const byItem = new Map(
    db
      .prepare('SELECT item_id, correct FROM responses WHERE submission_id = ?')
      .all(submissionId)
      .map((r) => [r.item_id, r.correct]),
  );
  return personFit(items.map((i) => byItem.get(i.id) ?? 0), b);
}
