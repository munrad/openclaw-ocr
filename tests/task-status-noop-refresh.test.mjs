import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { readFileSync } from 'node:fs';

import { CONFIG } from '../lib/config.mjs';
import {
  TEST_TELEGRAM_BOT_TOKEN,
  TEST_TELEGRAM_CHAT_ID,
  ensureTestTelegramEnv,
} from './helpers/telegram-test-config.mjs';

function redisCli(args) {
  const base = ['-h', CONFIG.host, '-p', String(CONFIG.port), '-n', String(CONFIG.db || 0), '--no-auth-warning'];
  let password = CONFIG.password || process.env.REDIS_PASSWORD || '';
  if (!password) {
    try { password = readFileSync('/run/secrets/redis_password', 'utf8').trim(); } catch {}
  }
  if (password) base.push('-a', password);
  return execFileSync('redis-cli', [...base, ...args], { encoding: 'utf8' }).trim();
}

function del(...keys) {
  if (keys.length) redisCli(['DEL', ...keys]);
}

function installTelegramNotModifiedMock() {
  const originalRequest = https.request;

  https.request = (options, onResponse) => {
    class FakeReq extends EventEmitter {
      write() {}
      end() {
        const res = new EventEmitter();
        setImmediate(() => {
          onResponse?.(res);
          res.emit('data', JSON.stringify({
            ok: false,
            error_code: 400,
            description: 'Bad Request: message is not modified',
          }));
          res.emit('end');
        });
      }
      destroy(err) {
        if (err) this.emit('error', err);
        this.emit('close');
      }
    }
    return new FakeReq();
  };

  return () => {
    https.request = originalRequest;
  };
}

async function main() {
  const checks = [];
  const cleanupFns = [];

  try {
    ensureTestTelegramEnv(process.env, { token: TEST_TELEGRAM_BOT_TOKEN });
    const taskStatus = await import('../commands/task-status.mjs');
    const { renderTaskStatus, cmdTaskStatusUpdate, getTaskData } = taskStatus;

    {
      const taskData = {
        task_id: 'stable-render',
        title: 'Stable render',
        agents: '["coder"]',
        status: 'running',
        created_at: '2026-04-05T18:00:00.000Z',
        updated_at: '2026-04-05T18:00:05.000Z',
      };
      const agentStatuses = new Map([
        ['coder', {
          state: 'working',
          step: 'same payload',
          progress: '10',
          updated_at: '2026-04-05T18:00:06.000Z',
        }],
      ]);

      const first = renderTaskStatus(taskData, agentStatuses);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const second = renderTaskStatus(taskData, agentStatuses);
      assert.equal(second, first, 'render must stay stable when input state is unchanged');

      const changedStatuses = new Map([
        ['coder', {
          state: 'working',
          step: 'changed payload',
          progress: '25',
          updated_at: '2026-04-05T18:00:07.000Z',
        }],
      ]);
      const changed = renderTaskStatus(taskData, changedStatuses);
      assert.notEqual(changed, first, 'render must still change when agent state changes');
      checks.push('renderTaskStatus is deterministic for unchanged input and still reacts to real status changes');
    }

    {
      const taskId = `noop-refresh-${Date.now()}`;
      const taskKey = `openclaw:task-status:${taskId}`;
      const originalUpdatedAt = '2026-04-05T18:01:00.000Z';
      cleanupFns.push(() => {
        del(taskKey);
        try { redisCli(['SREM', 'openclaw:task-status:active', taskId]); } catch {}
      });

      redisCli(['HSET', taskKey,
        'task_id', taskId,
        'run_id', taskId,
        'title', `No-op refresh ${taskId}`,
        'agents', '["coder"]',
        'topic_id', '72',
        'chat_id', TEST_TELEGRAM_CHAT_ID,
        'status', 'running',
        'message_id', '123456',
        'coordinator_id', 'teamlead',
        'owner_id', 'teamlead',
        'close_owner_id', 'teamlead',
        'creator_id', 'teamlead',
        'created_at', '2026-04-05T18:00:00.000Z',
        'updated_at', originalUpdatedAt,
      ]);
      redisCli(['SADD', 'openclaw:task-status:active', taskId]);
      redisCli(['HSET', 'openclaw:agents:status:coder',
        'state', 'working',
        'step', 'same payload',
        'progress', '10',
        'updated_at', '2026-04-05T18:01:00.000Z',
      ]);
      cleanupFns.push(() => {
        try { del('openclaw:agents:status:coder'); } catch {}
      });

      const restoreHttps = installTelegramNotModifiedMock();
      cleanupFns.push(restoreHttps);

      const stdoutWrites = [];
      const originalStdoutWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk, encoding, cb) => {
        stdoutWrites.push(String(chunk));
        if (typeof encoding === 'function') return encoding();
        if (typeof cb === 'function') cb();
        return true;
      });

      await cmdTaskStatusUpdate(['--task-id', taskId]);
      process.stdout.write = originalStdoutWrite;

      const persisted = getTaskData(taskId);
      assert.equal(persisted.updated_at, originalUpdatedAt, 'no-op refresh must not bump task updated_at');

      const output = JSON.parse(stdoutWrites.join('').trim());
      assert.equal(output.ok, true);
      assert.equal(output.tg_ok, false);
      assert.equal(output.modified, false);
      assert.equal(output.skipped, true);
      checks.push('task-status-update does not touch updated_at when Telegram reports message is not modified');
    }

    console.log(JSON.stringify({
      ok: true,
      test: 'task-status-noop-refresh',
      checks,
    }));
  } finally {
    while (cleanupFns.length > 0) {
      const cleanup = cleanupFns.pop();
      try { cleanup(); } catch {}
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
