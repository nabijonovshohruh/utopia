import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyInitData } from './initdata.js';
import { nc55Blocks, NC55_ITEM_COUNT } from '../domain/nc55.js';
import { getTestByCode, getItems } from '../services/tests.js';
import { recordSubmissionByLabel, getOrCreateStudent, latestSubmission } from '../services/submissions.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML_PATH = path.join(here, 'public', 'index.html');

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Reads and JSON-parses a request body, capped to stay far above any real
 * 55-item submission (even generous free-text answers) but well short of a
 * trivial memory-exhaustion vector from an arbitrary POST. */
function readJsonBody(req, maxBytes = 300_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    let tooLarge = false;
    const chunks = [];

    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on('data', (chunk) => {
      if (tooLarge) return; // keep draining so the socket can still flush our response
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        // Deliberately does NOT call req.destroy(): tearing down the socket
        // here races the 413 response we're about to write and the client
        // sees ECONNRESET instead of a clean error. Letting the request
        // finish (ignoring further bytes) lets res.end() actually flush.
        fail(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        fail(Object.assign(new Error('invalid JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', fail);
  });
}

const CODE_SHAPE = /^[A-Za-z0-9-]{1,40}$/;

/**
 * Builds the Mini App's HTTP server: same origin serves both the static
 * page and its API, so none of this needs CORS headers.
 *
 * Only POST /api/submissions is authenticated, via verifyInitData — see
 * src/webapp/initdata.js for why that check exists. The other endpoints
 * return nothing sensitive (a test's title/code, or the fixed item-type
 * layout), so they're left open the same way `/test CODE` is in the chat
 * bot.
 */
export function createServer(db, { botToken }) {
  /**
   * Lets the Mini App check "is this user registered?" BEFORE rendering the
   * 55-item form, instead of only finding out at submit time after they've
   * filled the whole thing in. initData travels as a query param here since
   * this is a simple GET — it's no more sensitive in a URL than it is in a
   * POST body, and it's never logged or stored.
   */
  function handleGetRegistration(res, url) {
    const initData = url.searchParams.get('initData');
    const verified = verifyInitData(initData, botToken);
    if (!verified.ok) {
      return json(res, 401, { ok: false, error: `authentication failed: ${verified.error}` });
    }
    const student = getOrCreateStudent(db, {
      id: verified.user.id,
      username: verified.user.username ?? null,
      first_name: verified.user.first_name ?? null,
      last_name: verified.user.last_name ?? null,
    });
    return json(res, 200, { ok: true, registered: Boolean(student.registered), fullName: student.full_name });
  }

  function handleGetTest(res, rawCode) {
    const code = decodeURIComponent(rawCode);
    if (!CODE_SHAPE.test(code)) return json(res, 400, { ok: false, error: 'invalid code format' });
    const test = getTestByCode(db, code);
    if (!test) return json(res, 404, { ok: false, error: `No test with code ${code}` });
    if (test.template !== 'nc55') {
      return json(res, 400, { ok: false, error: `${test.code} is not an NC55 Mini App test.` });
    }
    if (test.status !== 'locked') {
      return json(res, 409, { ok: false, error: `${test.code} is not open yet — ask your teacher.` });
    }
    return json(res, 200, { ok: true, code: test.code, title: test.title, itemCount: NC55_ITEM_COUNT });
  }

  async function handleSubmit(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return json(res, err.statusCode ?? 400, { ok: false, error: err.message });
    }

    const { initData, code, answers } = body ?? {};
    const verified = verifyInitData(initData, botToken);
    if (!verified.ok) {
      return json(res, 401, { ok: false, error: `authentication failed: ${verified.error}` });
    }

    if (!code || typeof code !== 'string') return json(res, 400, { ok: false, error: 'missing code' });
    const test = getTestByCode(db, code);
    if (!test) return json(res, 404, { ok: false, error: `No test with code ${code}` });
    if (test.template !== 'nc55') return json(res, 400, { ok: false, error: 'not an NC55 test' });
    if (test.status !== 'locked') return json(res, 409, { ok: false, error: `${test.code} is not open` });

    const student = getOrCreateStudent(db, {
      id: verified.user.id,
      username: verified.user.username ?? null,
      first_name: verified.user.first_name ?? null,
      last_name: verified.user.last_name ?? null,
    });

    // Certificates need the student's own registered Ism-Familiya, not
    // whatever Telegram's profile happens to say — same gate the chat bot
    // applies to /test. The frontend checks this upfront via
    // /api/registration so a student normally never reaches this 403 after
    // actually filling in the form; it's a backstop, not the primary UX.
    if (!student.registered) {
      return json(res, 403, {
        ok: false,
        error:
          "Avval botda ro'yxatdan o'ting: botga o'ting, /start buyrug'ini yuboring va " +
          'ism-familiyangizni kiriting.',
      });
    }

    const prior = latestSubmission(db, student.id, test.id);
    if (prior) {
      return json(res, 409, {
        ok: false,
        error: 'You already submitted this test.',
        submissionId: prior.id,
      });
    }

    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
      return json(res, 400, { ok: false, error: 'missing or malformed answers' });
    }
    const items = getItems(db, test.id);
    const validLabels = new Set(items.map((i) => i.label));
    const unknown = Object.keys(answers).filter((label) => !validLabels.has(label));
    if (unknown.length) {
      return json(res, 400, { ok: false, error: `unknown item label(s): ${unknown.slice(0, 5).join(', ')}` });
    }

    const answersByLabel = {};
    for (const item of items) {
      const value = answers[item.label];
      answersByLabel[item.label] = typeof value === 'string' && value.trim() ? value.trim() : null;
    }

    const submissionId = recordSubmissionByLabel(db, {
      testId: test.id,
      studentId: student.id,
      rawInput: JSON.stringify(answers).slice(0, 20_000),
      answersByLabel,
      source: 'miniapp',
    });

    return json(res, 200, { ok: true, submissionId });
  }

  return http.createServer((req, res) => {
    Promise.resolve()
      .then(() => {
        const url = new URL(req.url, 'http://internal');

        if (req.method === 'GET' && url.pathname === '/health') {
          return json(res, 200, { ok: true });
        }

        if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
          const html = fs.readFileSync(INDEX_HTML_PATH);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length });
          res.end(html);
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/structure') {
          return json(res, 200, { itemCount: NC55_ITEM_COUNT, blocks: nc55Blocks() });
        }

        if (req.method === 'GET' && url.pathname === '/api/registration') {
          return handleGetRegistration(res, url);
        }

        const testMatch = url.pathname.match(/^\/api\/test\/([^/]+)$/);
        if (req.method === 'GET' && testMatch) {
          return handleGetTest(res, testMatch[1]);
        }

        if (req.method === 'POST' && url.pathname === '/api/submissions') {
          return handleSubmit(req, res);
        }

        return json(res, 404, { ok: false, error: 'not found' });
      })
      .catch((err) => {
        const status = err.statusCode ?? 500;
        json(res, status, { ok: false, error: status === 500 ? 'internal error' : err.message });
      });
  });
}
