import { Bot, GrammyError } from 'grammy';
import { config, checkConfig } from './config.js';
import { openDb } from './db/index.js';
import { adminRoutes } from './bot/admin.js';
import { studentRoutes } from './bot/student.js';
import { startWithPollingResilience } from './bot/startResilient.js';
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

// Catches errors thrown while PROCESSING a specific update — a bug in a
// command handler, etc. It does NOT see errors from the polling loop
// itself (a getUpdates 409 Conflict happens before any update is even
// received); those reject bot.start()'s own promise instead, handled by
// startWithPollingResilience() below.
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

let shuttingDown = false;
const shutdown = (signal) => {
  console.log(`\n${signal} — shutting down`);
  shuttingDown = true;
  bot.stop().finally(() => {
    db.close();
    process.exit(0);
  });
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

// Explicit and separate from the drop_pending_updates below: bot.start()
// already calls deleteWebhook internally as part of its own setup, but
// doing it here too means a failure in THIS step (e.g. a stale webhook
// misconfigured from before this bot ever used polling) surfaces on its
// own instead of being folded into the 409-specific retry loop below,
// which only knows how to handle conflict errors, not arbitrary ones.
await bot.api.deleteWebhook({ drop_pending_updates: true });

// `drop_pending_updates: true` here clears any update backlog from before
// this process started, but does not prevent a live getUpdates overlap
// with another still-running process — that's what
// startWithPollingResilience handles (see src/bot/startResilient.js for
// the full rationale).
await startWithPollingResilience(() => bot.start({ drop_pending_updates: true }), {
  isConflict: (err) => err instanceof GrammyError && err.error_code === 409,
  isShuttingDown: () => shuttingDown,
});
