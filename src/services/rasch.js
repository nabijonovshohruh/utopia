/**
 * Dichotomous Rasch (1PL IRT) measurement engine.
 *
 *   P(x_i = 1 | theta, b_i) = 1 / (1 + exp(-(theta - b_i)))
 *
 * ANCHORING CONTRACT
 * ------------------
 * Every function that estimates a person's ability takes the item difficulty
 * vector `b` as an *input argument*. Nothing here reads a database, looks at
 * other examinees, or recomputes b from the response pool. Ability estimation
 * is therefore a pure function of (response vector, anchor vector):
 *
 *     theta = f(responses, b)
 *
 * Two students with the same response pattern on the same anchors get the same
 * theta whether they are submission #3 or #300,000. There is no cohort term in
 * the math, so there is no mechanism by which growing volume can deflate
 * scores or drift the scale.
 *
 * `calibrateAnchors()` is the one function that *produces* b values. It is a
 * deliberate, explicitly-invoked, one-time operation (see /calibrate) whose
 * output is frozen into the database. It is never called during scoring.
 *
 * No dependencies — plain ES module, unit-testable in isolation.
 */

export const ENGINE_VERSION = 'rasch-1pl/1.0.0';

const LOGIT_FLOOR = -8;
const LOGIT_CEIL = 8;

/* ------------------------------------------------------------------ */
/* Core model                                                          */
/* ------------------------------------------------------------------ */

/** Probability of a correct response. */
export function probability(theta, b) {
  return 1 / (1 + Math.exp(-(theta - b)));
}

/** Expected raw score at `theta` given anchors `b` (the test characteristic curve). */
export function expectedScore(theta, b) {
  let sum = 0;
  for (const bi of b) sum += probability(theta, bi);
  return sum;
}

/** Test information at `theta`. Equals the Fisher information of the MLE. */
export function information(theta, b) {
  let info = 0;
  for (const bi of b) {
    const p = probability(theta, bi);
    info += p * (1 - p);
  }
  return info;
}

/** Standard error of measurement in logits. */
export function standardError(theta, b) {
  const info = information(theta, b);
  return info > 0 ? 1 / Math.sqrt(info) : Infinity;
}

/* ------------------------------------------------------------------ */
/* Ability estimation                                                  */
/* ------------------------------------------------------------------ */

/**
 * Warm's Weighted Likelihood Estimate (WLE) — the default.
 *
 * Solves  (r - sum p) + J / (2I) = 0,  where J = sum p(1-p)(1-2p).
 *
 * Chosen over plain MLE because it is bias-corrected and, critically, it is
 * FINITE for zero and perfect raw scores. Plain MLE diverges at the extremes
 * and needs an arbitrary fudge (the "0.3 logit" convention); baking an
 * arbitrary constant into a reported score is exactly the kind of soft
 * judgement call we want out of an anchored, reproducible pipeline.
 *
 * Solved by bisection on [-8, 8]: the score function is monotone decreasing,
 * so bisection cannot diverge or oscillate. ~60 iterations of a 16-logit
 * bracket is far below float precision, and the cost is trivial for test
 * lengths in the hundreds.
 */
export function estimateThetaWLE(rawScore, b) {
  const g = (theta) => {
    let sumP = 0;
    let I = 0;
    let J = 0;
    for (const bi of b) {
      const p = probability(theta, bi);
      const pq = p * (1 - p);
      sumP += p;
      I += pq;
      J += pq * (1 - 2 * p);
    }
    return rawScore - sumP + (I > 0 ? J / (2 * I) : 0);
  };

  let lo = LOGIT_FLOOR;
  let hi = LOGIT_CEIL;
  const gLo = g(lo);
  const gHi = g(hi);
  // Degenerate bracket (shouldn't happen for 0 <= r <= N) — clamp out.
  if (gLo < 0) return lo;
  if (gHi > 0) return hi;

  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (hi - lo < 1e-10) return mid;
    if (g(mid) > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Joint Maximum Likelihood ability estimate via damped Newton-Raphson.
 *
 * Undefined at the extremes, so zero/perfect scores are nudged inward by
 * `extremeAdjustment` logits-worth of score (Winsteps' 0.3 convention).
 * Provided for parity with existing Winsteps/ConQuest reporting; WLE is the
 * better default for new deployments.
 */
export function estimateThetaMLE(rawScore, b, { extremeAdjustment = 0.3 } = {}) {
  const n = b.length;
  let r = rawScore;
  if (r <= 0) r = extremeAdjustment;
  else if (r >= n) r = n - extremeAdjustment;

  // Start from the log-odds of the proportion correct, centred on mean difficulty.
  const meanB = b.reduce((a, c) => a + c, 0) / n;
  let theta = meanB + Math.log(r / (n - r));

  for (let i = 0; i < 100; i++) {
    const info = information(theta, b);
    if (info < 1e-10) break;
    let step = (r - expectedScore(theta, b)) / info;
    // Clamp to +/-1 logit: keeps the first iterations from overshooting on
    // short tests, where the Hessian is a poor global guide.
    if (step > 1) step = 1;
    else if (step < -1) step = -1;
    theta += step;
    if (Math.abs(step) < 1e-7) break;
  }
  return Math.min(LOGIT_CEIL, Math.max(LOGIT_FLOOR, theta));
}

/** Dispatches to the configured estimator. */
export function estimateTheta(rawScore, b, { method = 'wle' } = {}) {
  if (b.length === 0) throw new Error('cannot estimate theta with no anchored items');
  if (rawScore < 0 || rawScore > b.length) {
    throw new Error(`raw score ${rawScore} outside 0..${b.length}`);
  }
  return method === 'mle' ? estimateThetaMLE(rawScore, b) : estimateThetaWLE(rawScore, b);
}

/* ------------------------------------------------------------------ */
/* Reporting scale                                                     */
/* ------------------------------------------------------------------ */

/**
 * Fixed linear transform from logits to the reported scale.
 * `slope`/`intercept` come from the locked test row — never from the cohort.
 */
export function thetaToScaled(theta, { intercept = 500, slope = 50, min = 200, max = 800 } = {}) {
  const raw = intercept + slope * theta;
  return Math.round(Math.min(max, Math.max(min, raw)));
}

/**
 * Maps a scaled score to a certificate grade.
 * `bands` is [{ label, minScaled }, ...]; order does not matter.
 */
export function gradeFor(scaledScore, bands) {
  const sorted = [...bands].sort((a, b) => b.minScaled - a.minScaled);
  for (const band of sorted) {
    if (scaledScore >= band.minScaled) return band.label;
  }
  return sorted.length ? sorted[sorted.length - 1].label : 'NG';
}

export const DEFAULT_GRADE_BANDS = [
  { label: 'A+', minScaled: 700 },
  { label: 'A', minScaled: 640 },
  { label: 'B+', minScaled: 580 },
  { label: 'B', minScaled: 520 },
  { label: 'C', minScaled: 460 },
  { label: 'NC', minScaled: 0 },
];

/* ------------------------------------------------------------------ */
/* Full scoring pass                                                   */
/* ------------------------------------------------------------------ */

/**
 * Scores one response vector against fixed anchors.
 *
 * @param {number[]} responses  0/1 per item, parallel to `b`
 * @param {number[]} b          anchored difficulties in logits
 * @param {object}   scale      { intercept, slope, min, max }
 * @param {object[]} bands      grade bands
 */
export function scoreResponses(responses, b, scale, bands, { method = 'wle' } = {}) {
  if (responses.length !== b.length) {
    throw new Error(`response/anchor length mismatch: ${responses.length} vs ${b.length}`);
  }
  const rawScore = responses.reduce((a, c) => a + (c ? 1 : 0), 0);
  const theta = estimateTheta(rawScore, b, { method });
  const se = standardError(theta, b);
  const scaledScore = thetaToScaled(theta, scale);

  return {
    rawScore,
    itemCount: b.length,
    percentCorrect: (rawScore / b.length) * 100,
    theta,
    se,
    scaledScore,
    // Scaled-score error band, same fixed transform applied to +/-1 SE.
    scaledSe: Math.round(Math.abs((scale.slope ?? 50) * se)),
    grade: gradeFor(scaledScore, bands),
    method,
    engineVersion: ENGINE_VERSION,
  };
}

/**
 * Pre-computes the complete raw -> theta -> scaled -> grade lookup table.
 *
 * Because scoring is anchor-pure, this table is the *entire* score report for
 * a test: it can be published alongside the paper before a single student
 * sits it, and it will still be exactly correct after a million submissions.
 * Handy as a conversion chart and as a regression fixture.
 */
export function buildScoreTable(b, scale, bands, { method = 'wle' } = {}) {
  const table = [];
  for (let r = 0; r <= b.length; r++) {
    const theta = estimateTheta(r, b, { method });
    const scaledScore = thetaToScaled(theta, scale);
    table.push({
      rawScore: r,
      theta: Number(theta.toFixed(4)),
      se: Number(standardError(theta, b).toFixed(4)),
      scaledScore,
      grade: gradeFor(scaledScore, bands),
    });
  }
  return table;
}

/* ------------------------------------------------------------------ */
/* One-time calibration (NOT part of scoring)                          */
/* ------------------------------------------------------------------ */

/**
 * Estimates item difficulties from a pilot response matrix — run ONCE, then
 * frozen into the DB as anchors.
 *
 * PROX starting values, then JMLE (alternate theta/b Newton updates with the
 * item mean re-centred to 0 each cycle to fix the origin). Items and persons
 * with extreme (all-right / all-wrong) margins carry no difficulty
 * information and are excluded from estimation; excluded items come back as
 * `null` so the operator must supply those anchors by hand rather than
 * silently shipping a fabricated value.
 *
 * @param {number[][]} matrix  persons x items, 0/1
 * @returns {{ b: (number|null)[], iterations: number, converged: boolean, excludedItems: number[] }}
 */
export function calibrateAnchors(matrix, { maxIterations = 200, tolerance = 0.005 } = {}) {
  const nPersons = matrix.length;
  if (nPersons === 0) throw new Error('calibration needs at least one response vector');
  const nItems = matrix[0].length;

  const itemTotals = new Array(nItems).fill(0);
  for (const row of matrix) {
    if (row.length !== nItems) throw new Error('ragged response matrix');
    for (let j = 0; j < nItems; j++) itemTotals[j] += row[j] ? 1 : 0;
  }

  // Extreme items/persons are uninformative for calibration.
  const liveItems = [];
  const excludedItems = [];
  for (let j = 0; j < nItems; j++) {
    if (itemTotals[j] > 0 && itemTotals[j] < nPersons) liveItems.push(j);
    else excludedItems.push(j);
  }
  if (liveItems.length < 2) {
    throw new Error('calibration needs at least 2 non-extreme items');
  }

  const livePersons = [];
  for (let i = 0; i < nPersons; i++) {
    const total = liveItems.reduce((a, j) => a + (matrix[i][j] ? 1 : 0), 0);
    if (total > 0 && total < liveItems.length) livePersons.push(i);
  }
  if (livePersons.length < 2) {
    throw new Error('calibration needs at least 2 non-extreme response vectors');
  }

  const m = liveItems.length;
  // PROX seed: item logit of difficulty, centred.
  const bEst = liveItems.map((j) => {
    const p = itemTotals[j] / nPersons;
    return Math.log((1 - p) / p);
  });
  const centre = bEst.reduce((a, c) => a + c, 0) / m;
  for (let j = 0; j < m; j++) bEst[j] -= centre;

  const personRaw = livePersons.map((i) => liveItems.reduce((a, j) => a + (matrix[i][j] ? 1 : 0), 0));
  const itemRaw = liveItems.map((j) => livePersons.reduce((a, i) => a + (matrix[i][j] ? 1 : 0), 0));

  let converged = false;
  let iterations = 0;

  for (let iter = 1; iter <= maxIterations; iter++) {
    iterations = iter;

    // Step 1: persons given current item anchors.
    const thetaEst = personRaw.map((r) => estimateThetaMLE(r, bEst));

    // Step 2: items given current person estimates (one damped Newton step).
    let maxDelta = 0;
    for (let j = 0; j < m; j++) {
      let expected = 0;
      let info = 0;
      for (let k = 0; k < thetaEst.length; k++) {
        const p = probability(thetaEst[k], bEst[j]);
        expected += p;
        info += p * (1 - p);
      }
      if (info < 1e-10) continue;
      // d(logL)/db_j = expected - observed;  d2(logL)/db_j2 = -info.
      // Newton for a maximum: b -= grad/hess  =>  b += (expected - observed)/info.
      // So an item answered correctly more often than expected moves DOWN
      // (becomes easier), which is the correct direction.
      let step = (expected - itemRaw[j]) / info;
      if (step > 1) step = 1;
      else if (step < -1) step = -1;
      bEst[j] += step;
      maxDelta = Math.max(maxDelta, Math.abs(step));
    }

    // Re-centre: the Rasch scale origin is arbitrary, so fix it at mean b = 0.
    const mean = bEst.reduce((a, c) => a + c, 0) / m;
    for (let j = 0; j < m; j++) bEst[j] -= mean;

    if (maxDelta < tolerance) {
      converged = true;
      break;
    }
  }

  // JMLE dispersion-bias correction.
  //
  // Estimating persons and items from the same data jointly inflates the
  // spread of the item difficulties, because each person's theta is itself
  // estimated with error. For dichotomous items the bias is well approximated
  // by a factor of L/(L-1) on the dispersion, so we shrink by (L-1)/L. This
  // is the same correction Winsteps applies by default under UCON.
  //
  // It matters here specifically because these numbers are about to be frozen
  // as permanent anchors: an uncorrected calibration would stretch the scale
  // slightly and permanently mis-grade examinees near the extremes.
  const shrink = (m - 1) / m;
  for (let j = 0; j < m; j++) bEst[j] *= shrink;

  const b = new Array(nItems).fill(null);
  liveItems.forEach((j, idx) => {
    b[j] = Number(bEst[idx].toFixed(4));
  });

  return { b, iterations, converged, excludedItems, biasCorrection: Number(shrink.toFixed(4)) };
}

/* ------------------------------------------------------------------ */
/* Anchor health monitoring (detect, never auto-correct)               */
/* ------------------------------------------------------------------ */

/**
 * Item-level quality control for a cohort scored against fixed anchors.
 *
 * `displacement` is the logit shift the data *would* apply to an item if we
 * let it re-calibrate. It is reported for human review and NEVER written back
 * — that write-back is precisely the feedback loop that causes drift. A large
 * |displacement| means the anchor has genuinely gone stale (item leaked,
 * curriculum changed), which is a decision for a human plus a new
 * scale_version, not an automatic nightly job.
 *
 * Also returns standard Rasch fit statistics:
 *   infit MNSQ  — information-weighted, sensitive to on-target misfit
 *   outfit MNSQ — unweighted, sensitive to outliers
 * Both have an expected value of 1.0; the usual tolerance is 0.5-1.5.
 *
 * @param {number[][]} matrix  persons x items, 0/1
 * @param {number[]}   b       the fixed anchors used for scoring
 */
export function itemDiagnostics(matrix, b, { method = 'wle', displacementAlert = 0.5 } = {}) {
  const nItems = b.length;
  const thetas = matrix.map((row) => {
    const raw = row.reduce((a, c) => a + (c ? 1 : 0), 0);
    return estimateTheta(raw, b, { method });
  });

  const out = [];
  for (let j = 0; j < nItems; j++) {
    let observed = 0;
    let expected = 0;
    let info = 0;
    let outfitSum = 0;
    let infitNum = 0;
    let n = 0;

    for (let i = 0; i < matrix.length; i++) {
      const x = matrix[i][j] ? 1 : 0;
      const p = probability(thetas[i], b[j]);
      const variance = p * (1 - p);
      if (variance < 1e-12) continue;
      observed += x;
      expected += p;
      info += variance;
      const residual = x - p;
      outfitSum += (residual * residual) / variance;
      infitNum += residual * residual;
      n++;
    }

    // Same Newton step calibration would take: b + displacement is the
    // re-estimate this cohort implies. Negative => item is easier than its
    // anchor claims. Reported, never applied.
    const displacement = info > 0 ? (expected - observed) / info : 0;
    out.push({
      position: j + 1,
      b: b[j],
      observedProportion: n ? observed / n : null,
      expectedProportion: n ? expected / n : null,
      displacement: Number(displacement.toFixed(3)),
      infit: info > 0 ? Number((infitNum / info).toFixed(3)) : null,
      outfit: n ? Number((outfitSum / n).toFixed(3)) : null,
      n,
      // Advisory only. Consumers must not write `b + displacement` back.
      stale: Math.abs(displacement) >= displacementAlert,
    });
  }
  return out;
}

/** Person-level fit, useful for flagging guessing or response-set behaviour. */
export function personFit(responses, b, { method = 'wle' } = {}) {
  const raw = responses.reduce((a, c) => a + (c ? 1 : 0), 0);
  const theta = estimateTheta(raw, b, { method });
  let outfitSum = 0;
  let infitNum = 0;
  let info = 0;
  let n = 0;
  for (let j = 0; j < b.length; j++) {
    const p = probability(theta, b[j]);
    const variance = p * (1 - p);
    if (variance < 1e-12) continue;
    const residual = (responses[j] ? 1 : 0) - p;
    outfitSum += (residual * residual) / variance;
    infitNum += residual * residual;
    info += variance;
    n++;
  }
  return {
    theta,
    infit: info > 0 ? Number((infitNum / info).toFixed(3)) : null,
    outfit: n ? Number((outfitSum / n).toFixed(3)) : null,
  };
}
