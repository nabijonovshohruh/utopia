import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyInitData } from '../src/webapp/initdata.js';

const BOT_TOKEN = '8012345678:AAHdq1x9kP2mZvQ7rT4nB6wE3sY8uI0oL5c';

/** Builds a correctly-signed initData string, mirroring what Telegram's WebView would produce. */
function buildInitData({ botToken = BOT_TOKEN, user = { id: 613204857, first_name: 'Ada' }, authDate = Math.floor(Date.now() / 1000), extra = {} } = {}) {
  const params = {
    query_id: 'AAHabc123',
    user: JSON.stringify(user),
    auth_date: String(authDate),
    ...extra,
  };
  const dataCheckString = Object.entries(params)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  return new URLSearchParams({ ...params, hash }).toString();
}

test('a correctly-signed initData string verifies and extracts the user', () => {
  const raw = buildInitData({ user: { id: 613204857, first_name: 'Ada', username: 'ada' } });
  const result = verifyInitData(raw, BOT_TOKEN);
  assert.equal(result.ok, true);
  assert.equal(result.user.id, 613204857);
  assert.equal(result.user.username, 'ada');
});

test('a tampered field invalidates the signature', () => {
  const raw = buildInitData({ user: { id: 1 } });
  // Flip the user id after signing, as an attacker impersonating someone else would.
  const tampered = raw.replace(encodeURIComponent('"id":1'), encodeURIComponent('"id":999999'));
  const result = verifyInitData(tampered, BOT_TOKEN);
  assert.equal(result.ok, false);
  assert.match(result.error, /invalid signature/);
});

test('a hash signed with the wrong bot token is rejected', () => {
  const raw = buildInitData({ botToken: 'WRONG:TOKEN' });
  const result = verifyInitData(raw, BOT_TOKEN);
  assert.equal(result.ok, false);
  assert.match(result.error, /invalid signature/);
});

test('a missing hash is rejected before any crypto runs', () => {
  const raw = buildInitData();
  const withoutHash = raw.replace(/&hash=[0-9a-f]+$/, '');
  const result = verifyInitData(withoutHash, BOT_TOKEN);
  assert.equal(result.ok, false);
  assert.match(result.error, /no hash/);
});

test('garbage input is rejected, not thrown', () => {
  assert.equal(verifyInitData('', BOT_TOKEN).ok, false);
  assert.equal(verifyInitData(null, BOT_TOKEN).ok, false);
  assert.equal(verifyInitData('not even a query string??', BOT_TOKEN).ok, false);
  assert.equal(verifyInitData('hash=deadbeef', BOT_TOKEN).ok, false);
});

test('a hash of the wrong length cannot crash timingSafeEqual', () => {
  const raw = buildInitData();
  const shortened = raw.replace(/hash=[0-9a-f]+$/, 'hash=ab');
  assert.doesNotThrow(() => verifyInitData(shortened, BOT_TOKEN));
  assert.equal(verifyInitData(shortened, BOT_TOKEN).ok, false);
});

test('expired initData is rejected', () => {
  const old = Math.floor(Date.now() / 1000) - 90000; // > 24h
  const raw = buildInitData({ authDate: old });
  const result = verifyInitData(raw, BOT_TOKEN);
  assert.equal(result.ok, false);
  assert.match(result.error, /expired/);
});

test('a custom maxAgeSeconds is honoured', () => {
  const authDate = Math.floor(Date.now() / 1000) - 120;
  const raw = buildInitData({ authDate });
  assert.equal(verifyInitData(raw, BOT_TOKEN, { maxAgeSeconds: 60 }).ok, false);
  assert.equal(verifyInitData(raw, BOT_TOKEN, { maxAgeSeconds: 600 }).ok, true);
});

test('an auth_date far in the future is rejected', () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const raw = buildInitData({ authDate: future });
  const result = verifyInitData(raw, BOT_TOKEN);
  assert.equal(result.ok, false);
  assert.match(result.error, /future/);
});

test('a small clock-skew allowance does not reject nearly-current data', () => {
  const almostNow = Math.floor(Date.now() / 1000) + 10;
  const raw = buildInitData({ authDate: almostNow });
  assert.equal(verifyInitData(raw, BOT_TOKEN).ok, true);
});

test('missing or malformed user field is rejected', () => {
  const raw = buildInitData();
  const withoutUser = raw
    .split('&')
    .filter((p) => !p.startsWith('user='))
    .join('&');
  // Re-sign is unnecessary for this check since validation checks `user`
  // presence after the signature step only when hash matches; since we
  // removed a signed field, the signature itself will already fail first —
  // this test documents that ordering (fails on signature, not just "no user").
  const result = verifyInitData(withoutUser, BOT_TOKEN);
  assert.equal(result.ok, false);
});
