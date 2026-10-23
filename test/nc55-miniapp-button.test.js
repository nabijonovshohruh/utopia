/**
 * Isolated in its own file: config.js snapshots process.env.MINIAPP_PUBLIC_URL
 * at module-evaluation time, and admin.js/student.js import it via a fixed
 * (non-parameterized) relative specifier, so a query-string cache-busting
 * trick can't force a fresh copy mid-file the way it can for a leaf module.
 * Node's test runner gives each test FILE its own module graph, so setting
 * the env var before any import in a dedicated file is the reliable way to
 * get a build of config.js that reflects it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from 'grammy';

const ADMIN_ID = 1;
const STUDENT_ID = 2;

process.env.BOT_TOKEN = '123456789:AAHtest-token-for-the-miniapp-button-suite';
process.env.ADMIN_IDS = String(ADMIN_ID);
process.env.MINIAPP_PUBLIC_URL = 'https://example.test/miniapp';

const { openDb } = await import('../src/db/index.js');
const { adminRoutes } = await import('../src/bot/admin.js');
const { studentRoutes } = await import('../src/bot/student.js');
const { nc55Items } = await import('../src/domain/nc55.js');
const { config } = await import('../src/config.js');

test('config actually picked up MINIAPP_PUBLIC_URL in this process', () => {
  assert.equal(config.miniAppPublicUrl, 'https://example.test/miniapp');
});

test('when MINIAPP_PUBLIC_URL is configured, /test sends a web_app button instead of chat instructions', async (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());
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
  await bot.init();

  let updateId = 0;
  const message = (userId, text) =>
    bot.handleUpdate({
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

  const lines = nc55Items().map((i) => (i.itemType === 'mcq' ? `${i.label} ${i.options[0]} -1.0` : `${i.label} -1.0`));
  const key = ['TEMPLATE: NC55', 'CODE: TEST-9004', 'TITLE: Mini App Fixture', 'ITEMS:', ...lines].join('\n');

  await message(ADMIN_ID, `/upload ${key}`);
  await message(ADMIN_ID, '/lock TEST-9004');
  await message(STUDENT_ID, '/test TEST-9004');

  const last = sent.filter((s) => s.method === 'sendMessage' && s.payload.chat_id === STUDENT_ID).at(-1);
  assert.match(last.payload.text, /Tap below to open the answer form/);
  const button = last.payload.reply_markup.inline_keyboard[0][0];
  assert.equal(button.text, '📝 Open Answer Form');
  assert.equal(button.web_app.url, 'https://example.test/miniapp/?code=TEST-9004');
});

test('a custom (non-NC55) test never gets the Mini App button, even with the URL configured', async (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());
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
  await bot.init();

  let updateId = 0;
  const message = (userId, text) =>
    bot.handleUpdate({
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

  await message(ADMIN_ID, '/upload CODE: OLD9\nTITLE: Legacy\nITEMS:\n1 A -1\n2 B 0');
  await message(ADMIN_ID, '/lock OLD9');
  await message(STUDENT_ID, '/test OLD9');

  const last = sent.filter((s) => s.method === 'sendMessage' && s.payload.chat_id === STUDENT_ID).at(-1);
  assert.doesNotMatch(last.payload.text, /Tap below/);
  assert.equal(last.payload.reply_markup, undefined);
});
