import crypto from 'node:crypto';
import { tx } from '../db/index.js';
import { DEFAULT_GRADE_BANDS, calibrateAnchors } from './rasch.js';
import { NC55_TEMPLATE, NC55_ITEM_COUNT, labelToSeq, optionsForSeq, validateNc55Structure } from '../domain/nc55.js';

/**
 * Canonical fingerprint of a test's frozen calibration constants.
 * Stored at lock time and re-verified on every scoring run, so a tampered
 * anchor can never silently produce scores on a different scale.
 */
export function anchorChecksum(items, scale) {
  const payload = JSON.stringify({
    items: items.map((i) => [
      i.position,
      i.item_type,
      i.answer_key ? i.answer_key.toUpperCase() : null, // null for written sub-items
      Number(i.b_logit.toFixed(4)),
    ]),
    scale: [scale.scale_intercept, scale.scale_slope, scale.scale_min, scale.scale_max],
  });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

/**
 * Generates a test code the operator didn't supply themselves, e.g.
 * "TEST-5501". Retries on collision; a timestamp-based fallback makes it
 * impossible to loop forever even in a pathological case.
 */
export function generateUniqueCode(db, prefix = 'TEST') {
  for (let attempt = 0; attempt < 30; attempt++) {
    const n = 1000 + Math.floor(Math.random() * 9000);
    const code = `${prefix}-${n}`;
    if (!getTestByCode(db, code)) return code;
  }
  return `${prefix}-${Date.now().toString(36).toUpperCase()}`;
}

/* ------------------------------------------------------------------ */
/* Answer-key parsing                                                  */
/* ------------------------------------------------------------------ */

/**
 * Parses an answer-key document. Two shapes:
 *
 * Plain (default, 'custom' template — arbitrary item count/shape):
 *
 *   CODE: MATH-2026-A
 *   TITLE: Mathematics Midterm
 *   SCALE: 500 + 50*theta
 *   RANGE: 200..800
 *   GRADES: A+>=700, A>=640, B+>=580, B>=520, C>=460, NC>=0
 *   ITEMS:
 *   1  A  -2.10
 *   2  C  -1.45
 *   3  B
 *
 * National Certificate (TEMPLATE: NC55 — the fixed 55-item structure from
 * src/domain/nc55.js: 1-32 are 4-option mcq, 33-35 are 6-option mcq, 36-45
 * are written questions split into independent "a"/"b" sub-items):
 *
 *   TEMPLATE: NC55
 *   CODE: TEST-5501          (optional — auto-generated if omitted)
 *   TITLE: National Certificate 2026
 *   ITEMS:
 *   1  A  -2.10
 *   ...
 *   33 E  -0.50
 *   36a -1.00
 *   36b -0.80
 *   ...
 *   45b  1.80
 *
 * Written lines carry no answer letter — there is nothing to key-match
 * against free text. A teacher grades each sub-item 0/1 by hand after
 * submissions come in (see scoring.js gradeWrittenResponses), and the
 * anchored b-value is still required before the test can be locked, same
 * as any other item.
 *
 * The third column (difficulty, in logits) may be omitted on either shape
 * only if you intend to run /calibrate on a pilot cohort — the test cannot
 * be locked (and so cannot score anyone) while any anchor is missing.
 */
export function parseAnswerKey(text) {
  const meta = {
    code: null,
    title: null,
    template: 'custom',
    scale_intercept: 500,
    scale_slope: 50,
    scale_min: 200,
    scale_max: 800,
  };
  let bands = null;
  const items = [];
  const errors = [];
  let inItems = false;

  // TEMPLATE governs how item lines are parsed, so resolve it before the
  // main pass regardless of where in the document it appears.
  const templateMatch = text.match(/^\s*TEMPLATE\s*:\s*(\S+)/im);
  if (templateMatch) {
    const value = templateMatch[1].toUpperCase();
    if (value === NC55_TEMPLATE.toUpperCase()) meta.template = NC55_TEMPLATE;
    else errors.push(`unknown TEMPLATE "${templateMatch[1]}" (expected NC55, or omit for a custom test)`);
  }

  const lines = text.split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln].trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;

    const header = line.match(/^(CODE|TITLE|TEMPLATE|SCALE|RANGE|GRADES|ITEMS)\s*:\s*(.*)$/i);
    if (header) {
      const field = header[1].toUpperCase();
      const value = header[2].trim();
      if (field === 'ITEMS') {
        inItems = true;
        if (value) parseItemLine(value, ln, meta.template, items, errors);
        continue;
      }
      inItems = false;
      if (field === 'TEMPLATE') continue; // already resolved above
      if (field === 'CODE') meta.code = value.toUpperCase();
      else if (field === 'TITLE') meta.title = value;
      else if (field === 'SCALE') {
        // "500 + 50*theta"
        const m = value.match(/^(-?[\d.]+)\s*\+\s*(-?[\d.]+)\s*\*?\s*theta$/i);
        if (!m) errors.push(`line ${ln + 1}: SCALE must look like "500 + 50*theta"`);
        else {
          meta.scale_intercept = Number(m[1]);
          meta.scale_slope = Number(m[2]);
        }
      } else if (field === 'RANGE') {
        const m = value.match(/^(-?\d+)\s*\.\.\s*(-?\d+)$/);
        if (!m) errors.push(`line ${ln + 1}: RANGE must look like "200..800"`);
        else {
          meta.scale_min = Number(m[1]);
          meta.scale_max = Number(m[2]);
        }
      } else if (field === 'GRADES') {
        bands = [];
        for (const part of value.split(',')) {
          const m = part.trim().match(/^(\S+)\s*>=\s*(-?\d+)$/);
          if (!m) errors.push(`line ${ln + 1}: bad grade band "${part.trim()}" (expected "A+>=700")`);
          else bands.push({ label: m[1], minScaled: Number(m[2]) });
        }
      }
      continue;
    }

    if (inItems) parseItemLine(line, ln, meta.template, items, errors);
    else errors.push(`line ${ln + 1}: unexpected content "${line}"`);
  }

  if (!meta.title) errors.push('missing TITLE:');
  if (!items.length) errors.push('no items found — did you forget the ITEMS: header?');
  if (meta.scale_slope === 0) errors.push('SCALE slope cannot be 0');

  // Duplicate positions (same label uploaded twice) must be caught here,
  // before anything downstream collapses them into a Map and silently
  // drops one — which would otherwise look like a perfectly valid,
  // shorter item set.
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.position)) errors.push(`duplicate item ${item.label}`);
    seen.add(item.position);
  }

  if (meta.template === NC55_TEMPLATE) {
    // Position numbering is derived from the label via a fixed formula, not
    // from upload order, so "must run 1..N with no gaps" doesn't apply the
    // way it does for a custom test — validateNc55Structure gives much more
    // specific feedback (which exact item is missing, wrong type, etc.).
    // Only run it once positions are actually unique, or a dropped
    // duplicate could masquerade as a missing item and confuse the report.
    if (seen.size === items.length) {
      errors.push(...validateNc55Structure(toStructureRows(items)));
    }
  } else {
    for (let i = 1; i <= items.length; i++) {
      if (!seen.has(i)) errors.push(`item numbers must run 1..${items.length} with no gaps (missing ${i})`);
    }
  }

  items.sort((a, b) => a.position - b.position);
  return { meta, bands: bands ?? DEFAULT_GRADE_BANDS, items, errors };
}

function toStructureRows(items) {
  return items.map((i) => ({
    position: i.position,
    label: i.label,
    item_type: i.item_type,
    option_count: i.option_count,
    parent_question: i.parent_question,
    sub_label: i.sub_label,
    answer_key: i.answer_key,
  }));
}

function parseItemLine(line, ln, template, items, errors) {
  if (template === NC55_TEMPLATE) return parseNc55ItemLine(line, ln, items, errors);

  // "12. A -1.25" / "12) A" / "12 A -1.25" / "12,A,-1.25"
  const m = line.match(/^(\d+)\s*[.)\-,:]?\s+(\S+?),?\s*(-?\d+(?:\.\d+)?)?$/);
  if (!m) {
    errors.push(`line ${ln + 1}: cannot parse item "${line}" (expected "1 A -2.10")`);
    return;
  }
  const b = m[3] === undefined ? null : Number(m[3]);
  if (b !== null && Math.abs(b) > 6) {
    errors.push(`line ${ln + 1}: difficulty ${b} is outside the plausible -6..6 logit range`);
    return;
  }
  items.push({
    position: Number(m[1]),
    label: m[1],
    answer_key: m[2].toUpperCase(),
    b_logit: b,
    item_type: 'mcq',
    option_count: null,
    parent_question: null,
    sub_label: null,
  });
}

function parseNc55ItemLine(line, ln, items, errors) {
  const b_logitFrom = (token) => {
    if (token === undefined) return null;
    const b = Number(token);
    return Math.abs(b) > 6 ? NaN : b; // NaN signals "out of range", checked below
  };

  // Written sub-item: "36a" or "36a -1.00" — no answer letter. Correctness
  // for free text can't be key-matched; a teacher grades it by hand later.
  const written = line.match(/^(\d{1,2}[aAbB])\s*[.)\-,:]?\s*(-?\d+(?:\.\d+)?)?$/);
  if (written) {
    const label = written[1].toLowerCase();
    const seq = labelToSeq(label);
    if (seq === null) {
      errors.push(`line ${ln + 1}: "${written[1]}" is not a valid NC55 written item (expected 36a..45b)`);
      return;
    }
    const b = b_logitFrom(written[2]);
    if (Number.isNaN(b)) {
      errors.push(`line ${ln + 1}: difficulty ${written[2]} is outside the plausible -6..6 logit range`);
      return;
    }
    items.push({
      position: seq,
      label,
      answer_key: null,
      b_logit: b,
      item_type: 'written',
      option_count: null,
      parent_question: Number(label.slice(0, -1)),
      sub_label: label.slice(-1),
    });
    return;
  }

  // mcq line: answer letter must fall within this item's fixed domain
  // (A-D for 1-32, A-F for 33-35).
  const mcq = line.match(/^(\d{1,2})\s*[.)\-,:]?\s+(\S+?),?\s*(-?\d+(?:\.\d+)?)?$/);
  if (mcq) {
    const label = mcq[1];
    const seq = labelToSeq(label);
    const options = seq === null ? null : optionsForSeq(seq);
    if (seq === null || options === null) {
      errors.push(`line ${ln + 1}: "${label}" is not a valid NC55 multiple-choice item (expected 1..35)`);
      return;
    }
    const key = mcq[2].toUpperCase();
    if (!options.includes(key)) {
      errors.push(`line ${ln + 1}: item ${label} answer "${mcq[2]}" is not one of ${options.join('')}`);
      return;
    }
    const b = b_logitFrom(mcq[3]);
    if (Number.isNaN(b)) {
      errors.push(`line ${ln + 1}: difficulty ${mcq[3]} is outside the plausible -6..6 logit range`);
      return;
    }
    items.push({
      position: seq,
      label,
      answer_key: key,
      b_logit: b,
      item_type: 'mcq',
      option_count: options.length,
      parent_question: null,
      sub_label: null,
    });
    return;
  }

  // A written label that someone also gave an answer letter to, e.g.
  // "36a A -1.00" — common mistake, worth a specific message rather than
  // the generic parse failure below.
  const writtenWithKey = line.match(/^(\d{1,2}[aAbB])\s+(\S+)\s*(-?\d+(?:\.\d+)?)?$/);
  if (writtenWithKey && labelToSeq(writtenWithKey[1].toLowerCase()) !== null) {
    errors.push(
      `line ${ln + 1}: written sub-item "${writtenWithKey[1]}" must not have an answer key ` +
        `(got "${writtenWithKey[2]}") — it is graded manually from the student's free text`,
    );
    return;
  }

  errors.push(`line ${ln + 1}: cannot parse item "${line}" (expected "1 A -2.10" or "36a -1.00")`);
}

/* ------------------------------------------------------------------ */
/* Test lifecycle                                                      */
/* ------------------------------------------------------------------ */

/**
 * Creates or replaces a DRAFT test from a parsed key. Locked tests are
 * untouchable. If no CODE was given, one is generated (e.g. "TEST-5501").
 */
export function upsertDraftTest(db, parsed, createdBy) {
  const { meta, bands, items } = parsed;
  if (!meta.code) meta.code = generateUniqueCode(db);

  const existing = db.prepare('SELECT id, status FROM tests WHERE code = ?').get(meta.code);
  if (existing && existing.status === 'locked') {
    throw new Error(
      `Test ${meta.code} is locked and its anchors are frozen. Publish a new code (e.g. ${meta.code}-V2) instead of editing it.`,
    );
  }

  return tx(db, () => {
    let testId;
    if (existing) {
      db.prepare(
        `UPDATE tests SET title=?, template=?, scale_intercept=?, scale_slope=?, scale_min=?, scale_max=?,
                          anchor_source=?, anchor_checksum=NULL
         WHERE id=?`,
      ).run(
        meta.title,
        meta.template,
        meta.scale_intercept,
        meta.scale_slope,
        meta.scale_min,
        meta.scale_max,
        'manual',
        existing.id,
      );
      testId = existing.id;
      db.prepare('DELETE FROM items WHERE test_id = ?').run(testId);
      db.prepare('DELETE FROM grade_bands WHERE test_id = ?').run(testId);
    } else {
      const info = db
        .prepare(
          `INSERT INTO tests (code, title, template, scale_intercept, scale_slope, scale_min, scale_max,
                              anchor_source, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?)`,
        )
        .run(
          meta.code,
          meta.title,
          meta.template,
          meta.scale_intercept,
          meta.scale_slope,
          meta.scale_min,
          meta.scale_max,
          createdBy,
        );
      testId = Number(info.lastInsertRowid);
    }

    const insItem = db.prepare(
      `INSERT INTO items (test_id, position, label, item_type, option_count, answer_key,
                          parent_question, sub_label, b_logit, anchored)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    );
    for (const item of items) {
      insItem.run(
        testId,
        item.position,
        item.label,
        item.item_type,
        item.option_count,
        item.answer_key,
        item.parent_question,
        item.sub_label,
        item.b_logit,
      );
    }

    const insBand = db.prepare('INSERT INTO grade_bands (test_id, label, min_scaled) VALUES (?, ?, ?)');
    for (const band of bands) insBand.run(testId, band.label, band.minScaled);

    return getTestByCode(db, meta.code);
  });
}

export function getTestByCode(db, code) {
  return db.prepare('SELECT * FROM tests WHERE code = ?').get(String(code).toUpperCase()) ?? null;
}

export function getItems(db, testId) {
  return db.prepare('SELECT * FROM items WHERE test_id = ? ORDER BY position').all(testId);
}

export function getBands(db, testId) {
  return db
    .prepare('SELECT label, min_scaled AS minScaled FROM grade_bands WHERE test_id = ? ORDER BY min_scaled DESC')
    .all(testId);
}

export function scaleOf(test) {
  return {
    intercept: test.scale_intercept,
    slope: test.scale_slope,
    min: test.scale_min,
    max: test.scale_max,
  };
}

/**
 * Freezes a test: marks every anchor immutable, computes the checksum, and
 * flips status to 'locked'. After this, scoring is permitted and editing is
 * not. This is the single transition that guarantees scale stability.
 */
export function lockTest(db, code) {
  const test = getTestByCode(db, code);
  if (!test) throw new Error(`No test with code ${code}`);
  if (test.status === 'locked') throw new Error(`${code} is already locked`);

  const items = getItems(db, test.id);
  if (!items.length) throw new Error(`${code} has no items`);

  if (test.template === NC55_TEMPLATE) {
    const structureErrors = validateNc55Structure(items);
    if (structureErrors.length) {
      throw new Error(
        `Cannot lock ${code}: it does not conform to the NC55 template (${structureErrors.length} ` +
          `problem(s)):\n${structureErrors.slice(0, 10).join('\n')}` +
          (structureErrors.length > 10 ? `\n…and ${structureErrors.length - 10} more` : ''),
      );
    }
  }

  const missing = items.filter((i) => i.b_logit === null).map((i) => i.label);
  if (missing.length) {
    throw new Error(
      `Cannot lock ${code}: ${missing.length} item(s) have no anchored difficulty (${missing
        .slice(0, 10)
        .join(', ')}${missing.length > 10 ? '…' : ''}). ` +
        'Supply b-values in the key or run /calibrate with a pilot cohort first.',
    );
  }
  if (!getBands(db, test.id).length) throw new Error(`Cannot lock ${code}: no grade bands defined`);

  const checksum = anchorChecksum(items, test);
  return tx(db, () => {
    db.prepare('UPDATE items SET anchored = 1 WHERE test_id = ?').run(test.id);
    db.prepare(
      "UPDATE tests SET status='locked', anchor_checksum=?, locked_at=datetime('now') WHERE id=?",
    ).run(checksum, test.id);
    return getTestByCode(db, code);
  });
}

/**
 * One-time anchor calibration from the submissions already collected on a
 * DRAFT test (a pilot/field-trial cohort).
 *
 * This is the only path that writes b-values from data, it is manual, and it
 * is impossible on a locked test — the DB trigger would abort it even if this
 * guard were removed. After calibrating you still must /lock, which is what
 * makes the values permanent.
 *
 * For an nc55 test, only fully-graded responses (correct IS NOT NULL) are
 * usable — a written sub-item nobody has read yet contributes no
 * information and is treated as if it simply weren't part of the pilot
 * response for that item (no reasonable default exists for "unknown").
 */
export function calibrateFromPilot(db, code) {
  const test = getTestByCode(db, code);
  if (!test) throw new Error(`No test with code ${code}`);
  if (test.status === 'locked') {
    throw new Error(
      `${code} is locked. Re-calibrating a live test is exactly what causes score drift — ` +
        'publish a new test code instead.',
    );
  }

  const items = getItems(db, test.id);
  const subs = db
    .prepare("SELECT id FROM submissions WHERE test_id = ? AND status != 'rejected' ORDER BY id")
    .all(test.id);
  if (subs.length < 30) {
    throw new Error(
      `Only ${subs.length} pilot submission(s) on ${code}. Calibrating on a thin sample bakes ` +
        'noise into permanent anchors — collect at least 30 (200+ preferred).',
    );
  }

  const byItem = new Map(items.map((it, idx) => [it.id, idx]));
  const matrix = subs.map((sub) => {
    const row = new Array(items.length).fill(0);
    for (const r of db.prepare('SELECT item_id, correct FROM responses WHERE submission_id = ?').all(sub.id)) {
      const idx = byItem.get(r.item_id);
      if (idx !== undefined) row[idx] = r.correct ?? 0; // ungraded written -> treated as not-yet-correct for calibration only
    }
    return row;
  });

  const { b, iterations, converged, excludedItems } = calibrateAnchors(matrix);

  tx(db, () => {
    const upd = db.prepare('UPDATE items SET b_logit = ? WHERE id = ?');
    items.forEach((item, idx) => {
      if (b[idx] !== null) upd.run(b[idx], item.id);
    });
    db.prepare('UPDATE tests SET anchor_source = ? WHERE id = ?').run(`calibrated:${subs.length}`, test.id);
  });

  return {
    sampleSize: subs.length,
    iterations,
    converged,
    // Extreme items get no estimate; the operator must decide what to do.
    excludedLabels: excludedItems.map((j) => items[j].label),
  };
}
