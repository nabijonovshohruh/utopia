import { Composer, InputFile } from 'grammy';
import { config, isAdmin } from '../config.js';
import {
  parseAnswerKey,
  upsertDraftTest,
  getTestByCode,
  getItems,
  getBands,
  lockTest,
  calibrateFromPilot,
} from '../services/tests.js';
import {
  scoreSubmission,
  scoreAllPending,
  listResults,
  listPending,
  anchorDriftReport,
  scoreTableFor,
  submissionFit,
  gradeWrittenResponses,
  writtenResponsesFor,
  listNeedingGrading,
  testStatusCounts,
  publishResults,
} from '../services/scoring.js';
import { esc, ADMIN_HELP, testSummary, resultsTable, driftReport, statusReport, writingPrompt } from './format.js';

const SAMPLE_KEY = [
  'CODE: MATH-2026-A',
  'TITLE: Mathematics Midterm 2026',
  'SCALE: 500 + 50*theta',
  'RANGE: 200..800',
  'GRADES: A+>=700, A>=640, B+>=580, B>=520, C>=460, NC>=0',
  'ITEMS:',
  '1 A -2.10',
  '2 C -1.45',
  '3 B -0.80',
  '4 D  0.15',
  '5 A  1.30',
].join('\n');

export function adminRoutes(db) {
  const composer = new Composer();

  // `filter` (not a plain gate middleware) is essential here: when the
  // predicate fails it calls next(), so non-admin updates fall through to
  // studentRoutes. A gate that simply omits next() on failure would end the
  // whole middleware chain and silence the bot for every student.
  const bot = composer.filter((ctx) => isAdmin(ctx.from?.id));

  // telegram_id -> awaiting an answer-key paste
  const awaitingKey = new Set();
  // telegram_id -> submission_id awaiting written-item grades
  const awaitingGrading = new Map();

  bot.command(['admin', 'ahelp'], (ctx) => ctx.reply(ADMIN_HELP, { parse_mode: 'HTML' }));

  /* ---------------- building a test ---------------- */

  bot.command('upload', async (ctx) => {
    const inline = ctx.match?.trim();
    if (inline) return handleKey(ctx, inline);
    awaitingKey.add(ctx.from.id);
    await ctx.reply(
      'Send the answer key as the next message, or attach it as a <code>.txt</code>/<code>.csv</code> file.\n\n' +
        `<pre>${esc(SAMPLE_KEY)}</pre>\n` +
        'The third column is the <b>anchored item difficulty</b> in logits. Leave it out only if you ' +
        'plan to /calibrate on a pilot group — a test cannot be locked (or score anyone) with missing anchors. ' +
        'Leave out <code>CODE:</code> entirely and one is generated for you.\n\n' +
        'For the full 55-item National Certificate structure, start with <code>TEMPLATE: NC55</code>. ' +
        'Items 1-35 work the same as above (33-35 allow E/F too); the ten written questions use ' +
        '<code>36a</code>/<code>36b</code> … <code>45a</code>/<code>45b</code> with no answer letter — ' +
        'just a difficulty, e.g. <code>36a -1.00</code>. Those are graded by hand per student ' +
        '(/writing) once answers come in, before the test can be scored.',
      { parse_mode: 'HTML' },
    );
  });

  bot.command('cancel', async (ctx) => {
    awaitingKey.delete(ctx.from.id);
    awaitingGrading.delete(ctx.from.id);
    await ctx.reply('Cancelled.');
  });

  async function handleKey(ctx, text) {
    awaitingKey.delete(ctx.from.id);
    const parsed = parseAnswerKey(text);
    if (parsed.errors.length) {
      return ctx.reply(
        `❌ Could not accept the key:\n<pre>${esc(parsed.errors.slice(0, 15).join('\n'))}</pre>`,
        { parse_mode: 'HTML' },
      );
    }

    const hadExplicitCode = Boolean(parsed.meta.code);
    let test;
    try {
      test = upsertDraftTest(db, parsed, ctx.from.id);
    } catch (err) {
      return ctx.reply(`❌ ${esc(err.message)}`, { parse_mode: 'HTML' });
    }

    const missing = parsed.items.filter((i) => i.b_logit === null).length;
    const lines = [
      `✅ Draft saved: <b>${esc(test.title)}</b> <code>${esc(test.code)}</code>` +
        (hadExplicitCode ? '' : ' <i>(code auto-generated — post this to your channel)</i>'),
      `${parsed.items.length} items${test.template === 'nc55' ? ' · NC55 template' : ''} · ` +
        `scale ${test.scale_intercept} + ${test.scale_slope}·θ`,
      `Bands: ${parsed.bands.map((b) => `${esc(b.label)}≥${b.minScaled}`).join(', ')}`,
    ];
    if (missing) {
      lines.push(
        '',
        `⚠️ <b>${missing} item(s) have no anchored difficulty.</b> Either re-upload with b-values ` +
          `or collect a pilot cohort and run <code>/calibrate ${esc(test.code)}</code>.`,
      );
    } else {
      lines.push('', `Anchors complete. Publish with <code>/lock ${esc(test.code)}</code>.`);
    }
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  }

  bot.on('message:document', async (ctx, next) => {
    if (!awaitingKey.has(ctx.from.id)) return next();
    const doc = ctx.message.document;
    if (doc.file_size > 256 * 1024) return ctx.reply('File too large (max 256 KB).');

    const file = await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) return ctx.reply('Could not download that file. Try pasting the key as text.');
    await handleKey(ctx, await res.text());
  });

  bot.command('key', async (ctx) => {
    const test = getTestByCode(db, ctx.match?.trim() ?? '');
    if (!test) return ctx.reply('Usage: /key CODE');
    const items = getItems(db, test.id);
    const body = items
      .map((i) => {
        const key = i.item_type === 'written' ? '(written)' : (i.answer_key ?? '?');
        return (
          `${i.label.padStart(4)}  ${key.padEnd(9)} ` +
          `${i.b_logit === null ? '  (none)' : i.b_logit.toFixed(2).padStart(7)}` +
          `${i.anchored ? ' 🔒' : ''}`
        );
      })
      .join('\n');
    await ctx.reply(
      `${testSummary(test, items.length, getBands(db, test.id))}\n\n` +
        `<pre>   #  key       b\n${esc(body)}</pre>`,
      { parse_mode: 'HTML' },
    );
  });

  bot.command('calibrate', async (ctx) => {
    const code = ctx.match?.trim();
    if (!code) return ctx.reply('Usage: /calibrate CODE');
    try {
      const r = calibrateFromPilot(db, code);
      const lines = [
        `✅ Anchors estimated for <code>${esc(code)}</code>`,
        `Pilot sample: ${r.sampleSize} submissions`,
        `JMLE: ${r.iterations} iterations, ${r.converged ? 'converged' : '<b>did not converge</b>'}`,
      ];
      if (r.excludedLabels.length) {
        lines.push(
          '',
          `⚠️ Items ${r.excludedLabels.join(', ')} were answered correctly (or wrongly) by ` +
            'everyone, so they carry no difficulty information and were left unanchored. ' +
            'Set their b-values by hand or drop them before locking.',
        );
      }
      lines.push(
        '',
        `These values are still editable. <code>/lock ${esc(code)}</code> freezes them permanently — ` +
          'after that no future cohort can shift them.',
      );
      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
    } catch (err) {
      await ctx.reply(`❌ ${esc(err.message)}`, { parse_mode: 'HTML' });
    }
  });

  bot.command('lock', async (ctx) => {
    const code = ctx.match?.trim();
    if (!code) return ctx.reply('Usage: /lock CODE');
    try {
      const test = lockTest(db, code);
      const lines = [
        `🔒 <b>${esc(test.code)} is locked.</b>`,
        '',
        `Anchor fingerprint: <code>${esc(test.anchor_checksum)}</code>`,
        `Scale: ${test.scale_intercept} + ${test.scale_slope}·θ, v${test.scale_version}`,
        '',
        'Item difficulties and the score transform are now immutable — enforced by the database, ' +
          'not just by this bot.',
        '',
        `Students can take it with <code>/test ${esc(test.code)}</code>.`,
      ];
      if (test.template === 'nc55') {
        lines.push(
          '',
          'This is an NC55 test: the 20 written sub-items need your manual 0/1 grade before scoring. ' +
            `As answers come in, use <code>/writing SUBMISSION_ID</code>, then ` +
            `<code>/status ${esc(test.code)}</code> to publish everyone's results once grading is done.`,
        );
      }
      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
    } catch (err) {
      await ctx.reply(`❌ ${esc(err.message)}`, { parse_mode: 'HTML' });
    }
  });

  bot.command('autograde', async (ctx) => {
    const [code, mode] = (ctx.match ?? '').trim().split(/\s+/);
    if (!code || !['on', 'off'].includes(mode)) return ctx.reply('Usage: /autograde CODE on|off');
    const test = getTestByCode(db, code);
    if (!test) return ctx.reply(`No test with code ${esc(code)}`);
    db.prepare('UPDATE tests SET auto_grade = ? WHERE id = ?').run(mode === 'on' ? 1 : 0, test.id);
    await ctx.reply(`Auto-grade for ${esc(test.code)} is now <b>${mode}</b>.`, { parse_mode: 'HTML' });
  });

  /* ---------------- grading ---------------- */

  bot.command('pending', async (ctx) => {
    const rows = listPending(db);
    if (!rows.length) return ctx.reply('Nothing pending. 🎉');
    const body = rows
      .map((r) => {
        const grading = r.ungraded > 0 ? ` · ⏳${r.ungraded} to grade` : '';
        return (
          `#${r.id} · <code>${esc(r.code)}</code> · ${esc(r.full_name ?? '')} · ` +
          `raw ${r.raw_score}/${r.item_count}${grading}`
        );
      })
      .join('\n');
    await ctx.reply(
      `<b>Pending (${rows.length})</b>\n${body}\n\n` +
        'Grade written items with /writing ID. Score one with /score ID, or everything ready with /scoreall CODE.',
      { parse_mode: 'HTML' },
    );
  });

  bot.command('ungraded', async (ctx) => {
    const code = ctx.match?.trim();
    if (!code) return ctx.reply('Usage: /ungraded CODE');
    try {
      const rows = listNeedingGrading(db, code);
      if (!rows.length) return ctx.reply(`Nothing needs grading on ${esc(code)}. 🎉`, { parse_mode: 'HTML' });
      const body = rows
        .map((r) => `#${r.id} · ${esc(r.full_name ?? '')} · ${r.ungraded} item(s) left`)
        .join('\n');
      await ctx.reply(`<b>Needs grading — ${esc(code)}</b>\n${body}\n\nUse /writing ID to grade one.`, {
        parse_mode: 'HTML',
      });
    } catch (err) {
      await ctx.reply(`❌ ${esc(err.message)}`, { parse_mode: 'HTML' });
    }
  });

  bot.command('writing', async (ctx) => {
    const id = Number(ctx.match?.trim());
    if (!Number.isInteger(id)) return ctx.reply('Usage: /writing SUBMISSION_ID');
    const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
    if (!sub) return ctx.reply(`No submission #${id}`);
    if (db.prepare('SELECT 1 FROM results WHERE submission_id = ?').get(id)) {
      return ctx.reply(`#${id} has already been scored; its responses can no longer be graded.`);
    }

    const written = writtenResponsesFor(db, id);
    if (!written.length) return ctx.reply(`#${id} has no written items.`);

    const ungraded = written.filter((w) => w.correct === null);
    if (!ungraded.length) {
      return ctx.reply(writingPrompt(id, written, { allGraded: true }), { parse_mode: 'HTML' });
    }

    awaitingGrading.set(ctx.from.id, id);
    await ctx.reply(writingPrompt(id, written, { allGraded: false }), { parse_mode: 'HTML' });
  });

  bot.on('message:text', async (ctx, next) => {
    const subId = awaitingGrading.get(ctx.from.id);
    if (!subId) return next();

    // Deliberately captures ANY value after "=" or ":" — not just 0/1 — and
    // lets gradeWrittenResponses() reject a bad one with a specific message.
    // Restricting this regex's capture group to [01] would make a typo like
    // "36b=5" silently vanish (no match, no feedback) instead of surfacing
    // as the "score must be 0 or 1" error a teacher can actually act on.
    const pairs = [...ctx.message.text.matchAll(/(\d{1,2}[aAbB])\s*[:=]\s*(\S+)/g)];
    if (!pairs.length) {
      return ctx.reply(
        'Could not read any grades from that message. Use the form <code>36a=1 36b=0</code>, or /cancel.',
        { parse_mode: 'HTML' },
      );
    }
    const scores = {};
    for (const [, label, score] of pairs) scores[label.toLowerCase()] = score;

    try {
      const result = gradeWrittenResponses(db, subId, scores, ctx.from.id);
      let msg = `✅ Graded ${result.gradedLabels.join(', ')}.`;
      if (result.remaining > 0) {
        msg += ` ${result.remaining} item(s) still ungraded for #${subId} — keep sending scores, or /writing ${subId} to see them again.`;
      } else {
        msg += ` All written items for #${subId} are graded. Score it with /score ${subId}, or wait and publish the whole test together.`;
        awaitingGrading.delete(ctx.from.id);
      }
      await ctx.reply(msg, { parse_mode: 'HTML' });
    } catch (err) {
      await ctx.reply(`❌ ${esc(err.message)}`, { parse_mode: 'HTML' });
    }
  });

  bot.command('score', async (ctx) => {
    const id = Number(ctx.match?.trim());
    if (!Number.isInteger(id)) return ctx.reply('Usage: /score SUBMISSION_ID');
    try {
      const { scored, alreadyScored, result } = scoreSubmission(db, id, { verifiedBy: ctx.from.id });
      if (alreadyScored) {
        return ctx.reply(
          `#${id} was already scored: raw ${result.raw_score}/${result.item_count}, ` +
            `θ ${result.theta.toFixed(2)}, scaled ${result.scaled_score}, ${esc(result.grade)}.`,
          { parse_mode: 'HTML' },
        );
      }
      const fit = submissionFit(db, id);
      await ctx.reply(
        `✅ #${id} scored: raw <b>${scored.rawScore}/${scored.itemCount}</b> · ` +
          `θ <b>${scored.theta.toFixed(2)}</b> ±${scored.se.toFixed(2)} · ` +
          `scaled <b>${scored.scaledScore}</b> · <b>${esc(scored.grade)}</b>\n` +
          `Person fit: infit ${fit.infit}, outfit ${fit.outfit}` +
          (fit.outfit > 2 ? ' ⚠️ unusual response pattern — worth a look' : ''),
        { parse_mode: 'HTML' },
      );
      await notifyStudent(ctx, id);
    } catch (err) {
      await ctx.reply(`❌ ${esc(err.message)}`, { parse_mode: 'HTML' });
    }
  });

  bot.command('scoreall', async (ctx) => {
    const code = ctx.match?.trim();
    if (!code) return ctx.reply('Usage: /scoreall CODE');
    try {
      const r = scoreAllPending(db, code);
      let msg = `✅ Scored ${r.scored}/${r.total} pending submission(s) on <code>${esc(code)}</code>.`;
      if (r.needsGrading) msg += `\n⏳ ${r.needsGrading} still need written-item grading (see /ungraded ${esc(code)}).`;
      if (r.errors.length) msg += `\n\n⚠️ Failures:\n<pre>${esc(r.errors.slice(0, 10).join('\n'))}</pre>`;
      await ctx.reply(msg, { parse_mode: 'HTML' });
    } catch (err) {
      await ctx.reply(`❌ ${esc(err.message)}`, { parse_mode: 'HTML' });
    }
  });

  bot.command('verify', async (ctx) => {
    const id = Number(ctx.match?.trim());
    if (!Number.isInteger(id)) return ctx.reply('Usage: /verify SUBMISSION_ID');
    const result = db.prepare('SELECT * FROM results WHERE submission_id = ?').get(id);
    if (!result) return ctx.reply(`#${id} has no result yet. /score ${id} first.`);
    db.prepare('UPDATE results SET verified_by = ? WHERE submission_id = ?').run(ctx.from.id, id);
    db.prepare("UPDATE submissions SET status = 'verified' WHERE id = ?").run(id);
    await ctx.reply(`✅ #${id} marked verified. Score itself is unchanged and unchangeable.`);
  });

  /* ---------------- status & publishing ---------------- */

  bot.command('status', async (ctx) => {
    const code = ctx.match?.trim();
    if (!code) return ctx.reply('Usage: /status CODE');
    try {
      const status = testStatusCounts(db, code);
      await ctx.reply(statusReport(status), {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '📊 Calculate & Publish Results', callback_data: `publish:${status.test.code}` }]],
        },
      });
    } catch (err) {
      await ctx.reply(`❌ ${esc(err.message)}`, { parse_mode: 'HTML' });
    }
  });

  bot.callbackQuery(/^publish:(.+)$/, async (ctx) => {
    const code = ctx.match[1];
    await ctx.answerCallbackQuery();
    try {
      const result = publishResults(db, code);
      let msg = result.scoredIds.length
        ? `✅ Published ${result.scored} result(s) for <code>${esc(code)}</code>.`
        : `Nothing new to publish for <code>${esc(code)}</code> — everything ready was already scored.`;
      if (result.errors.length) {
        msg += `\n\n⚠️ ${result.errors.length} failed:\n<pre>${esc(result.errors.slice(0, 10).join('\n'))}</pre>`;
      }
      await ctx.reply(msg, { parse_mode: 'HTML' });

      for (const n of result.notifications) {
        await notifyStudent(ctx, n.submission_id);
      }
    } catch (err) {
      await ctx.reply(`❌ ${esc(err.message)}`, { parse_mode: 'HTML' });
    }
  });

  async function notifyStudent(ctx, submissionId) {
    const row = db
      .prepare(
        `SELECT st.telegram_id, st.full_name, t.title, t.code, r.raw_score, r.item_count,
                r.scaled_score, r.grade
         FROM results r
         JOIN submissions s ON s.id = r.submission_id
         JOIN students st   ON st.id = s.student_id
         JOIN tests t       ON t.id = s.test_id
         WHERE r.submission_id = ?`,
      )
      .get(submissionId);
    if (!row) return;
    await ctx.api
      .sendMessage(
        row.telegram_id,
        `📊 <b>${esc(row.full_name)}</b>, your result for <b>${esc(row.title)}</b> is ready.\n` +
          `Raw ${row.raw_score}/${row.item_count} · Scaled <b>${row.scaled_score}</b> · ` +
          `Level <b>${esc(row.grade)}</b>\n\nFull report: /result`,
        { parse_mode: 'HTML' },
      )
      .catch(() => {});
  }

  /* ---------------- reporting ---------------- */

  bot.command('tests', async (ctx) => {
    const rows = db
      .prepare(
        `SELECT t.*, (SELECT COUNT(*) FROM items WHERE test_id = t.id) AS n_items,
                (SELECT COUNT(*) FROM submissions WHERE test_id = t.id) AS n_subs
         FROM tests t ORDER BY t.created_at DESC LIMIT 25`,
      )
      .all();
    if (!rows.length) return ctx.reply('No tests yet. Create one with /upload.');
    const body = rows
      .map(
        (t) =>
          `${t.status === 'locked' ? '🔒' : t.status === 'draft' ? '📝' : '📦'} ` +
          `<code>${esc(t.code)}</code>${t.template === 'nc55' ? ' [NC55]' : ''} — ${esc(t.title)} · ` +
          `${t.n_items} items · ${t.n_subs} subs`,
      )
      .join('\n');
    await ctx.reply(`<b>Tests</b>\n${body}`, { parse_mode: 'HTML' });
  });

  bot.command('results', async (ctx) => {
    const code = ctx.match?.trim();
    if (!code) return ctx.reply('Usage: /results CODE');
    try {
      await ctx.reply(resultsTable(listResults(db, code), code.toUpperCase()), { parse_mode: 'HTML' });
    } catch (err) {
      await ctx.reply(`❌ ${esc(err.message)}`, { parse_mode: 'HTML' });
    }
  });

  bot.command('table', async (ctx) => {
    const code = ctx.match?.trim();
    if (!code) return ctx.reply('Usage: /table CODE');
    try {
      const { test, table } = scoreTableFor(db, code);
      const body = table
        .map(
          (r) =>
            `${String(r.rawScore).padStart(3)} ${(r.theta >= 0 ? '+' : '') + r.theta.toFixed(2)}`.padEnd(11) +
            `${String(r.scaledScore).padStart(5)}  ${r.grade}`,
        )
        .join('\n');
      await ctx.reply(
        `<b>Conversion chart — ${esc(test.code)}</b>\n` +
          `<i>Fixed by the anchors; valid before the first student and after the millionth.</i>\n` +
          `<pre>raw  theta  scaled  lvl\n${esc(body)}</pre>`,
        { parse_mode: 'HTML' },
      );
    } catch (err) {
      await ctx.reply(`❌ ${esc(err.message)}`, { parse_mode: 'HTML' });
    }
  });

  bot.command('drift', async (ctx) => {
    const code = ctx.match?.trim();
    if (!code) return ctx.reply('Usage: /drift CODE');
    try {
      await ctx.reply(driftReport(anchorDriftReport(db, code)), { parse_mode: 'HTML' });
    } catch (err) {
      await ctx.reply(`❌ ${esc(err.message)}`, { parse_mode: 'HTML' });
    }
  });

  bot.command('export', async (ctx) => {
    const code = ctx.match?.trim();
    if (!code) return ctx.reply('Usage: /export CODE');
    const test = getTestByCode(db, code);
    if (!test) return ctx.reply(`No test with code ${esc(code)}`);

    const rows = db
      .prepare(
        `SELECT st.telegram_id, st.full_name, st.username, s.id AS submission_id, s.submitted_at,
                r.raw_score, r.item_count, r.theta, r.se, r.scaled_score, r.grade,
                r.scale_version, r.anchor_checksum, r.method, r.engine_version
         FROM results r
         JOIN submissions s ON s.id = r.submission_id
         JOIN students st   ON st.id = s.student_id
         WHERE s.test_id = ? ORDER BY r.scaled_score DESC`,
      )
      .all(test.id);
    if (!rows.length) return ctx.reply('No results to export.');

    const header = Object.keys(rows[0]).join(',');
    const csv = [
      header,
      ...rows.map((r) =>
        Object.values(r)
          .map((v) => (typeof v === 'string' && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v))
          .join(','),
      ),
    ].join('\n');

    // Buffer-backed InputFile: the CSV never touches disk.
    await ctx.replyWithDocument(
      new InputFile(Buffer.from(csv, 'utf8'), `${test.code}-results.csv`),
      { caption: `${rows.length} result(s) for ${test.code}` },
    );
  });

  return composer;
}
