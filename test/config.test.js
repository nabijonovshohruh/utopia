/**
 * Config validation guards startup, so it needs its own coverage.
 *
 * config.js snapshots process.env at module-evaluation time, so each case
 * imports a fresh instance via a cache-busting query string.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

let n = 0;
async function withEnv(env) {
  const saved = { ...process.env };
  for (const key of ['BOT_TOKEN', 'ADMIN_IDS', 'DB_PATH']) delete process.env[key];
  Object.assign(process.env, env);
  try {
    return await import(`../src/config.js?case=${++n}`);
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

const GOOD_TOKEN = '8012345678:AAHdq1x9kP2mZvQ7rT4nB6wE3sY8uI0oL5c';

test('a correct environment reports no problems', async () => {
  const { checkConfig, config } = await withEnv({ BOT_TOKEN: GOOD_TOKEN, ADMIN_IDS: '613204857' });
  assert.deepEqual(checkConfig(), { errors: [], warnings: [] });
  assert.deepEqual(config.adminIds, [613204857]);
});

test('importing config never throws, so DB-only scripts run without a token', async () => {
  // migrate/seed/doctor must work before a bot token exists.
  const { config, checkConfig } = await withEnv({});
  assert.equal(config.botToken, '');
  assert.deepEqual(config.adminIds, []);
  // Token problems are suppressed when the caller does not need one...
  assert.ok(!checkConfig({ requireToken: false }).errors.some((e) => /BOT_TOKEN/.test(e)));
  // ...but reported by default.
  assert.ok(checkConfig().errors.some((e) => /BOT_TOKEN is not set/.test(e)));
});

test('the shipped .env placeholders are detected, not accepted', async () => {
  const { checkConfig } = await withEnv({
    BOT_TOKEN: 'PASTE_YOUR_BOTFATHER_TOKEN_HERE',
    ADMIN_IDS: 'PASTE_YOUR_NUMERIC_TELEGRAM_ID_HERE',
  });
  const { errors } = checkConfig();
  assert.equal(errors.length, 2);
  assert.ok(errors.some((e) => /BOT_TOKEN is still the placeholder/.test(e)));
  assert.ok(errors.some((e) => /ADMIN_IDS is not set/.test(e)));
});

test('the .env.example placeholder token is detected too', async () => {
  const { checkConfig } = await withEnv({
    BOT_TOKEN: '123456:ABC-DEF_your_token_here',
    ADMIN_IDS: '111111111',
  });
  assert.ok(checkConfig().errors.some((e) => /placeholder/.test(e)));
});

test('a malformed token is rejected with a specific hint', async () => {
  for (const bad of ['123:test', 'abcdef:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', '8012345678']) {
    const { checkConfig } = await withEnv({ BOT_TOKEN: bad, ADMIN_IDS: '1' });
    const { errors } = checkConfig();
    assert.equal(errors.length, 1, `expected "${bad}" to be rejected`);
    assert.match(errors[0], /does not look like a Telegram token/);
  }
});

test('a token wrapped in quotes is rejected rather than silently failing later', async () => {
  // A very common .env mistake: BOT_TOKEN="8012…" keeps the quotes.
  const { checkConfig } = await withEnv({ BOT_TOKEN: `"${GOOD_TOKEN}"`, ADMIN_IDS: '1' });
  assert.match(checkConfig().errors[0], /stray quotes/);
});

test('@usernames in ADMIN_IDS are rejected with the numeric-ID hint', async () => {
  const { checkConfig } = await withEnv({ BOT_TOKEN: GOOD_TOKEN, ADMIN_IDS: '@teacher,613204857' });
  const { errors } = checkConfig();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /non-numeric entries: @teacher/);
  assert.match(errors[0], /userinfobot/);
});

test('multiple admins and untidy whitespace are parsed', async () => {
  const { config, checkConfig } = await withEnv({
    BOT_TOKEN: GOOD_TOKEN,
    ADMIN_IDS: ' 111 , 222,333 ,',
  });
  assert.deepEqual(config.adminIds, [111, 222, 333]);
  assert.deepEqual(checkConfig().errors, []);
});

test('isAdmin accepts string and numeric ids, rejects everyone else', async () => {
  const { isAdmin } = await withEnv({ BOT_TOKEN: GOOD_TOKEN, ADMIN_IDS: '111,222' });
  assert.equal(isAdmin(111), true);
  assert.equal(isAdmin('222'), true);
  assert.equal(isAdmin(999), false);
  assert.equal(isAdmin(undefined), false);
  assert.equal(isAdmin(null), false);
});

test('DB_PATH falls back to the documented default and resolves absolute', async () => {
  const fallback = await withEnv({ BOT_TOKEN: GOOD_TOKEN, ADMIN_IDS: '1' });
  assert.equal(fallback.config.dbPath, path.resolve('./data/rasch.sqlite'));

  const custom = await withEnv({ BOT_TOKEN: GOOD_TOKEN, ADMIN_IDS: '1', DB_PATH: './tmp/x.sqlite' });
  assert.equal(custom.config.dbPath, path.resolve('./tmp/x.sqlite'));
  assert.ok(path.isAbsolute(custom.config.dbPath));

  // An empty DB_PATH must not resolve to the current directory.
  const blank = await withEnv({ BOT_TOKEN: GOOD_TOKEN, ADMIN_IDS: '1', DB_PATH: '   ' });
  assert.equal(blank.config.dbPath, path.resolve('./data/rasch.sqlite'));
});
