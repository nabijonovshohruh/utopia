/**
 * Drives the real grammy middleware chain with synthetic updates.
 *
 * Guards the composer wiring, which unit tests on the services cannot reach:
 * in particular that a non-admin update falls THROUGH adminRoutes into
 * studentRoutes. A gate middleware that forgets to call next() on failure
 * silences the bot for every student, and nothing else in the suite notices.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from 'grammy';

const ADMIN_ID = 1;
const STUDENT_ID = 2;

// config.js reads process.env at module-evaluation time, and static imports
// are hoisted above any assignment here — so the app modules must be pulled
// in dynamically, after the environment is in place.
process.env.BOT_TOKEN = '123456789:AAHtest-token-for-the-routing-suite';
process.env.ADMIN_IDS = String(ADMIN_ID);

const { openDb } = await import('../src/db/index.js');
const { adminRoutes } = await import('../src/bot/admin.js');
const { studentRoutes } = await import('../src/bot/student.js');
const { parseAnswerKey, upsertDraftTest, lockTest } = await import('../src/services/tests.js');

const KEY = [
  'CODE: R1',
  'TITLE: Routing Test',
  'SCALE: 500 + 50*theta',
  'GRADES: A>=600, B>=500, C>=400, NC>=0',
  'ITEMS:',
  '1 A -1.0',
  '2 B 0.0',
  '3 C 1.0',
].join('\n');

/** A bot whose API calls are captured instead of sent. */
function harness() {
  const db = openDb(':memory:');
  upsertDraftTest(db, parseAnswerKey(KEY), ADMIN_ID);
  lockTest(db, 'R1');

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
      return { ok: true, result: { message_id: sent.length, date: 0, chat: { id: payload.chat_id, type: 'private' }, text: payload.text } };
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

/** Runs the two-step /start -> name registration flow for a student. */
async function registerStudent(bot, userId, name = `Test Student ${userId}`) {
  await message(bot, userId, '/start');
  await message(bot, userId, name);
}

const texts = (sent) => sent.filter((s) => s.method === 'sendMessage').map((s) => s.payload.text);

/** Messages delivered to one specific chat — /score replies to the admin and
 *  notifies the student, so "the last message sent" is ambiguous. */
const textsTo = (sent, chatId) =>
  sent.filter((s) => s.method === 'sendMessage' && s.payload.chat_id === chatId).map((s) => s.payload.text);

test('a student update falls through adminRoutes and gets a reply', async () => {
  const { bot, sent, db } = harness();
  await bot.init();
  await message(bot, STUDENT_ID, '/start');
  const out = texts(sent);
  assert.equal(out.length, 1, 'student got no reply — adminRoutes swallowed the update');
  assert.match(out[0], /ism va familiyangizni kiriting/);
  db.close();
});

test('an unregistered student cannot open a test, and is pointed at /start', async () => {
  const { bot, sent, db } = harness();
  await bot.init();
  await message(bot, STUDENT_ID, '/test R1');
  assert.match(texts(sent).at(-1), /\/start/);
  assert.equal(db.prepare('SELECT active_test_id FROM students WHERE telegram_id=?').get(STUDENT_ID)?.active_test_id ?? null, null);
  db.close();
});

test('registering with a single-word name is rejected; a full name is accepted and unblocks /test', async () => {
  const { bot, sent, db } = harness();
  await bot.init();
  await message(bot, STUDENT_ID, '/start');
  await message(bot, STUDENT_ID, 'Ada');
  assert.match(texts(sent).at(-1), /to'liq kiriting/);
  assert.equal(db.prepare('SELECT registered FROM students WHERE telegram_id=?').get(STUDENT_ID).registered, 0);

  await message(bot, STUDENT_ID, 'Ada Lovelace');
  assert.match(texts(sent).at(-1), /Rahmat, Ada Lovelace/);
  const student = db.prepare('SELECT * FROM students WHERE telegram_id=?').get(STUDENT_ID);
  assert.equal(student.registered, 1);
  assert.equal(student.full_name, 'Ada Lovelace');

  await message(bot, STUDENT_ID, '/test R1');
  assert.match(texts(sent).at(-1), /Routing Test/);
  db.close();
});

test('a returning registered student sees their name on /start', async () => {
  const { bot, sent, db } = harness();
  await bot.init();
  await registerStudent(bot, STUDENT_ID, 'Ada Lovelace');
  await message(bot, STUDENT_ID, '/start');
  assert.match(texts(sent).at(-1), /Xush kelibsiz, Ada Lovelace/);
  db.close();
});

test('full student flow: open a test, submit, receive a Rasch report', async () => {
  const { bot, sent, db } = harness();
  await bot.init();
  await registerStudent(bot, STUDENT_ID, 'Ada Lovelace');
  await message(bot, STUDENT_ID, '/test R1');
  assert.match(texts(sent).at(-1), /Routing Test/);

  await message(bot, STUDENT_ID, 'ABC');
  const out = texts(sent);
  assert.match(out.at(-2), /Received 3\/3 answers/);
  const report = out.at(-1);
  assert.match(report, /Raw score\s+<b>3 \/ 3<\/b>/);
  assert.match(report, /Ability \(θ\)/);
  assert.match(report, /Scaled score/);
  assert.match(report, /does not change as more students submit/);

  // The result is persisted and retrievable.
  await message(bot, STUDENT_ID, '/result');
  assert.match(texts(sent).at(-1), /Raw score\s+<b>3 \/ 3<\/b>/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM results').get().c, 1);
  db.close();
});

test('a malformed answer sheet is rejected without creating a submission', async () => {
  const { bot, sent, db } = harness();
  await bot.init();
  await registerStudent(bot, STUDENT_ID);
  await message(bot, STUDENT_ID, '/test R1');
  await message(bot, STUDENT_ID, 'AB');
  assert.match(texts(sent).at(-1), /Expected 3 answers but read 2/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM submissions').get().c, 0);
  db.close();
});

test('resubmission is refused', async () => {
  const { bot, sent, db } = harness();
  await bot.init();
  await registerStudent(bot, STUDENT_ID);
  await message(bot, STUDENT_ID, '/test R1');
  await message(bot, STUDENT_ID, 'ABC');
  await message(bot, STUDENT_ID, '/test R1');
  assert.match(texts(sent).at(-1), /already submitted/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM submissions').get().c, 1);
  db.close();
});

test('students cannot reach admin commands', async () => {
  const { bot, sent, db } = harness();
  await bot.init();
  await message(bot, STUDENT_ID, '/results R1');
  // No admin handler ran; the student text fallback also ignores commands,
  // so nothing is sent. The important part is that no roster leaks.
  assert.ok(!texts(sent).some((t) => /Results —/.test(t)));
  db.close();
});

test('an admin gets the teacher command set', async () => {
  const { bot, sent, db } = harness();
  await bot.init();
  await message(bot, ADMIN_ID, '/admin');
  assert.match(texts(sent).at(-1), /Teacher commands/);

  await message(bot, ADMIN_ID, '/results R1');
  assert.match(texts(sent).at(-1), /No results yet|Results —/);

  await message(bot, ADMIN_ID, '/table R1');
  assert.match(texts(sent).at(-1), /Conversion chart/);
  db.close();
});

test('admin /upload rejects a bad key and accepts a good one', async () => {
  const { bot, sent, db } = harness();
  await bot.init();
  await message(bot, ADMIN_ID, '/upload CODE: BAD\nITEMS:\n1 A 0');
  assert.match(texts(sent).at(-1), /Could not accept the key/);

  await message(bot, ADMIN_ID, '/upload CODE: NEW1\nTITLE: New Test\nITEMS:\n1 A -0.5\n2 B 0.5');
  assert.match(texts(sent).at(-1), /Draft saved/);
  assert.equal(db.prepare("SELECT status FROM tests WHERE code='NEW1'").get().status, 'draft');
  db.close();
});

test('admin can lock a draft, and cannot lock one with missing anchors', async () => {
  const { bot, sent, db } = harness();
  await bot.init();
  await message(bot, ADMIN_ID, '/upload CODE: NEW2\nTITLE: Partial\nITEMS:\n1 A -0.5\n2 B');
  assert.match(texts(sent).at(-1), /no anchored difficulty/);

  await message(bot, ADMIN_ID, '/lock NEW2');
  assert.match(texts(sent).at(-1), /Cannot lock NEW2/);
  assert.equal(db.prepare("SELECT status FROM tests WHERE code='NEW2'").get().status, 'draft');

  await message(bot, ADMIN_ID, '/upload CODE: NEW3\nTITLE: Full\nITEMS:\n1 A -0.5\n2 B 0.5');
  await message(bot, ADMIN_ID, '/lock NEW3');
  assert.match(texts(sent).at(-1), /is locked/);
  assert.equal(db.prepare("SELECT status FROM tests WHERE code='NEW3'").get().status, 'locked');
  db.close();
});

test('manual grading path: autograde off, then /pending and /score', async () => {
  const { bot, sent, db } = harness();
  await bot.init();
  await message(bot, ADMIN_ID, '/autograde R1 off');
  assert.match(texts(sent).at(-1), /now <b>off<\/b>/);

  await registerStudent(bot, STUDENT_ID);
  await message(bot, STUDENT_ID, '/test R1');
  await message(bot, STUDENT_ID, 'ABX');
  assert.match(texts(sent).at(-1), /teacher will release the score/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM results').get().c, 0);

  await message(bot, ADMIN_ID, '/pending');
  const pending = texts(sent).at(-1);
  assert.match(pending, /raw 2\/3/);
  const subId = Number(pending.match(/#(\d+)/)[1]);

  await message(bot, ADMIN_ID, `/score ${subId}`);
  // The teacher gets the measurement detail...
  assert.match(textsTo(sent, ADMIN_ID).at(-1), /scored: raw <b>2\/3<\/b>/);
  assert.match(textsTo(sent, ADMIN_ID).at(-1), /Person fit/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM results').get().c, 1);

  // ...and the student is notified in their own chat, by their registered name.
  assert.match(
    textsTo(sent, STUDENT_ID).at(-1),
    /<b>Test Student 2<\/b>, your result for <b>Routing Test<\/b> is ready/,
  );

  await message(bot, ADMIN_ID, `/verify ${subId}`);
  assert.match(textsTo(sent, ADMIN_ID).at(-1), /marked verified/);
  assert.equal(db.prepare('SELECT status FROM submissions WHERE id=?').get(subId).status, 'verified');
  db.close();
});

test('a draft test is not open to students', async () => {
  const { bot, sent, db } = harness();
  await bot.init();
  await message(bot, ADMIN_ID, '/upload CODE: NEW4\nTITLE: Draft Only\nITEMS:\n1 A 0\n2 B 1');
  await message(bot, STUDENT_ID, '/test NEW4');
  assert.match(texts(sent).at(-1), /not open yet/);
  db.close();
});

test('an unknown test code is reported, not crashed on', async () => {
  const { bot, sent, db } = harness();
  await bot.init();
  await message(bot, STUDENT_ID, '/test NOPE');
  assert.match(texts(sent).at(-1), /No test with code NOPE/);
  db.close();
});
