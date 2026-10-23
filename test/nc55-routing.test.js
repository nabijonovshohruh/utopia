/**
 * Drives the real grammy middleware chain (synthetic Telegram updates, no
 * network) through the NC55-specific admin/student workflow: upload with an
 * auto-generated code, lock, a student's chat-fallback submission, manual
 * grading of written sub-items, and the /status "Calculate & Publish
 * Results" button via a simulated callback_query.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from 'grammy';

const ADMIN_ID = 1;
const STUDENT_ID = 2;

process.env.BOT_TOKEN = '123456789:AAHtest-token-for-the-nc55-routing-suite';
process.env.ADMIN_IDS = String(ADMIN_ID);

const { openDb } = await import('../src/db/index.js');
const { adminRoutes } = await import('../src/bot/admin.js');
const { studentRoutes } = await import('../src/bot/student.js');
const { nc55Items } = await import('../src/domain/nc55.js');

function nc55Key(code) {
  const lines = nc55Items().map((i) =>
    i.itemType === 'mcq' ? `${i.label} ${i.options[0]} -1.0` : `${i.label} -1.0`,
  );
  return ['TEMPLATE: NC55', code ? `CODE: ${code}` : null, 'TITLE: NC Routing Fixture', 'ITEMS:', ...lines]
    .filter(Boolean)
    .join('\n');
}

function harness() {
  const db = openDb(':memory:');
  const bot = new Bot(process.env.BOT_TOKEN, {
    botInfo: {
      id: 1,
      is_bot: true,
      first_name: 'TestBot',
      username: 'testbot',
      can_join_groups: false,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
    },
  });
  const sent = [];
  bot.api.config.use((prev, method, payload) => {
    sent.push({ method, payload });
    if (method === 'sendMessage') {
      return {
        ok: true,
        result: { message_id: sent.length, date: 0, chat: { id: payload.chat_id, type: 'private' }, text: payload.text },
      };
    }
    return { ok: true, result: true };
  });

  bot.use(adminRoutes(db));
  bot.use(studentRoutes(db));
  return { bot, sent, db };
}

let updateId = 0;
function message(bot, userId, text) {
  return bot.handleUpdate({
    update_id: ++updateId,
    message: {
      message_id: ++updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: userId, type: 'private' },
      from: { id: userId, is_bot: false, first_name: `U${userId}` },
      text,
      entities: text.startsWith('/')
        ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }]
        : undefined,
    },
  });
}

function callbackQuery(bot, userId, data) {
  return bot.handleUpdate({
    update_id: ++updateId,
    callback_query: {
      id: String(++updateId),
      from: { id: userId, is_bot: false, first_name: `U${userId}` },
      message: {
        message_id: ++updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: userId, type: 'private' },
        text: 'status',
      },
      chat_instance: '1',
      data,
    },
  });
}

const texts = (sent) => sent.filter((s) => s.method === 'sendMessage').map((s) => s.payload.text);
const textsTo = (sent, chatId) =>
  sent.filter((s) => s.method === 'sendMessage' && s.payload.chat_id === chatId).map((s) => s.payload.text);

/** Runs the two-step /start -> name registration flow for a student. */
async function registerStudent(bot, userId, name = `Test Student ${userId}`) {
  await message(bot, userId, '/start');
  await message(bot, userId, name);
}

function allWrittenGrades(value) {
  // '36a=1 36b=0 37a=1 ...' for all 20 written sub-items, same value each.
  const parts = [];
  for (let q = 36; q <= 45; q++) parts.push(`${q}a=${value}`, `${q}b=${value}`);
  return parts.join(' ');
}

test('upload without CODE auto-generates one, and locking mentions the grading workflow', async (t) => {
  const { bot, sent, db } = harness();
  t.after(() => db.close());
  await bot.init();

  await message(bot, ADMIN_ID, `/upload ${nc55Key(null)}`);
  const uploadReply = texts(sent).at(-1);
  assert.match(uploadReply, /Draft saved/);
  assert.match(uploadReply, /code auto-generated/);
  const code = uploadReply.match(/<code>(TEST-\d{4})<\/code>/)[1];

  await message(bot, ADMIN_ID, `/lock ${code}`);
  const lockReply = texts(sent).at(-1);
  assert.match(lockReply, /is locked/);
  assert.match(lockReply, /written sub-items need your manual 0\/1 grade/);
  assert.match(lockReply, new RegExp(`/writing SUBMISSION_ID`));
});

test('full NC55 flow: chat submission, grading, status, and publish via the button', async (t) => {
  const { bot, sent, db } = harness();
  t.after(() => db.close());
  await bot.init();

  await message(bot, ADMIN_ID, `/upload ${nc55Key('TEST-9001')}`);
  await message(bot, ADMIN_ID, '/lock TEST-9001');

  await registerStudent(bot, STUDENT_ID);
  // Student opens the test without a Mini App configured -> chat fallback.
  await message(bot, STUDENT_ID, '/test TEST-9001');
  const testReply = textsTo(sent, STUDENT_ID).at(-1);
  assert.match(testReply, /35 multiple-choice \+ 20 written sub-items/);
  assert.match(testReply, /ONE message/);

  // Compact mcq line + one written line per sub-item, all correct mcq.
  const mcqLine = nc55Items()
    .filter((i) => i.itemType === 'mcq')
    .map((i) => `${i.label}${i.options[0]}`)
    .join(' ');
  const writtenLines = [];
  for (let q = 36; q <= 45; q++) {
    writtenLines.push(`${q}a: because of reasons`, `${q}b: another good reason`);
  }
  await message(bot, STUDENT_ID, [mcqLine, ...writtenLines].join('\n'));
  const submitReply = textsTo(sent, STUDENT_ID).at(-1);
  assert.match(submitReply, /Received 55\/55 answers/);
  assert.match(submitReply, /graded by your teacher/);
  const subId = Number(submitReply.match(/#(\d+)/)[1]);

  // A second /test attempt is refused (already submitted).
  await message(bot, STUDENT_ID, '/test TEST-9001');
  assert.match(textsTo(sent, STUDENT_ID).at(-1), /already submitted/);

  // Admin sees it pending, with 20 ungraded.
  await message(bot, ADMIN_ID, '/pending');
  assert.match(textsTo(sent, ADMIN_ID).at(-1), /⏳20 to grade/);

  await message(bot, ADMIN_ID, '/ungraded TEST-9001');
  assert.match(textsTo(sent, ADMIN_ID).at(-1), new RegExp(`#${subId} .* 20 item\\(s\\) left`));

  // Trying to score before grading is refused with an actionable message.
  await message(bot, ADMIN_ID, `/score ${subId}`);
  assert.match(textsTo(sent, ADMIN_ID).at(-1), /ungraded written response/);

  // /writing shows the prompt and puts the admin in grading mode.
  await message(bot, ADMIN_ID, `/writing ${subId}`);
  const writingPrompt = textsTo(sent, ADMIN_ID).at(-1);
  assert.match(writingPrompt, /20 item\(s\) pending/);
  assert.match(writingPrompt, /because of reasons/);

  // Grade in two batches to prove partial grading + resumption works. Every
  // sub-item gets 1, so the eventual raw score is predictable (55/55).
  const firstHalf = ['36a=1', '36b=1', '37a=1', '37b=1', '38a=1'].join(' ');
  await message(bot, ADMIN_ID, firstHalf);
  assert.match(textsTo(sent, ADMIN_ID).at(-1), /still ungraded for #\d+/);

  const rest = [];
  for (let q = 38; q <= 45; q++) {
    if (q === 38) rest.push('38b=1');
    else rest.push(`${q}a=1`, `${q}b=1`);
  }
  await message(bot, ADMIN_ID, rest.join(' '));
  const doneMsg = textsTo(sent, ADMIN_ID).at(-1);
  assert.match(doneMsg, /All written items .* are graded/);

  // A message that isn't in grading mode anymore is treated as a normal
  // (non-grading) admin message, not swallowed silently.
  await message(bot, ADMIN_ID, '/status TEST-9001');
  const statusMsg = sent.filter((s) => s.method === 'sendMessage').at(-1);
  assert.match(statusMsg.payload.text, /Ready to score: <b>1<\/b>/);
  assert.ok(statusMsg.payload.reply_markup.inline_keyboard[0][0].text.includes('Publish'));
  const callbackData = statusMsg.payload.reply_markup.inline_keyboard[0][0].callback_data;
  assert.equal(callbackData, 'publish:TEST-9001');

  // Simulate tapping the button.
  await callbackQuery(bot, ADMIN_ID, callbackData);
  assert.ok(sent.some((s) => s.method === 'answerCallbackQuery'));
  assert.match(textsTo(sent, ADMIN_ID).at(-1), /Published 1 result/);

  // The student was notified on their own chat.
  const studentNotice = textsTo(sent, STUDENT_ID).at(-1);
  assert.match(studentNotice, /result for <b>NC Routing Fixture<\/b> is ready/);
  assert.match(studentNotice, /Raw 55\/55/); // 35 correct mcq + 20 correct written (all graded 1)

  // /result shows the full Rasch report.
  await message(bot, STUDENT_ID, '/result');
  assert.match(textsTo(sent, STUDENT_ID).at(-1), /Raw score\s+<b>55 \/ 55<\/b>/);

  // Publishing again is a safe no-op.
  await callbackQuery(bot, ADMIN_ID, callbackData);
  assert.match(textsTo(sent, ADMIN_ID).at(-1), /Nothing new to publish/);
});

test('publish is refused via the button while grading is incomplete', async (t) => {
  const { bot, sent, db } = harness();
  t.after(() => db.close());
  await bot.init();

  await message(bot, ADMIN_ID, `/upload ${nc55Key('TEST-9002')}`);
  await message(bot, ADMIN_ID, '/lock TEST-9002');
  await registerStudent(bot, STUDENT_ID);
  await message(bot, STUDENT_ID, '/test TEST-9002');

  const mcqLine = nc55Items()
    .filter((i) => i.itemType === 'mcq')
    .map((i) => `${i.label}${i.options[0]}`)
    .join(' ');
  await message(bot, STUDENT_ID, mcqLine); // written items left blank/ungraded

  await message(bot, ADMIN_ID, '/status TEST-9002');
  const statusMsg = texts(sent).at(-1);
  assert.match(statusMsg, /Needs written grading: <b>1<\/b>/);

  await callbackQuery(bot, ADMIN_ID, 'publish:TEST-9002');
  assert.match(textsTo(sent, ADMIN_ID).at(-1), /still have ungraded written answers/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM results').get().c, 0);
});

test('gradeWrittenResponses rejection surfaces as a chat error, not a crash', async (t) => {
  const { bot, sent, db } = harness();
  t.after(() => db.close());
  await bot.init();

  await message(bot, ADMIN_ID, `/upload ${nc55Key('TEST-9003')}`);
  await message(bot, ADMIN_ID, '/lock TEST-9003');
  await registerStudent(bot, STUDENT_ID);
  await message(bot, STUDENT_ID, '/test TEST-9003');
  const mcqLine = nc55Items()
    .filter((i) => i.itemType === 'mcq')
    .map((i) => `${i.label}${i.options[0]}`)
    .join(' ');
  await message(bot, STUDENT_ID, `${mcqLine}\n36a: ok\n36b: ok`);
  const subId = Number(textsTo(sent, STUDENT_ID).at(-1).match(/#(\d+)/)[1]);

  await message(bot, ADMIN_ID, `/writing ${subId}`);
  await message(bot, ADMIN_ID, '36a=1 36b=5'); // 5 is not a valid binary score
  assert.match(textsTo(sent, ADMIN_ID).at(-1), /score must be 0 or 1/);
});

