import { config, checkConfig } from './config.js';
import { openDb } from './db/index.js';
import { createServer } from './webapp/server.js';

// The Mini App's submission endpoint verifies requests with the bot token
// (see src/webapp/initdata.js), so it needs that — but not ADMIN_IDS, which
// this process never touches.
const { errors, warnings } = checkConfig({ requireToken: true, requireAdmins: false });
for (const w of warnings) console.warn(`warning: ${w}`);
if (errors.length) {
  console.error('\nCannot start — configuration problems:\n');
  errors.forEach((e, i) => console.error(`  ${i + 1}. ${e}`));
  console.error(
    '\nSet the missing variable(s) — .env locally, or your host\'s dashboard/variables in ' +
      'production — then try again.\n',
  );
  process.exit(1);
}

const db = openDb(config.dbPath);
const server = createServer(db, { botToken: config.botToken });

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${config.miniAppPort} is already in use. Set PORT or MINIAPP_PORT to a free one.\n`);
  } else if (err.code === 'EACCES') {
    console.error(`\nPermission denied binding port ${config.miniAppPort} (ports <1024 usually need root).\n`);
  } else {
    console.error('\nMini App server failed to start:', err.message, '\n');
  }
  process.exit(1);
});

// Bind host explicitly to 0.0.0.0 — Railway (and most container platforms)
// route incoming traffic to the container's external interface. Node's
// listen(port, callback) 2-arg form leaves the host unspecified, which can
// resolve to a binding Railway's proxy can't reach; the result is a
// container that's "running" but never answers a request, which Railway
// reports as "Application failed to respond" rather than a clear error.
server.listen(config.miniAppPort, '0.0.0.0', () => {
  console.log(`Mini App server listening on 0.0.0.0:${config.miniAppPort}`);
  console.log(`DB: ${config.dbPath}`);
  if (config.miniAppPublicUrl) {
    console.log(`Public URL configured: ${config.miniAppPublicUrl}`);
  } else {
    console.log(
      'MINIAPP_PUBLIC_URL is not set — the bot will fall back to chat-based answer entry. ' +
        'Deploy this server behind HTTPS and set MINIAPP_PUBLIC_URL to enable the "Open Mini App" button.',
    );
  }
});

const shutdown = (signal) => {
  console.log(`\n${signal} — shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
