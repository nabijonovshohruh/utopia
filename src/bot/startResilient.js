/**
 * Wraps a long-polling bot.start() call with capped-backoff retry,
 * specifically for 409 Conflict — split out from src/index.js so the
 * retry/backoff behavior is unit-testable without a real grammY Bot or
 * real timers.
 *
 * Telegram's getUpdates returns 409 Conflict when another instance is
 * briefly still polling with the same token — routine during a platform
 * redeploy, where the old container can stay mid-poll for a few seconds
 * after the new one starts. grammY deliberately does not retry this
 * itself (it rethrows on 401/409 rather than loop forever on what might be
 * a genuine two-instances problem — see handlePollingError in grammY's
 * source), so bot.start()'s returned promise rejects, and left unhandled,
 * that crashes the process. This retries with backoff instead; if it's
 * still conflicting after `maxAttempts`, something other than a deploy
 * overlap is going on, and that's let through to fail loudly rather than
 * retried forever, which would just mask a real two-instances bug.
 *
 * @param {() => Promise<void>} start  calls bot.start(...) and returns its promise
 * @param {object} opts
 * @param {(err: unknown) => boolean} opts.isConflict  true if `err` is a 409 Conflict
 * @param {() => boolean} [opts.isShuttingDown]  true once a deliberate shutdown is underway —
 *   a conflict error arriving mid-shutdown is not something to retry
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {number} [opts.maxAttempts]
 * @param {(msg: string) => void} [opts.warn]
 */
export async function startWithPollingResilience(
  start,
  {
    isConflict,
    isShuttingDown = () => false,
    sleep = defaultSleep,
    maxAttempts = 10,
    warn = console.warn,
  } = {},
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await start();
      return;
    } catch (err) {
      if (!isConflict(err) || isShuttingDown()) throw err;

      const waitSeconds = Math.min(5 * attempt, 60);
      warn(
        `409 Conflict: another instance is still polling (attempt ${attempt}/${maxAttempts}) — ` +
          `retrying in ${waitSeconds}s.`,
      );
      await sleep(waitSeconds * 1000);
    }
  }
  throw new Error(`Still getting 409 Conflict after ${maxAttempts} attempts — giving up.`);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
