/** Message formatting. Everything is HTML parse_mode. */

export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function bar(percent, width = 10) {
  const filled = Math.round((percent / 100) * width);
  return '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, width - filled));
}

/** The student-facing score report. */
export function studentReport({ test, scored, submissionId, bands }) {
  const pct = scored.percentCorrect;
  const next = nextBand(scored.scaledScore, bands);

  const lines = [
    `<b>${esc(test.title)}</b>`,
    `<code>${esc(test.code)}</code> · submission #${submissionId}`,
    '',
    `Raw score    <b>${scored.rawScore} / ${scored.itemCount}</b>  (${pct.toFixed(1)}%)`,
    `             <code>${bar(pct)}</code>`,
    '',
    '<b>Rasch measurement</b>',
    `Ability (θ)  <b>${fmt(scored.theta)}</b> logits  ±${scored.se.toFixed(2)}`,
    `Scaled score <b>${scored.scaledScore}</b> ± ${scored.scaledSe}`,
    `Level        <b>${esc(scored.grade)}</b>`,
  ];

  if (next) {
    lines.push('', `${next.gap} point(s) to <b>${esc(next.label)}</b>.`);
  }
  lines.push(
    '',
    `<i>Scored against fixed item anchors (${esc(test.anchor_checksum.slice(0, 8))}, scale v${test.scale_version}). ` +
      'This score does not change as more students submit.</i>',
  );
  return lines.join('\n');
}

function nextBand(scaled, bands) {
  const above = bands
    .filter((b) => b.minScaled > scaled)
    .sort((a, b) => a.minScaled - b.minScaled)[0];
  return above ? { label: above.label, gap: above.minScaled - scaled } : null;
}

function fmt(n) {
  return (n >= 0 ? '+' : '') + n.toFixed(2);
}

export function testSummary(test, itemCount, bands) {
  const status =
    test.status === 'locked'
      ? `🔒 locked ${esc(test.locked_at ?? '')}`
      : test.status === 'draft'
        ? '📝 draft (cannot score yet)'
        : '📦 archived';
  return [
    `<b>${esc(test.title)}</b>  <code>${esc(test.code)}</code>`,
    `Status: ${status}`,
    `Items: ${itemCount} · Scale: ${test.scale_intercept} + ${test.scale_slope}·θ ` +
      `(${test.scale_min}–${test.scale_max})`,
    `Anchors: ${esc(test.anchor_source ?? 'none')}` +
      (test.anchor_checksum ? ` · <code>${esc(test.anchor_checksum.slice(0, 12))}</code>` : ''),
    `Auto-grade: ${test.auto_grade ? 'on' : 'off (teacher triggers /score)'}`,
    `Bands: ${bands.map((b) => `${esc(b.label)}≥${b.minScaled}`).join(', ')}`,
  ].join('\n');
}

export function resultsTable(rows, code) {
  if (!rows.length) return `No results yet for <code>${esc(code)}</code>.`;
  const body = rows
    .map((r, i) => {
      const name = (r.full_name ?? 'student').slice(0, 18).padEnd(18);
      const raw = String(r.raw_score).padStart(3);
      const scaled = String(r.scaled_score).padStart(4);
      return `${String(i + 1).padStart(3)}. ${name} ${raw} ${scaled}  ${r.grade}`;
    })
    .join('\n');
  return (
    `<b>Results — ${esc(code)}</b> (${rows.length})\n` +
    `<pre>  #  name                 raw  sc.  lvl\n${esc(body)}</pre>`
  );
}

export function driftReport({ test, diagnostics, cohort, sampleSize }) {
  const stale = diagnostics.filter((d) => d.stale);
  const misfit = diagnostics.filter((d) => d.outfit !== null && (d.outfit > 1.5 || d.outfit < 0.5));

  const lines = [
    `<b>Anchor health — ${esc(test.code)}</b>`,
    `Cohort: n=${sampleSize} · mean θ ${cohort.mean_theta.toFixed(3)} · mean scaled ${Math.round(cohort.mean_scaled)}`,
    '',
    `Stale anchors (|displacement| ≥ 0.5): <b>${stale.length}</b>`,
    `Misfitting items (outfit outside 0.5–1.5): <b>${misfit.length}</b>`,
  ];

  if (stale.length) {
    lines.push(
      '',
      '<pre>item     b   displ.  infit outfit\n' +
        esc(
          stale
            .slice(0, 15)
            .map(
              (d) =>
                `${String(d.position).padStart(4)} ${d.b.toFixed(2).padStart(6)} ` +
                `${(d.displacement > 0 ? '+' : '') + d.displacement.toFixed(2)}`.padStart(8) +
                ` ${String(d.infit).padStart(6)} ${String(d.outfit).padStart(6)}`,
            )
            .join('\n'),
        ) +
        '</pre>',
      '<i>Displacement is diagnostic only — it is never written back to the anchors. ' +
        'A persistently stale item means the anchor is outdated; fix it by publishing a new ' +
        'test code with fresh calibration, not by editing this one.</i>',
    );
  } else {
    lines.push('', '✅ All anchors within tolerance. The scale is holding.');
  }
  return lines.join('\n');
}

/** The teacher's "how many submitted, how many are ready" status check, with the publish button attached by the caller. */
export function statusReport(status) {
  const { test, submitted, needsGrading, readyToScore, scored } = status;
  const lines = [
    `<b>${esc(test.title)}</b>  <code>${esc(test.code)}</code>`,
    `Submitted: <b>${submitted}</b>`,
    `Needs written grading: <b>${needsGrading}</b>`,
    `Ready to score: <b>${readyToScore}</b>`,
    `Already scored: <b>${scored}</b>`,
  ];
  if (needsGrading > 0) {
    lines.push('', `⏳ Grade the remaining written items (/ungraded ${esc(test.code)}) before publishing.`);
  } else if (readyToScore > 0) {
    lines.push('', 'Everything is graded — tap below to score and notify everyone at once.');
  } else {
    lines.push('', 'Nothing new to publish.');
  }
  return lines.join('\n');
}

/** Lists a submission's written sub-items for manual grading (or review, once complete). */
export function writingPrompt(submissionId, written, { allGraded }) {
  const blocks = written.map((w) => {
    const status = w.correct === null ? '⬜ ungraded' : w.correct ? '✅ 1' : '❌ 0';
    const text = (w.given ?? '').trim() || '<i>(blank — omitted)</i>';
    return `<b>${esc(w.label)}</b> [${status}]\n${esc(text).slice(0, 600)}`;
  });

  if (allGraded) {
    return [`<b>#${submissionId}</b> — all ${written.length} written item(s) already graded.`, '', ...blocks].join(
      '\n\n',
    );
  }

  const ungradedCount = written.filter((w) => w.correct === null).length;
  return [
    `<b>Grading #${submissionId}</b> — ${ungradedCount} item(s) pending.`,
    '',
    ...blocks,
    '',
    'Reply with scores like <code>36a=1 36b=0 37a=1</code> (0 or 1 per sub-item, any order, several ' +
      'messages are fine). /cancel to stop.',
  ].join('\n\n');
}

export const STUDENT_HELP = [
  '<b>Test bot</b>',
  '',
  '/test <code>CODE</code> — open a test and see how to answer',
  '/answers — re-read the submission format',
  '/result — your latest score report',
  '/mytests — everything you have taken',
].join('\n');

export const ADMIN_HELP = [
  '<b>Teacher commands</b>',
  '',
  '<b>Building a test</b>',
  '/upload — paste or attach an answer key (creates a draft)',
  '/key <code>CODE</code> — show the stored key and anchors',
  '/calibrate <code>CODE</code> — one-time anchor estimation from a pilot cohort',
  '/lock <code>CODE</code> — freeze anchors + scale, enable scoring',
  '',
  '<b>Grading</b>',
  '/pending — ungraded submissions',
  '/ungraded <code>CODE</code> — submissions still needing written-item grading',
  '/writing <code>SUB_ID</code> — grade a submission\'s written sub-items (36a-45b)',
  '/score <code>SUB_ID</code> — Rasch-score one submission',
  '/scoreall <code>CODE</code> — score everything ready',
  '/status <code>CODE</code> — submission counts + "Calculate &amp; Publish Results" button',
  '/verify <code>SUB_ID</code> — mark a result teacher-verified',
  '/autograde <code>CODE</code> on|off',
  '',
  '<b>Reporting</b>',
  '/tests — all tests',
  '/results <code>CODE</code> — ranked results',
  '/table <code>CODE</code> — raw→scaled conversion chart',
  '/drift <code>CODE</code> — anchor health / item fit',
  '/export <code>CODE</code> — CSV of results',
].join('\n');
