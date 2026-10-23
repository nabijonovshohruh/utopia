/**
 * The fixed National Certificate 55-item test structure.
 *
 *   seq  1..32   mcq,  4 options (A-D)   — single choice
 *   seq 33..35   mcq,  6 options (A-F)   — expanded matching/choice
 *   seq 36..55   written, binary (0/1)   — ten questions (36..45), each
 *                                          split into independent sub-items
 *                                          "a" and "b"
 *
 * This is the single source of truth for the template: the answer-key
 * parser, the lock-time structure validator, and the Mini App's rendered
 * form (via GET /api/structure) all derive from the functions here, so
 * there is exactly one place that encodes "what a National Certificate test
 * looks like."
 *
 * `seq` is the item's position in the anchor vector (what rasch.js indexes
 * by); `label` is the human-facing identifier teachers and students see
 * ("1", "33", "36a"). The two are related by a fixed formula, not by
 * upload order, so a teacher's key is validated against this structure
 * rather than trusted to define it.
 */

export const NC55_TEMPLATE = 'nc55';
export const NC55_ITEM_COUNT = 55;

const MCQ4_LAST = 32;
const MCQ6_LAST = 35;
const WRITTEN_FIRST_Q = 36;
const WRITTEN_LAST_Q = 45;

/**
 * The National Certificate scaled-score ("ball") transform, used as the
 * default for an nc55 test when its key doesn't give an explicit SCALE:/
 * RANGE: header. A teacher who knows their own intended calibration can
 * still override both via the key, same as for a 'custom' test — this is
 * only the starting point, not a hard-coded ceiling on the architecture's
 * existing flexibility.
 */
export const NC55_DEFAULT_SCALE = {
  scale_intercept: 50,
  scale_slope: 10,
  scale_min: 0,
  scale_max: 100,
};

/**
 * The fixed National Certificate grade thresholds, applied to the ball
 * score (see NC55_DEFAULT_SCALE). Used as the default grade_bands for an
 * nc55 test when its key doesn't give an explicit GRADES: header.
 */
export const NC55_GRADE_BANDS = [
  { label: 'Sertifikat berilmaydi', minScaled: 0 },
  { label: 'C', minScaled: 46 },
  { label: 'C+', minScaled: 51 },
  { label: 'B', minScaled: 56 },
  { label: 'A', minScaled: 61 },
  { label: 'A+', minScaled: 65 },
];

export const LETTERS4 = ['A', 'B', 'C', 'D'];
export const LETTERS6 = ['A', 'B', 'C', 'D', 'E', 'F'];

/** Option letters for a given sequence number, or null for a written item. */
export function optionsForSeq(seq) {
  if (seq >= 1 && seq <= MCQ4_LAST) return LETTERS4;
  if (seq > MCQ4_LAST && seq <= MCQ6_LAST) return LETTERS6;
  return null;
}

/**
 * Parses a label ("1", "33", "36a") into its fixed seq (1..55), or null if
 * the label doesn't fit the template at all.
 */
export function labelToSeq(label) {
  const mcq = /^(\d{1,2})$/.exec(label);
  if (mcq) {
    const n = Number(mcq[1]);
    return n >= 1 && n <= MCQ6_LAST ? n : null;
  }
  const written = /^(\d{1,2})([ab])$/i.exec(label);
  if (written) {
    const q = Number(written[1]);
    const sub = written[2].toLowerCase();
    if (q >= WRITTEN_FIRST_Q && q <= WRITTEN_LAST_Q) {
      return MCQ6_LAST + (q - WRITTEN_FIRST_Q) * 2 + (sub === 'a' ? 1 : 2);
    }
  }
  return null;
}

/** Inverse of labelToSeq: the canonical label for a seq 1..55. */
export function seqToLabel(seq) {
  if (seq >= 1 && seq <= MCQ6_LAST) return String(seq);
  if (seq > MCQ6_LAST && seq <= NC55_ITEM_COUNT) {
    const idx = seq - MCQ6_LAST - 1; // 0..19
    const q = WRITTEN_FIRST_Q + Math.floor(idx / 2);
    const sub = idx % 2 === 0 ? 'a' : 'b';
    return `${q}${sub}`;
  }
  return null;
}

/** The ten written-question numbers (36..45), each with sub-items a/b. */
export function writtenParentQuestions() {
  const out = [];
  for (let q = WRITTEN_FIRST_Q; q <= WRITTEN_LAST_Q; q++) out.push(q);
  return out;
}

/**
 * The canonical, ordered 55-item descriptor list.
 * Everything else in this module and its consumers is derived from this.
 */
export function nc55Items() {
  const items = [];
  for (let seq = 1; seq <= MCQ6_LAST; seq++) {
    const options = optionsForSeq(seq);
    items.push({
      seq,
      label: String(seq),
      itemType: 'mcq',
      optionCount: options.length,
      options,
      parentQuestion: null,
      subLabel: null,
    });
  }
  for (const q of writtenParentQuestions()) {
    for (const sub of ['a', 'b']) {
      const label = `${q}${sub}`;
      items.push({
        seq: labelToSeq(label),
        label,
        itemType: 'written',
        optionCount: null,
        options: null,
        parentQuestion: q,
        subLabel: sub,
      });
    }
  }
  return items;
}

/**
 * The same 55 items grouped into 45 visual "questions" — each mcq item is
 * its own block, each written question (36..45) is one block holding its
 * two sub-items together. This is the shape the Mini App renders.
 */
export function nc55Blocks() {
  const blocks = [];
  for (const item of nc55Items()) {
    if (item.itemType === 'mcq') {
      blocks.push({ type: 'mcq', seq: item.seq, label: item.label, options: item.options });
    } else if (item.subLabel === 'a') {
      blocks.push({
        type: 'written',
        parentQuestion: item.parentQuestion,
        subs: [{ seq: item.seq, label: item.label }],
      });
    } else {
      blocks.at(-1).subs.push({ seq: item.seq, label: item.label });
    }
  }
  return blocks;
}

/**
 * Compares a test's stored items (DB rows, snake_case) against the canonical
 * template. Returns a list of human-readable mismatches; empty means the
 * test conforms and may be locked as an nc55 test.
 *
 * @param {Array<{position:number, label:string, item_type:string,
 *   option_count:number|null, parent_question:number|null,
 *   sub_label:string|null, answer_key:string|null}>} items
 */
export function validateNc55Structure(items) {
  const errors = [];
  if (items.length !== NC55_ITEM_COUNT) {
    errors.push(`expected exactly ${NC55_ITEM_COUNT} items for the NC55 template, got ${items.length}`);
    return errors;
  }

  const byPosition = new Map(items.map((i) => [i.position, i]));
  for (const want of nc55Items()) {
    const got = byPosition.get(want.seq);
    if (!got) {
      errors.push(`missing item ${want.label} (seq ${want.seq})`);
      continue;
    }
    if (got.label !== want.label) {
      errors.push(`item seq ${want.seq}: label "${got.label}" should be "${want.label}"`);
    }
    if (got.item_type !== want.itemType) {
      errors.push(`item ${want.label}: type "${got.item_type}" should be "${want.itemType}"`);
      continue;
    }
    if (want.itemType === 'mcq') {
      if (got.option_count !== want.optionCount) {
        errors.push(`item ${want.label}: expected ${want.optionCount} options, got ${got.option_count}`);
      }
      const key = String(got.answer_key ?? '').toUpperCase();
      if (!want.options.includes(key)) {
        errors.push(`item ${want.label}: answer key "${got.answer_key}" is not one of ${want.options.join('')}`);
      }
    } else {
      if (got.answer_key) {
        errors.push(`item ${want.label}: written sub-items must not have an answer key (got "${got.answer_key}")`);
      }
      if (got.parent_question !== want.parentQuestion) {
        errors.push(`item ${want.label}: parent_question should be ${want.parentQuestion}, got ${got.parent_question}`);
      }
      if (got.sub_label !== want.subLabel) {
        errors.push(`item ${want.label}: sub_label should be "${want.subLabel}", got "${got.sub_label}"`);
      }
    }
  }
  return errors;
}
