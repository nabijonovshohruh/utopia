import crypto from 'node:crypto';

/**
 * Validates Telegram Mini App `initData` (per Telegram's documented
 * algorithm: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).
 *
 * WHY THIS EXISTS: the Mini App's page is served by our own HTTP server
 * (src/webapp/server.js), not by Telegram's bot-API infrastructure. A
 * normal bot chat message is authenticated for free — Telegram itself
 * vouches for `ctx.from.id` before our code ever sees it. A `fetch()` call
 * from inside the Mini App's WebView has no such guarantee: without
 * checking the HMAC signature here, any visitor to the page's URL could
 * submit a POST claiming to be any student's telegram_id, which is a
 * straightforward identity-spoofing hole. Verifying the signature with the
 * bot token (which only we and Telegram know) is what closes it.
 *
 * secret_key = HMAC_SHA256(key="WebAppData", message=botToken)
 * expected   = HMAC_SHA256(key=secret_key,    message=dataCheckString)
 * where dataCheckString is every "key=value" pair except `hash`, sorted by
 * key, joined with "\n".
 */
export function verifyInitData(raw, botToken, { maxAgeSeconds = 86400 } = {}) {
  if (!raw || typeof raw !== 'string') return { ok: false, error: 'missing initData' };

  let params;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return { ok: false, error: 'initData is not a valid query string' };
  }

  const hash = params.get('hash');
  if (!hash) return { ok: false, error: 'initData has no hash' };
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const a = Buffer.from(computedHash, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: 'invalid signature' };
  }

  const authDate = Number(params.get('auth_date'));
  if (!authDate || Number.isNaN(authDate)) return { ok: false, error: 'missing auth_date' };
  const ageSeconds = Date.now() / 1000 - authDate;
  if (ageSeconds > maxAgeSeconds) return { ok: false, error: 'initData expired' };
  if (ageSeconds < -60) return { ok: false, error: 'initData auth_date is in the future' };

  const userRaw = params.get('user');
  if (!userRaw) return { ok: false, error: 'initData has no user' };
  let user;
  try {
    user = JSON.parse(userRaw);
  } catch {
    return { ok: false, error: 'malformed user field' };
  }
  if (!user || typeof user.id !== 'number') return { ok: false, error: 'initData user has no numeric id' };

  return { ok: true, user, authDate };
}
