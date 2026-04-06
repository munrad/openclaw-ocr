import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  TEST_TELEGRAM_BOT_TOKEN,
  ensureTestTelegramEnv,
} from './helpers/telegram-test-config.mjs';

ensureTestTelegramEnv(process.env, { token: TEST_TELEGRAM_BOT_TOKEN });
process.env.STATUS_PUBSUB_ENABLED = '0';

function hasRedisCli() {
  try {
    execFileSync('redis-cli', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('stopTaskStatusWatcher interrupts blocked XREAD without waiting for full block timeout', { skip: !hasRedisCli() ? 'redis-cli not available' : false }, async () => {
  process.env.OCR_TASK_STATUS_WATCHER_DEBOUNCE_MS = '20';
  process.env.OCR_TASK_STATUS_WATCHER_PERIODIC_REFRESH_MS = '10000';
  process.env.OCR_TASK_STATUS_WATCHER_XREAD_BLOCK_MS = '5000';

  const watcherUrl = new URL('../task-status-watcher.mjs', import.meta.url);
  watcherUrl.searchParams.set('stop-test', String(Date.now()));
  const {
    startTaskStatusWatcher,
    stopTaskStatusWatcher,
  } = await import(watcherUrl.href);

  const watcherPromise = startTaskStatusWatcher({ installSignals: false });
  await sleep(150);

  const startedAt = Date.now();
  await stopTaskStatusWatcher({ reason: 'test-stop', waitMs: 2000 });
  const elapsedMs = Date.now() - startedAt;

  assert.ok(elapsedMs < 2000, `expected watcher stop in under 2000ms, got ${elapsedMs}ms`);
  await watcherPromise;

  const secondStopStartedAt = Date.now();
  await stopTaskStatusWatcher({ reason: 'test-stop-repeat', waitMs: 200 });
  assert.ok(Date.now() - secondStopStartedAt < 250, 'repeated stop must remain a no-op');
});
