import { Bot } from 'grammy';
import { config, checkConfig } from './config.js';
import { openDb } from './db/index.js';
import { adminRoutes } from './bot/admin.js';
import { studentRoutes } from './bot/student.js';
import { ENGINE_VERSION } from './services/rasch.js';

// Fail with an actionable message rather than an opaque Telegram 404 later.
const { errors, warnings } = checkConfig();
for (const w of warnings) console.warn(`warning: ${w}`);
if (errors.length) {
  console.error('\nCannot start — configuration problems:\n');
  errors.forEach((e, i) => console.error(`  ${i + 1}. ${e}`));
  console.error(
    '\nSet the missing variable(s) — .env locally (then "npm run doctor" to re-check), ' +
      'or your host\'s dashboard/variables in production — then restart.\n',
  );
  process.exit(1);
}

const db = openDb(config.dbPath);
const bot = new Bot(config.botToken);

// Admin routes run first and simply fall through for non-admins.
bot.use(adminRoutes(db));
bot.use(studentRoutes(db));

bot.catch((err) => {
  console.error('bot error', err.error ?? err);
  err.ctx?.reply?.('Something went wrong. Please try again.').catch(() => {});
});

await bot.api.setMyCommands([
  { command: 'start', description: 'Register and see instructions' },
  { command: 'test', description: 'Open a test by code' },
  { command: 'result', description: 'Your latest score report' },
  { command: 'mytests', description: 'Tests you have taken' },
  { command: 'help', description: 'Command list' },
]);

const me = await bot.api.getMe();
console.log(`Rasch test bot running as @${me.username}`);
console.log(`Engine: ${ENGINE_VERSION} · DB: ${config.dbPath}`);
console.log(`Admins: ${config.adminIds.join(', ') || '(none configured!)'}`);

const shutdown = (signal) => {
  console.log(`\n${signal} — shutting down`);
  bot.stop().finally(() => {
    db.close();
    process.exit(0);
  });
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

await bot.start({ drop_pending_updates: true });
