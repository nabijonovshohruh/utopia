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
  console.error('\nEdit .env, then try again.\n');
  process.exit(1);
}

const db = openDb(config.dbPath);
const server = createServer(db, { botToken: config.botToken });

server.listen(config.miniAppPort, () => {
  console.log(`Mini App server listening on http://localhost:${config.miniAppPort}`);
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
