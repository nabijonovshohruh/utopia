import { Bot, GrammyError } from 'grammy';
import { config, checkConfig } from './config.js';
import { openDb } from './db/index.js';
import { adminRoutes } from './bot/admin.js';
import { studentRoutes } from './bot/student.js';
import { startWithPollingResilience } from './bot/startResilient.js';
import { createServer } from './webapp/server.js';
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

// ---------------------------------------------------------------------------
// Mini App HTTP server — started FIRST and independently of the bot below.
//
// Railway (and most platforms) healthcheck a deployment by hitting $PORT. If
// this process only ran the bot, there would be nothing listening on that
// port at all (long polling makes outbound requests to Telegram; it opens no
// inbound listener), which is exactly what produces "Application failed to
// respond" — not a crash, just nothing ever answering. Bound explicitly to
// 0.0.0.0: Node's listen(port, callback) 2-arg form leaves the host
// unspecified, which can resolve to a binding Railway's proxy can't reach.
// ---------------------------------------------------------------------------
const miniAppServer = createServer(db, { botToken: config.botToken });
miniAppServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${config.miniAppPort} is already in use. Set PORT or MINIAPP_PORT to a free one.\n`);
  } else if (err.code === 'EACCES') {
    console.error(`\nPermission denied binding port ${config.miniAppPort} (ports <1024 usually need root).\n`);
  } else {
    console.error('\nMini App server failed to start:', err.message, '\n');
  }
  process.exit(1);
});
await new Promise((resolve) => miniAppServer.listen(config.miniAppPort, '0.0.0.0', resolve));
console.log(`Mini App server listening on 0.0.0.0:${config.miniAppPort}`);
if (config.miniAppPublicUrl) {
  console.log(`Public URL configured: ${config.miniAppPublicUrl}`);
} else {
  console.log(
    'MINIAPP_PUBLIC_URL is not set — the bot will fall back to chat-based answer entry. ' +
      'Put this deployment behind HTTPS and set MINIAPP_PUBLIC_URL to enable the "Open Mini App" button.',
  );
}

// ---------------------------------------------------------------------------
// Telegram bot
// ---------------------------------------------------------------------------
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
  Promise.all([bot.stop(), new Promise((resolve) => miniAppServer.close(resolve))]).finally(() => {
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

// Deliberately NOT awaited at the top level: if this ultimately fails (the
// 409 retry loop exhausts its attempts, or hits a genuinely unexpected
// error), the failure must not become an unhandled rejection that crashes
// this process — doing so would take the Mini App server down with it,
// which defeats the entire point of running it independently of Telegram
// polling health. `drop_pending_updates: true` here clears any update
// backlog from before this process started, but does not prevent a live
// getUpdates overlap with another still-running process — that's what
// startWithPollingResilience handles (see src/bot/startResilient.js).
startWithPollingResilience(() => bot.start({ drop_pending_updates: true }), {
  isConflict: (err) => err instanceof GrammyError && err.error_code === 409,
  isShuttingDown: () => shuttingDown,
}).catch((err) => {
  console.error(
    '\nFATAL: the Telegram bot could not start (see error below). The Mini App server keeps ' +
      'running regardless, but chat commands are unavailable until this is fixed and the ' +
      'process is restarted.\n',
    err,
  );
});
