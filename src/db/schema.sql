-- ---------------------------------------------------------------------------
-- Rasch test-evaluation bot schema
--
-- DESIGN RULE #1 (the whole point of this file):
--   Item difficulties (items.b_logit) and the raw->scaled transform
--   (tests.scale_*) are CALIBRATION CONSTANTS, not statistics of the
--   response pool. Once a test is locked they are immutable, enforced by
--   triggers below. No amount of new student submissions can move them,
--   so a given raw-score pattern maps to the same theta / scaled score /
--   grade forever. This prevents score deflation and theta drift.
--
-- DESIGN RULE #2 (added for the 55-item National Certificate template):
--   Not every item is multiple choice. Items 36-55 are "written" sub-items:
--   a student's free-text answer, correctness for which can only be decided
--   by a teacher. `responses.correct` is therefore nullable — NULL means
--   "submitted, not yet graded" — and the scoring engine (src/services/
--   scoring.js) refuses to compute a Rasch score while any response for a
--   submission is still NULL. This keeps "ungraded" and "wrong" visibly
--   distinct instead of collapsing them, which would silently under-score
--   students whose written answers hadn't been read yet.
-- ---------------------------------------------------------------------------

PRAGMA foreign_keys = ON;

-- Tracks which migration generation has been applied. See src/db/migrate.js.
CREATE TABLE IF NOT EXISTS schema_meta (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS students (
  id               INTEGER PRIMARY KEY,
  telegram_id      INTEGER NOT NULL UNIQUE,
  username         TEXT,
  full_name        TEXT,
  active_test_id   INTEGER REFERENCES tests(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tests (
  id               INTEGER PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,
  title            TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'locked', 'archived')),

  -- 'custom'  — free-form item count/shape (e.g. the DEMO-101 quiz).
  -- 'nc55'    — the fixed 55-item National Certificate structure
  --             (src/domain/nc55.js). Enables structure validation at lock
  --             time, the written-item manual-grading workflow, and the
  --             Mini App form.
  template         TEXT NOT NULL DEFAULT 'custom' CHECK (template IN ('custom', 'nc55')),

  -- FIXED linear score transform: scaled = intercept + slope * theta.
  -- Deliberately NOT derived from cohort mean/SD. Normalising to the
  -- current cohort is the second, subtler source of score drift.
  scale_intercept  REAL NOT NULL DEFAULT 500,
  scale_slope      REAL NOT NULL DEFAULT 50,
  scale_min        INTEGER NOT NULL DEFAULT 200,
  scale_max        INTEGER NOT NULL DEFAULT 800,

  -- Bumped only by a deliberate re-anchoring. Every result records the
  -- version it was scored under, so history stays reproducible.
  scale_version    INTEGER NOT NULL DEFAULT 1,

  -- sha256 over the frozen (position, answer_key, b_logit) vector.
  -- Recomputed at scoring time and compared; a mismatch aborts scoring.
  anchor_checksum  TEXT,
  anchor_source    TEXT,          -- 'manual' | 'calibrated:<N>' | 'imported'

  auto_grade       INTEGER NOT NULL DEFAULT 1,
  locked_at        TEXT,
  created_by       INTEGER,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS items (
  id               INTEGER PRIMARY KEY,
  test_id          INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,

  -- Position in the anchor vector (what rasch.js indexes by). For 'nc55'
  -- tests this equals the item's fixed seq (src/domain/nc55.js); for
  -- 'custom' tests it is just 1..N in upload order, as before.
  position         INTEGER NOT NULL,

  -- Human-facing identifier: "1", "33", "36a". Equal to `position` as text
  -- for plain mcq items; carries the a/b suffix for written sub-items.
  label            TEXT NOT NULL,

  item_type        TEXT NOT NULL DEFAULT 'mcq' CHECK (item_type IN ('mcq', 'written')),

  -- mcq: 4 or 6 (the option-letter-set size). written: NULL.
  option_count     INTEGER,

  -- mcq: required, one of the option letters. written: must be NULL — a
  -- free-text answer has no key to match against; correctness is decided
  -- by a teacher per submission (see responses.correct).
  answer_key       TEXT,

  -- written sub-items only: the parent question number (36..45) and which
  -- half it is ('a'/'b'), so the UI can group "36a"+"36b" under "Question
  -- 36". NULL for mcq items.
  parent_question  INTEGER,
  sub_label        TEXT CHECK (sub_label IN ('a', 'b')),

  -- Points this item is worth. CHECK pins it to 1 (binary) deliberately:
  -- the engine implements dichotomous (0/1) Rasch scoring only. Partial
  -- credit would need a polytomous model (e.g. Masters' Partial Credit
  -- Model) with its own math and its own anchor shape — out of scope here,
  -- and a half-implemented version of it would be worse than not having it.
  -- The column exists so that extension has somewhere to attach later
  -- without another migration.
  max_score        INTEGER NOT NULL DEFAULT 1 CHECK (max_score = 1),

  b_logit          REAL,          -- NULL until anchored; test cannot lock
  anchored         INTEGER NOT NULL DEFAULT 0 CHECK (anchored IN (0, 1)),

  UNIQUE (test_id, position),
  UNIQUE (test_id, label),
  -- Deliberately does NOT constrain option_count to {4,6}: that rule is
  -- specific to the nc55 template and belongs in validateNc55Structure()
  -- (src/domain/nc55.js), not here — a 'custom' template test can have mcq
  -- items of any cardinality (or none tracked at all), same as before this
  -- template system existed.
  CHECK (
    (item_type = 'mcq'     AND answer_key IS NOT NULL
                            AND parent_question IS NULL AND sub_label IS NULL)
    OR
    (item_type = 'written' AND answer_key IS NULL     AND option_count IS NULL
                            AND parent_question IS NOT NULL AND sub_label IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS grade_bands (
  id               INTEGER PRIMARY KEY,
  test_id          INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  label            TEXT NOT NULL,
  min_scaled       INTEGER NOT NULL,
  UNIQUE (test_id, label)
);

CREATE TABLE IF NOT EXISTS submissions (
  id               INTEGER PRIMARY KEY,
  test_id          INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  student_id       INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  raw_input        TEXT NOT NULL,
  source           TEXT NOT NULL DEFAULT 'chat' CHECK (source IN ('chat', 'miniapp')),
  status           TEXT NOT NULL DEFAULT 'submitted'
                     CHECK (status IN ('submitted', 'scored', 'verified', 'rejected')),
  submitted_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS responses (
  id               INTEGER PRIMARY KEY,
  submission_id    INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  item_id          INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  given            TEXT,          -- NULL/'' = omitted; selected letter or free text
  -- NULL = not yet graded (written sub-items start here and wait on a
  -- teacher). Scoring refuses to run while any response is NULL.
  correct          INTEGER CHECK (correct IS NULL OR correct IN (0, 1)),
  graded_by        INTEGER,       -- admin telegram_id who entered the manual grade
  graded_at        TEXT,
  UNIQUE (submission_id, item_id)
);

CREATE TABLE IF NOT EXISTS results (
  id               INTEGER PRIMARY KEY,
  submission_id    INTEGER NOT NULL UNIQUE REFERENCES submissions(id) ON DELETE CASCADE,
  raw_score        INTEGER NOT NULL,
  item_count       INTEGER NOT NULL,
  theta            REAL NOT NULL,
  se               REAL NOT NULL,
  scaled_score     INTEGER NOT NULL,
  grade            TEXT NOT NULL,
  -- Provenance: pins each result to the exact constants used.
  scale_version    INTEGER NOT NULL,
  anchor_checksum  TEXT NOT NULL,
  method           TEXT NOT NULL,
  engine_version   TEXT NOT NULL,
  verified_by      INTEGER,
  scored_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_submissions_test    ON submissions(test_id, status);
CREATE INDEX IF NOT EXISTS idx_submissions_student ON submissions(student_id);
CREATE INDEX IF NOT EXISTS idx_responses_item      ON responses(item_id);
CREATE INDEX IF NOT EXISTS idx_responses_ungraded  ON responses(submission_id) WHERE correct IS NULL;

-- ---------------------------------------------------------------------------
-- Immutability triggers: the database refuses to let anchors drift, even if
-- application code is buggy or someone opens a SQL console.
-- ---------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS trg_items_anchor_frozen
BEFORE UPDATE OF b_logit, answer_key, position, label, item_type, option_count,
                 parent_question, sub_label ON items
WHEN OLD.anchored = 1
BEGIN
  SELECT RAISE(ABORT, 'anchor_locked: item difficulty/key is frozen; re-anchoring requires a new scale_version');
END;

CREATE TRIGGER IF NOT EXISTS trg_items_no_delete_when_locked
BEFORE DELETE ON items
WHEN (SELECT status FROM tests WHERE id = OLD.test_id) = 'locked'
BEGIN
  SELECT RAISE(ABORT, 'anchor_locked: cannot remove an item from a locked test');
END;

CREATE TRIGGER IF NOT EXISTS trg_items_no_insert_when_locked
BEFORE INSERT ON items
WHEN (SELECT status FROM tests WHERE id = NEW.test_id) = 'locked'
BEGIN
  SELECT RAISE(ABORT, 'anchor_locked: cannot add an item to a locked test');
END;

CREATE TRIGGER IF NOT EXISTS trg_tests_scale_frozen
BEFORE UPDATE OF scale_intercept, scale_slope, scale_min, scale_max, anchor_checksum ON tests
WHEN OLD.status = 'locked' AND NEW.scale_version = OLD.scale_version
BEGIN
  SELECT RAISE(ABORT, 'scale_locked: the raw->scaled transform is frozen; bump scale_version to re-anchor');
END;

CREATE TRIGGER IF NOT EXISTS trg_bands_frozen
BEFORE UPDATE ON grade_bands
WHEN (SELECT status FROM tests WHERE id = OLD.test_id) = 'locked'
BEGIN
  SELECT RAISE(ABORT, 'scale_locked: grade bands are frozen for a locked test');
END;

-- Results are write-once. Re-scoring creates a new scale_version instead.
CREATE TRIGGER IF NOT EXISTS trg_results_immutable
BEFORE UPDATE OF theta, scaled_score, grade, raw_score, anchor_checksum ON results
BEGIN
  SELECT RAISE(ABORT, 'result_immutable: issued results cannot be edited');
END;
