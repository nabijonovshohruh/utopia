import { Composer } from 'grammy';
import { config } from '../config.js';
import { getTestByCode, getItems, getBands } from '../services/tests.js';
import {
  parseAnswers,
  recordSubmission,
  parseLabeledAnswers,
  recordSubmissionByLabel,
  getOrCreateStudent,
  parseFullName,
  registerFullName,
  setActiveTest,
  latestSubmission,
} from '../services/submissions.js';
import { scoreSubmission, getResultBundle } from '../services/scoring.js';
import { studentReport, esc, STUDENT_HELP } from './format.js';
import { NC55_TEMPLATE } from '../domain/nc55.js';

export function studentRoutes(db) {
  const bot = new Composer();

  const formatHelp = (count) =>
    [
      `This test has <b>${count}</b> items. Send your answers in one message:`,
      '',
      `• <code>${'ABCD'.repeat(Math.ceil(Math.min(count, 8) / 4)).slice(0, count)}</code> — letters in order`,
      '• <code>A B C D …</code> — space separated',
      '• <code>1A 2C 3B …</code> — numbered (safest)',
      '',
      'Use <code>-</code> for an item you want to skip.',
    ].join('\n');

  const formatNc55Help = (items) => {
    const mcqCount = items.filter((i) => i.item_type === 'mcq').length;
    const writtenCount = items.filter((i) => i.item_type === 'written').length;
    return [
      `This test has <b>${items.length}</b> items: ${mcqCount} multiple-choice + ${writtenCount} written sub-items.`,
      '',
      '<b>Send every answer in ONE message</b>, one item per line — except multiple-choice items, ' +
        'which can share a line:',
      '',
      '• <code>1A 2B 3C … 35F</code> — multiple-choice, as many per line as you like',
      '• <code>36a: your answer</code> — one written sub-item per line, free text after the label',
      '',
      'Unmentioned items are left blank. Telegram messages cap out around 4000 characters, so keep ' +
        'written answers concise here — or use the answer form if your teacher has one set up.',
    ].join('\n');
  };

  const miniAppButton = (test) => ({
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: '📝 Open Answer Form',
            web_app: { url: `${config.miniAppPublicUrl}/?code=${encodeURIComponent(test.code)}` },
          },
        ],
      ],
    },
  });

  // The general-purpose button shown on /start — no test code yet, so it
  // just lands on the Mini App's own code-entry screen. Returns undefined
  // (not attached) when no public URL is configured, same graceful
  // degradation as the per-test button above — there's nowhere to point it.
  const miniAppOpenButton = () =>
    config.miniAppPublicUrl
      ? { inline_keyboard: [[{ text: 'Ilovani ochish', web_app: { url: config.miniAppPublicUrl } }]] }
      : undefined;

  bot.command('start', async (ctx) => {
    const student = getOrCreateStudent(db, ctx.from);
    const reply_markup = miniAppOpenButton();
    const opts = reply_markup ? { parse_mode: 'HTML', reply_markup } : { parse_mode: 'HTML' };

    if (!student.registered) {
      await ctx.reply('Botga xush kelibsiz! 👋\n\nIltimos, ism va familiyangizni kiriting:', opts);
      return;
    }

    await ctx.reply(
      `Xush kelibsiz, ${esc(student.full_name)}! 👋\n\n` +
        'Send <code>/test CODE</code> with the code your teacher gave you.\n\n' +
        STUDENT_HELP,
      opts,
    );
  });

  bot.command('help', (ctx) => ctx.reply(STUDENT_HELP, { parse_mode: 'HTML' }));

  bot.command('test', async (ctx) => {
    const code = ctx.match?.trim();
    if (!code) return ctx.reply('Usage: /test MATH-2026-A');

    const test = getTestByCode(db, code);
    if (!test) return ctx.reply(`No test with code ${esc(code)}. Check it with your teacher.`);
    if (test.status === 'archived') return ctx.reply(`${esc(test.code)} is closed.`);
    if (test.status === 'draft') {
      return ctx.reply(`${esc(test.code)} is not open yet — your teacher still has to publish it.`);
    }

    const student = getOrCreateStudent(db, ctx.from);
    if (!student.registered) {
      return ctx.reply(
        "Avval ism-familiyangizni ro'yxatdan o'tkazing: /start buyrug'ini yuboring.",
        { parse_mode: 'HTML' },
      );
    }
    const items = getItems(db, test.id);

    const prior = latestSubmission(db, student.id, test.id);
    if (prior) {
      return ctx.reply(
        `You already submitted <b>${esc(test.title)}</b> (#${prior.id}).\n` +
          'Use /result to see your score. Contact your teacher if you need a re-sit.',
        { parse_mode: 'HTML' },
      );
    }

    setActiveTest(db, student.id, test.id);

    if (test.template === NC55_TEMPLATE && config.miniAppPublicUrl) {
      await ctx.reply(
        `<b>${esc(test.title)}</b>\n<code>${esc(test.code)}</code>\n\nTap below to open the answer form.`,
        miniAppButton(test),
      );
      return;
    }

    const help = test.template === NC55_TEMPLATE ? formatNc55Help(items) : formatHelp(items.length);
    await ctx.reply(`<b>${esc(test.title)}</b>\n<code>${esc(test.code)}</code>\n\n${help}`, {
      parse_mode: 'HTML',
    });
  });

  bot.command('answers', async (ctx) => {
    const student = getOrCreateStudent(db, ctx.from);
    if (!student.active_test_id) return ctx.reply('Open a test first: /test CODE');
    const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(student.active_test_id);
    const items = getItems(db, student.active_test_id);
    const help = test.template === NC55_TEMPLATE ? formatNc55Help(items) : formatHelp(items.length);
    await ctx.reply(help, { parse_mode: 'HTML' });
  });

  bot.command('result', async (ctx) => {
    const student = getOrCreateStudent(db, ctx.from);
    const row = db
      .prepare(
        `SELECT r.submission_id FROM results r
         JOIN submissions s ON s.id = r.submission_id
         WHERE s.student_id = ? ORDER BY r.id DESC LIMIT 1`,
      )
      .get(student.id);
    if (!row) return ctx.reply('No scored results yet.');

    const bundle = getResultBundle(db, row.submission_id);
    const test = db.prepare('SELECT * FROM tests WHERE code = ?').get(bundle.code);
    await ctx.reply(
      studentReport({
        test,
        submissionId: bundle.submission_id,
        bands: getBands(db, test.id),
        studentName: bundle.full_name,
        scored: {
          rawScore: bundle.raw_score,
          itemCount: bundle.item_count,
          percentCorrect: (bundle.raw_score / bundle.item_count) * 100,
          theta: bundle.theta,
          se: bundle.se,
          scaledScore: bundle.scaled_score,
          scaledSe: Math.round(Math.abs(test.scale_slope * bundle.se)),
          grade: bundle.grade,
        },
      }),
      { parse_mode: 'HTML' },
    );
  });

  bot.command('mytests', async (ctx) => {
    const student = getOrCreateStudent(db, ctx.from);
    const rows = db
      .prepare(
        `SELECT t.code, t.title, s.id AS sid, s.status, r.raw_score, r.item_count,
                r.scaled_score, r.grade
         FROM submissions s
         JOIN tests t ON t.id = s.test_id
         LEFT JOIN results r ON r.submission_id = s.id
         WHERE s.student_id = ? ORDER BY s.id DESC LIMIT 20`,
      )
      .all(student.id);
    if (!rows.length) return ctx.reply('You have not taken any tests yet.');

    const body = rows
      .map((r) =>
        r.scaled_score === null
          ? `• <code>${esc(r.code)}</code> — awaiting grading`
          : `• <code>${esc(r.code)}</code> — ${r.raw_score}/${r.item_count} · ${r.scaled_score} · <b>${esc(r.grade)}</b>`,
      )
      .join('\n');
    await ctx.reply(`<b>Your tests</b>\n${body}`, { parse_mode: 'HTML' });
  });

  // Free text: name registration takes priority over everything else — an
  // unregistered student can't meaningfully be "mid-test" yet, since /test
  // itself is gated on registration too.
  bot.on('message:text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return;
    const student = getOrCreateStudent(db, ctx.from);

    if (!student.registered) {
      const { name, error } = parseFullName(ctx.message.text);
      if (error) {
        await ctx.reply(`⚠️ ${esc(error)}`, { parse_mode: 'HTML' });
        return;
      }
      registerFullName(db, ctx.from.id, name);
      await ctx.reply(
        `Rahmat, ${esc(name)}! ✅\n\nEndi <code>/test CODE</code> orqali testni boshlashingiz mumkin.`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    if (!student.active_test_id) {
      return ctx.reply('Send /test CODE to begin, or /help for the command list.');
    }

    const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(student.active_test_id);
    const items = getItems(db, test.id);

    if (latestSubmission(db, student.id, test.id)) {
      setActiveTest(db, student.id, null);
      return ctx.reply('You have already submitted this test. Use /result.');
    }

    if (test.template === NC55_TEMPLATE) {
      const { answers, error } = parseLabeledAnswers(ctx.message.text, items);
      if (error) return ctx.reply(`⚠️ ${esc(error)}`, { parse_mode: 'HTML' });

      const submissionId = recordSubmissionByLabel(db, {
        testId: test.id,
        studentId: student.id,
        rawInput: ctx.message.text,
        answersByLabel: answers,
        source: 'chat',
      });
      setActiveTest(db, student.id, null);

      const answeredCount = Object.values(answers).filter((a) => a !== null).length;
      await ctx.reply(
        `✅ Received ${answeredCount}/${items.length} answers for <b>${esc(test.title)}</b> (#${submissionId}).\n\n` +
          'Written items are graded by your teacher before scoring. You will be notified once results are published.',
        { parse_mode: 'HTML' },
      );
      return;
    }

    // 'custom' template: original positional (mcq-only) flow, unchanged.
    const { answers, error } = parseAnswers(ctx.message.text, items.length);
    if (error) return ctx.reply(`⚠️ ${esc(error)}`, { parse_mode: 'HTML' });

    const submissionId = recordSubmission(db, {
      testId: test.id,
      studentId: student.id,
      rawInput: ctx.message.text,
      answers,
    });
    setActiveTest(db, student.id, null);

    const answered = answers.filter((a) => a !== null).length;
    await ctx.reply(
      `✅ Received ${answered}/${items.length} answers for <b>${esc(test.title)}</b> (#${submissionId}).`,
      { parse_mode: 'HTML' },
    );

    if (!test.auto_grade) {
      return ctx.reply('Your teacher will release the score after review.');
    }

    try {
      const { scored } = scoreSubmission(db, submissionId);
      await ctx.reply(
        studentReport({ test, scored, submissionId, bands: getBands(db, test.id), studentName: student.full_name }),
        { parse_mode: 'HTML' },
      );
    } catch (err) {
      console.error('auto-grade failed', err);
      await ctx.reply('Your answers are saved, but scoring failed. Your teacher has been notified.');
      ctx.api
        .sendMessage(test.created_by, `⚠️ Auto-grade failed on #${submissionId}: ${err.message}`)
        .catch(() => {});
    }
  });

  return bot;
}
