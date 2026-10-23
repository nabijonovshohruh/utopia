import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from '../src/webapp/server.js';
import { openDb } from '../src/db/index.js';
import { parseAnswerKey, upsertDraftTest, lockTest } from '../src/services/tests.js';
import { nc55Items } from '../src/domain/nc55.js';

const BOT_TOKEN = '8012345678:AAHdq1x9kP2mZvQ7rT4nB6wE3sY8uI0oL5c';

function signedInitData(user, { botToken = BOT_TOKEN, authDate = Math.floor(Date.now() / 1000) } = {}) {
  const params = { query_id: 'AAHabc', user: JSON.stringify(user), auth_date: String(authDate) };
  const dataCheckString = Object.entries(params)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  return new URLSearchParams({ ...params, hash }).toString();
}

function nc55Key(code) {
  const lines = nc55Items().map((i) =>
    i.itemType === 'mcq' ? `${i.label} ${i.options[0]} -1.0` : `${i.label} -1.0`,
  );
  return ['TEMPLATE: NC55', `CODE: ${code}`, 'TITLE: NC Fixture', 'ITEMS:', ...lines].join('\n');
}

async function withServer(t, setup) {
  const db = openDb(':memory:');
  if (setup) setup(db);
  const server = createServer(db, { botToken: BOT_TOKEN });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  t.after(() => {
    server.close();
    db.close();
  });
  return { base, db };
}

test('GET /health responds ok', async (t) => {
  const { base } = await withServer(t);
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('GET / serves the Mini App HTML', async (t) => {
  const { base } = await withServer(t);
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /National Certificate/);
});

test('GET /api/structure returns the fixed 55-item / 45-block layout', async (t) => {
  const { base } = await withServer(t);
  const res = await fetch(`${base}/api/structure`);
  const body = await res.json();
  assert.equal(body.itemCount, 55);
  assert.equal(body.blocks.length, 45);
  assert.equal(body.blocks.filter((b) => b.type === 'mcq').length, 35);
  assert.equal(body.blocks.filter((b) => b.type === 'written').length, 10);
});

test('GET /api/test/:code: unknown code -> 404', async (t) => {
  const { base } = await withServer(t);
  const res = await fetch(`${base}/api/test/NOPE-404`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).ok, false);
});

test('GET /api/test/:code rejects a shape that could not be a real code', async (t) => {
  const { base } = await withServer(t);
  const res = await fetch(`${base}/api/test/${encodeURIComponent('../../etc/passwd')}`);
  assert.equal(res.status, 400);
});

test('GET /api/test/:code: a custom-template test is refused (Mini App is NC55-only)', async (t) => {
  const { base, db } = await withServer(t, (db) => {
    upsertDraftTest(db, parseAnswerKey('CODE: OLD1\nTITLE: Legacy\nITEMS:\n1 A -1\n2 B 0'), 1);
    lockTest(db, 'OLD1');
  });
  const res = await fetch(`${base}/api/test/OLD1`);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not an NC55/);
});

test('GET /api/test/:code: a draft (unlocked) NC55 test is not open yet', async (t) => {
  const { base } = await withServer(t, (db) => {
    upsertDraftTest(db, parseAnswerKey(nc55Key('TEST-1111')), 1);
  });
  const res = await fetch(`${base}/api/test/TEST-1111`);
  assert.equal(res.status, 409);
});

test('GET /api/test/:code: a locked NC55 test returns public metadata', async (t) => {
  const { base } = await withServer(t, (db) => {
    upsertDraftTest(db, parseAnswerKey(nc55Key('TEST-2222')), 1);
    lockTest(db, 'TEST-2222');
  });
  const res = await fetch(`${base}/api/test/TEST-2222`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { ok: true, code: 'TEST-2222', title: 'NC Fixture', itemCount: 55 });
});

test('POST /api/submissions without initData is rejected (401), proving the auth gate is live', async (t) => {
  const { base } = await withServer(t, (db) => {
    upsertDraftTest(db, parseAnswerKey(nc55Key('TEST-3333')), 1);
    lockTest(db, 'TEST-3333');
  });
  const res = await fetch(`${base}/api/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'TEST-3333', answers: {} }),
  });
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /authentication failed/);
});

test('POST /api/submissions rejects initData whose signature does not match', async (t) => {
  const { base } = await withServer(t, (db) => {
    upsertDraftTest(db, parseAnswerKey(nc55Key('TEST-3334')), 1);
    lockTest(db, 'TEST-3334');
  });
  const forged = signedInitData({ id: 1 }, { botToken: 'wrong-token' });
  const res = await fetch(`${base}/api/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData: forged, code: 'TEST-3334', answers: {} }),
  });
  assert.equal(res.status, 401);
});

test('POST /api/submissions: full authenticated round trip grades mcq and leaves written items pending', async (t) => {
  const { base, db } = await withServer(t, (db) => {
    upsertDraftTest(db, parseAnswerKey(nc55Key('TEST-4444')), 1);
    lockTest(db, 'TEST-4444');
  });

  const answers = {};
  nc55Items().forEach((i) => {
    answers[i.label] = i.itemType === 'mcq' ? i.options[0] : 'because of reasons';
  });
  const initData = signedInitData({ id: 42424242, first_name: 'Ada', username: 'ada' });

  const res = await fetch(`${base}/api/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData, code: 'TEST-4444', answers }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(Number.isInteger(body.submissionId));

  const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(body.submissionId);
  assert.equal(sub.source, 'miniapp');
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(sub.student_id);
  assert.equal(student.telegram_id, 42424242);
  assert.equal(student.username, 'ada');

  const counts = db
    .prepare(
      `SELECT item_type, SUM(CASE WHEN correct IS NULL THEN 1 ELSE 0 END) ungraded, COUNT(*) n
       FROM responses r JOIN items i ON i.id = r.item_id
       WHERE r.submission_id = ? GROUP BY item_type`,
    )
    .all(body.submissionId);
  const written = counts.find((c) => c.item_type === 'written');
  const mcq = counts.find((c) => c.item_type === 'mcq');
  assert.equal(written.n, 20);
  assert.equal(written.ungraded, 20);
  assert.equal(mcq.n, 35);
  assert.equal(mcq.ungraded, 0);
});

test('POST /api/submissions: a second submission from the same student is refused', async (t) => {
  const { base } = await withServer(t, (db) => {
    upsertDraftTest(db, parseAnswerKey(nc55Key('TEST-5555')), 1);
    lockTest(db, 'TEST-5555');
  });
  const initData = signedInitData({ id: 777 });
  const payload = { initData, code: 'TEST-5555', answers: { 1: 'A' } };

  const first = await fetch(`${base}/api/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(first.status, 200);

  const second = await fetch(`${base}/api/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(second.status, 409);
  const body = await second.json();
  assert.match(body.error, /already submitted/);
  assert.ok(Number.isInteger(body.submissionId));
});

test('POST /api/submissions rejects an unknown item label (not silently dropped)', async (t) => {
  const { base } = await withServer(t, (db) => {
    upsertDraftTest(db, parseAnswerKey(nc55Key('TEST-6666')), 1);
    lockTest(db, 'TEST-6666');
  });
  const initData = signedInitData({ id: 888 });
  const res = await fetch(`${base}/api/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData, code: 'TEST-6666', answers: { '99z': 'nope' } }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /unknown item label/);
});

test('POST /api/submissions rejects an oversized body with 413', async (t) => {
  const { base } = await withServer(t, (db) => {
    upsertDraftTest(db, parseAnswerKey(nc55Key('TEST-7777')), 1);
    lockTest(db, 'TEST-7777');
  });
  const initData = signedInitData({ id: 999 });
  const huge = 'x'.repeat(400_000);
  const res = await fetch(`${base}/api/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData, code: 'TEST-7777', answers: { '36a': huge } }),
  });
  assert.equal(res.status, 413);
});

test('an unknown route returns 404 JSON, not a crash', async (t) => {
  const { base } = await withServer(t);
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).ok, false);
});
