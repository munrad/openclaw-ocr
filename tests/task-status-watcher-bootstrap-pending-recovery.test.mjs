import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import { setTimeout as sleep } from 'node:timers/promises';

import { CONFIG } from '../lib/config.mjs';
import {
  TEST_TELEGRAM_BOT_TOKEN,
  TEST_TELEGRAM_CHAT_ID,
  ensureTestTelegramEnv,
} from './helpers/telegram-test-config.mjs';

// Ensure watcher/token guard passes even in CI environments without a real TG token.
ensureTestTelegramEnv(process.env, { token: TEST_TELEGRAM_BOT_TOKEN });

const OCR_BIN = new URL('../index.mjs', import.meta.url);

function redisCli(args) {
  const base = ['-h', CONFIG.host, '-p', String(CONFIG.port), '-n', String(CONFIG.db || 0), '--no-auth-warning'];
  let password = CONFIG.password || process.env.REDIS_PASSWORD || '';
  if (!password) {
    try { password = readFileSync('/run/secrets/redis_password', 'utf8').trim(); } catch {}
  }
  if (password) base.push('-a', password);
  return execFileSync('redis-cli', [...base, ...args], { encoding: 'utf8' }).trim();
}

function ocr(args, { allowFailure = false, env = process.env } = {}) {
  try {
    const out = execFileSync('node', [OCR_BIN.pathname, ...args], { encoding: 'utf8', env }).trim();
    return { code: 0, json: JSON.parse(out), raw: out };
  } catch (err) {
    const out = String(err.stdout || '').trim();
    const parsed = out ? JSON.parse(out) : null;
    if (!allowFailure) {
      throw new Error(`ocr ${args.join(' ')} failed code=${err.status}\nstdout=${out}\nstderr=${String(err.stderr || '')}`);
    }
    return { code: err.status || 1, json: parsed, raw: out, stderr: String(err.stderr || '') };
  }
}

function hgetall(key) {
  const raw = redisCli(['--raw', 'HGETALL', key]);
  const lines = raw.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const obj = {};
  for (let i = 0; i < lines.length; i += 2) obj[lines[i]] = lines[i + 1] ?? '';
  return obj;
}

function del(...keys) {
  if (keys.length) redisCli(['DEL', ...keys]);
}

function seedBootstrapPendingTask({ taskId, titleMarker, createdAtIso }) {
  const taskKey = `openclaw:task-status:${taskId}`;
  redisCli(['HSET', taskKey,
    'task_id', taskId,
    'run_id', taskId,
    'title', `Bootstrap pending ${titleMarker} ${taskId}`,
    'agents', '["coder"]',
    'topic_id', '1',
    'chat_id', TEST_TELEGRAM_CHAT_ID,
    'status', 'running',
    'bootstrap_pending', '1',
    'bootstrap_retry_count', '0',
    'coordinator_id', 'teamlead',
    'owner_id', 'teamlead',
    'close_owner_id', 'teamlead',
    'creator_id', 'teamlead',
    'created_at', createdAtIso,
    'updated_at', createdAtIso,
  ]);
  redisCli(['SADD', 'openclaw:task-status:active', taskId]);
  return taskKey;
}

function installTelegramMock() {
  const originalRequest = https.request;

  const counts = {
    send_ok: 0,
    send_fail: 0,
    edit: 0,
  };
  const texts = {
    send_ok: [],
    send_fail: [],
  };

  https.request = (options, cb) => {
    const opts = options || {};
    const path = String(opts.path || '');
    const methodName = path.split('/').pop();

    let body = '';

    class FakeReq extends EventEmitter {
      write(chunk) { body += String(chunk); }
      end() {
        const res = new EventEmitter();
        res.statusCode = 200;
        cb?.(res);

        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch {}
        const text = String(payload.text || '');

        let response;
        if (methodName === 'sendMessage') {
          // Only count for our specific test tasks (use unique marker that includes timestamp)
          if (text.includes('TSWBPOK')) {
            counts.send_ok += 1;
            texts.send_ok.push(text);
            response = { ok: true, result: { message_id: 900001 + counts.send_ok } };
          } else if (text.includes('TSWBPFAIL')) {
            counts.send_fail += 1;
            texts.send_fail.push(text);
            response = { ok: false, error_code: 401, description: 'unauthorized' };
          } else {
            // default: succeed for any other sendMessage
            response = { ok: true, result: { message_id: 999000 } };
          }
        } else if (methodName === 'editMessageText') {
          counts.edit += 1;
          response = { ok: true, result: true };
        } else if (methodName === 'deleteMessage') {
          response = { ok: true, result: true };
        } else {
          response = { ok: true, result: true };
        }

        const buf = Buffer.from(JSON.stringify(response));
        setImmediate(() => {
          res.emit('data', buf);
          res.emit('end');
        });
      }
      destroy(err) {
        setImmediate(() => this.emit('error', err || new Error('destroyed')));
      }
    }

    return new FakeReq();
  };

  return { counts, texts, restore: () => { https.request = originalRequest; } };
}

async function main() {
  const checks = [];
  const watcherKey = 'openclaw:task-status-watcher:last_event_id';

  // Make periodic refresh fast so we can observe bounded retries quickly.
  process.env.OCR_TASK_STATUS_WATCHER_PERIODIC_REFRESH_MS = '50';
  process.env.OCR_TASK_STATUS_WATCHER_XREAD_BLOCK_MS = '20';
  process.env.OCR_TASK_STATUS_WATCHER_DEBOUNCE_MS = '20';

  // Keep the production defaults for stale threshold (3 minutes): we seed created_at older.

  // Ensure streams/groups exist (idempotent)
  ocr(['init']);

  const qa = Date.now();
  const okTaskId = `bp-ok-${qa}`;
  const failTaskId = `bp-fail-${qa}`;
  const okMarker = `TSWBPOK_${qa}`;
  const failMarker = `TSWBPFAIL_${qa}`;
  const okKey = `openclaw:task-status:${okTaskId}`;
  const failKey = `openclaw:task-status:${failTaskId}`;

  del(watcherKey, okKey, failKey);
  try { redisCli(['SREM', 'openclaw:task-status:active', okTaskId, failTaskId]); } catch {}

  const createdAtIso = new Date(Date.now() - 10 * 60_000).toISOString();
  seedBootstrapPendingTask({ taskId: okTaskId, titleMarker: okMarker, createdAtIso });
  seedBootstrapPendingTask({ taskId: failTaskId, titleMarker: failMarker, createdAtIso });

  const mock = installTelegramMock();

  try {
    // Start the watcher explicitly in-process without relying on import side effects.
    const { startTaskStatusWatcher, stopTaskStatusWatcher } = await import('../task-status-watcher.mjs');
    startTaskStatusWatcher({ installSignals: false });

    // Wait for success recovery
    let okHash = {};
    for (let i = 0; i < 120; i++) {
      await sleep(50);
      okHash = hgetall(okKey);
      if (okHash.message_id && okHash.bootstrap_pending === '0') break;
    }
    assert.ok(okHash.message_id, `OK task: expected message_id to be set, got: ${JSON.stringify(okHash)}`);
    assert.equal(okHash.bootstrap_pending, '0');
    assert.equal(okHash.bootstrap_retry_count, '1', 'OK task: retry_count must count attempts (success increments)');
    checks.push('watcher recovery (success): stale bootstrap_pending -> TG sendMessage -> message_id set, bootstrap_pending=0, retry_count=1');

    // Wait for failure recovery attempts to hit max (2) and stop.
    let failHash = {};
    for (let i = 0; i < 200; i++) {
      await sleep(30);
      failHash = hgetall(failKey);
      if (failHash.bootstrap_retry_count === '2') break;
    }
    assert.equal(failHash.bootstrap_pending, '1');
    assert.ok(!failHash.message_id, 'FAIL task: should still have no message_id');
    assert.equal(failHash.bootstrap_retry_count, '2');

    const failCallsAtMax = mock.texts.send_fail.filter((text) => text.includes(failMarker)).length;
    await sleep(200);
    const failCallsAfterWait = mock.texts.send_fail.filter((text) => text.includes(failMarker)).length;
    assert.equal(failCallsAfterWait, failCallsAtMax, 'FAIL task: watcher must stop retrying after max retries');

    checks.push('watcher recovery (failure): retries bounded to max, no infinite loop (send_fail calls stop increasing)');

    // Sanity: mock observed calls as expected for this test run only.
    assert.equal(mock.texts.send_ok.filter((text) => text.includes(okMarker)).length, 1, 'expected exactly 1 sendMessage for OK task');
    assert.equal(mock.texts.send_fail.filter((text) => text.includes(failMarker)).length, 2, 'expected exactly 2 sendMessage attempts for FAIL task');
    checks.push('bootstrap_retry_count semantics locked: counts recovery attempts (success+failure), max retries enforced');

    await stopTaskStatusWatcher({ reason: 'test-finished', waitMs: 1000 });

    console.log(JSON.stringify({
      ok: true,
      test: 'task-status-watcher-bootstrap-pending-recovery',
      checks,
    }));
  } finally {
    mock.restore();
    del(watcherKey, okKey, failKey);
    try { redisCli(['SREM', 'openclaw:task-status:active', okTaskId, failTaskId]); } catch {}
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
