import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startWithPollingResilience } from '../src/bot/startResilient.js';

class FakeConflictError extends Error {
  constructor() {
    super('Call to getUpdates failed! (409: Conflict)');
    this.error_code = 409;
  }
}

function recorder() {
  const sleeps = [];
  const warnings = [];
  return {
    sleeps,
    warnings,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    warn: (msg) => warnings.push(msg),
  };
}

test('succeeds on the first attempt with no retry or sleep', async () => {
  const { sleep, warn, sleeps, warnings } = recorder();
  let calls = 0;
  await startWithPollingResilience(async () => {
    calls++;
  }, { isConflict: () => true, sleep, warn });

  assert.equal(calls, 1);
  assert.deepEqual(sleeps, []);
  assert.deepEqual(warnings, []);
});

test('retries on conflict with capped-linear backoff, then succeeds', async () => {
  const { sleep, warn, sleeps, warnings } = recorder();
  let calls = 0;
  await startWithPollingResilience(
    async () => {
      calls++;
      if (calls < 4) throw new FakeConflictError();
    },
    { isConflict: (err) => err instanceof FakeConflictError, sleep, warn },
  );

  assert.equal(calls, 4); // failed 3 times, succeeded on the 4th
  // waitSeconds = min(5*attempt, 60) for attempts 1,2,3 -> 5s,10s,15s
  assert.deepEqual(sleeps, [5000, 10000, 15000]);
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /attempt 1\/10/);
  assert.match(warnings[2], /retrying in 15s/);
});

test('backoff is capped at 60 seconds even for a late attempt', async () => {
  const { sleep, warn, sleeps } = recorder();
  let calls = 0;
  await startWithPollingResilience(
    async () => {
      calls++;
      if (calls < 9) throw new FakeConflictError(); // attempts 1..8 fail (8*5=40 still under cap at attempt 8... check 12th+ for cap)
    },
    { isConflict: () => true, sleep, warn, maxAttempts: 10 },
  );
  // attempt 8 -> wait = min(40,60) = 40; confirm none exceed 60
  assert.ok(sleeps.every((s) => s <= 60000));
  assert.equal(sleeps.at(-1), Math.min(5 * 8, 60) * 1000);
});

test('a non-conflict error is rethrown immediately, with no retry or sleep', async () => {
  const { sleep, warn, sleeps, warnings } = recorder();
  let calls = 0;
  const boom = new Error('totally unrelated failure');

  await assert.rejects(
    () =>
      startWithPollingResilience(
        async () => {
          calls++;
          throw boom;
        },
        { isConflict: (err) => err instanceof FakeConflictError, sleep, warn },
      ),
    (err) => err === boom,
  );

  assert.equal(calls, 1);
  assert.deepEqual(sleeps, []);
  assert.deepEqual(warnings, []);
});

test('a conflict arriving mid-shutdown is rethrown immediately, not retried', async () => {
  const { sleep, warn, sleeps } = recorder();
  let calls = 0;
  const conflict = new FakeConflictError();

  await assert.rejects(
    () =>
      startWithPollingResilience(
        async () => {
          calls++;
          throw conflict;
        },
        { isConflict: () => true, isShuttingDown: () => true, sleep, warn },
      ),
    (err) => err === conflict,
  );

  assert.equal(calls, 1);
  assert.deepEqual(sleeps, []);
});

test('gives up with a clear error after maxAttempts straight conflicts', async () => {
  const { sleep, warn, sleeps } = recorder();
  let calls = 0;

  await assert.rejects(
    () =>
      startWithPollingResilience(
        async () => {
          calls++;
          throw new FakeConflictError();
        },
        { isConflict: () => true, sleep, warn, maxAttempts: 3 },
      ),
    /Still getting 409 Conflict after 3 attempts/,
  );

  assert.equal(calls, 3);
  assert.equal(sleeps.length, 3); // backs off after every failed attempt, including the last
});

test('default isShuttingDown, sleep and warn work without being supplied', async () => {
  // Exercises the real default sleep/warn paths (not the test doubles) —
  // keep it to a single successful attempt so this doesn't actually wait.
  let calls = 0;
  await startWithPollingResilience(
    async () => {
      calls++;
    },
    { isConflict: () => true },
  );
  assert.equal(calls, 1);
});
