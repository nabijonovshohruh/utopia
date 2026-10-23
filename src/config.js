import path from 'node:path';

/**
 * Environment configuration.
 *
 * Deliberately does NOT throw at import time: `migrate`, `seed` and `doctor`
 * touch only the database and must run before a bot token exists. Validation
 * is a separate, explicit step (`checkConfig`) that each entrypoint runs at
 * boot and `npm run doctor` reports on.
 */

const TOKEN_SHAPE = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;

// Strings that mean "the user hasn't filled this in yet". Matching these is
// what turns a baffling Telegram 404 into an actionable message.
const PLACEHOLDER = /paste|your[_-]?(token|id)|here$|^<.*>$|^123456:ABC/i;

function parseAdminIds(raw) {
  const ids = [];
  const invalid = [];
  for (const part of String(raw ?? '').split(',')) {
    const token = part.trim();
    if (!token) continue;
    if (/^\d+$/.test(token)) ids.push(Number(token));
    else invalid.push(token);
  }
  return { ids, invalid };
}

// Snapshot the raw string alongside the parsed ids. checkConfig() must report
// on exactly what config.adminIds was built from: re-reading process.env there
// would let the two disagree if anything mutates the environment after import.
const rawAdminIds = (process.env.ADMIN_IDS ?? '').trim();
const admins = parseAdminIds(rawAdminIds);

export const config = {
  botToken: (process.env.BOT_TOKEN ?? '').trim(),
  dbPath: path.resolve((process.env.DB_PATH ?? '').trim() || './data/rasch.sqlite'),
  adminIds: admins.ids,
  // The Mini App's own HTTP server (src/webapp-index.js) — separate process
  // from the bot, listening on this port. Not required for the bot itself:
  // without a public HTTPS URL for it, /test falls back to chat-based entry.
  // PORT takes priority: it's the conventional "platform assigns the port"
  // override (used by this preview tooling among others). MINIAPP_PORT is
  // the normal, stable local-dev/deploy setting.
  miniAppPort: Number(process.env.PORT) || Number(process.env.MINIAPP_PORT) || 8787,
  miniAppPublicUrl: (process.env.MINIAPP_PUBLIC_URL ?? '').trim() || null,
};

export function isAdmin(telegramId) {
  return config.adminIds.includes(Number(telegramId));
}

/**
 * Inspects the environment and returns human-readable problems.
 *
 * @param {object}  opts
 * @param {boolean} opts.requireToken   false for DB-only scripts (migrate/seed/doctor)
 * @param {boolean} opts.requireAdmins  false for the Mini App server, which never checks ADMIN_IDS
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function checkConfig({ requireToken = true, requireAdmins = true } = {}) {
  const errors = [];
  const warnings = [];

  if (requireToken) {
    if (!config.botToken) {
      errors.push('BOT_TOKEN is not set. Add it to .env — get one from @BotFather in Telegram.');
    } else if (PLACEHOLDER.test(config.botToken)) {
      errors.push(
        'BOT_TOKEN is still the placeholder text. Replace it with the real token @BotFather gave you.',
      );
    } else if (!TOKEN_SHAPE.test(config.botToken)) {
      errors.push(
        `BOT_TOKEN does not look like a Telegram token (expected "<digits>:<~35 chars>", got ` +
          `"${config.botToken.slice(0, 12)}…"). Check for stray quotes or a truncated copy-paste.`,
      );
    }
  }

  if (requireAdmins) {
    if (!rawAdminIds || PLACEHOLDER.test(rawAdminIds)) {
      errors.push(
        'ADMIN_IDS is not set. Without it nobody has teacher rights, so answer keys cannot be ' +
          'uploaded and no test can be locked. Message @userinfobot in Telegram to get your ' +
          'numeric ID, then put it in .env.',
      );
    } else if (admins.invalid.length) {
      errors.push(
        `ADMIN_IDS contains non-numeric entries: ${admins.invalid.join(', ')}. ` +
          'Use numeric Telegram user IDs (from @userinfobot), not @usernames.',
      );
    }
  }

  if (config.miniAppPublicUrl && !/^https:\/\//i.test(config.miniAppPublicUrl)) {
    warnings.push(
      `MINIAPP_PUBLIC_URL "${config.miniAppPublicUrl}" is not https:// — Telegram will refuse to ` +
        'open a Mini App at a non-HTTPS URL.',
    );
  }

  return { errors, warnings };
}
