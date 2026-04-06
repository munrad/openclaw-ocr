import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { readFileSync } from 'node:fs';

import { CONFIG } from '../lib/config.mjs';
import {
  cmdTaskStatusClose,
  ensureTaskStatusTracker,
  getTaskData,
  tgApiSafe,
} from '../commands/task-status.mjs';

function redisCli(args) {
  const base = ['-h', CONFIG.host, '-p', String(CONFIG.port), '--no-auth-warning'];
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

function installHungTelegramRequestMock() {
  const originalRequest = https.request;

  https.request = () => {
    class FakeReq extends EventEmitter {
      write() {}
      end() {}
      destroy(err) {
        setImmediate(() => {
          this.emit('error', err);
          this.emit('close');
        });
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
    // Check 1: hard timeout really destroys stalled Telegram request.
    {
      const restoreHttps = installHungTelegramRequestMock();
      cleanupFns.push(restoreHttps);

      const startedAt = Date.now();
      const result = await tgApiSafe('editMessageText', { chat_id: 'x', message_id: 1, text: 'x' }, 1, {
        timeoutMs: 300,
      });
      const elapsedMs = Date.now() - startedAt;

      assert.equal(result.ok, false);
      assert.match(String(result.description || ''), /telegram request timeout/i);
      assert.ok(elapsedMs >= 250, `elapsed ${elapsedMs}ms should respect timeout floor`);
      assert.ok(elapsedMs < 1500, `elapsed ${elapsedMs}ms should stay bounded`);
      checks.push(`tgApiSafe hard-timeout: bounded at ${elapsedMs}ms`);

      restoreHttps();
      cleanupFns.pop();
    }

    // Check 2: duplicate create path returns existing tracker instead of sending another TG message.
    {
      const taskId = `dup-existing-${Date.now()}`;
      const taskKey = `openclaw:task-status:${taskId}`;
      cleanupFns.push(() => {
        del(taskKey);
        try { redisCli(['SREM', 'openclaw:task-status:active', taskId]); } catch {}
      });

      redisCli(['HSET', taskKey,
        'task_id', taskId,
        'run_id', taskId,
        'title', `Existing tracker ${taskId}`,
        'agents', '["coder"]',
        'topic_id', '72',
        'chat_id', '-1003891295903',
        'status', 'running',
        'message_id', '777001',
        'coordinator_id', 'teamlead',
        'owner_id', 'teamlead',
        'close_owner_id', 'teamlead',
        'creator_id', 'teamlead',
        'created_at', new Date().toISOString(),
        'updated_at', new Date().toISOString(),
      ]);
      redisCli(['SADD', 'openclaw:task-status:active', taskId]);

      const result = await ensureTaskStatusTracker(taskId, {
        agent_id: 'tester',
        chat_id: '-1003891295903',
        topic_id: '72',
        run_id: taskId,
        title: `Existing tracker ${taskId}`,
        coordinator_id: 'teamlead',
      });

      assert.equal(result.ok, true);
      assert.equal(result.created, false);
      assert.equal(result.joined, true);
      assert.equal(result.message_id, '777001');

      const persisted = getTaskData(taskId);
      assert.equal(persisted.message_id, '777001');
      assert.deepEqual(JSON.parse(persisted.agents).sort(), ['coder', 'tester'].sort());
      checks.push('duplicate create: existing message_id returned from Redis without second tracker');
    }

    // Check 3: close path stays bounded even when Telegram edit hangs.
    {
      const restoreHttps = installHungTelegramRequestMock();
      cleanupFns.push(restoreHttps);

      const previousTimeout = process.env.OCR_TASK_STATUS_TG_TIMEOUT_MS;
      const previousRetries = process.env.OCR_TASK_STATUS_TG_RETRIES;
      process.env.OCR_TASK_STATUS_TG_TIMEOUT_MS = '300';
      process.env.OCR_TASK_STATUS_TG_RETRIES = '1';
      cleanupFns.push(() => {
        if (previousTimeout === undefined) delete process.env.OCR_TASK_STATUS_TG_TIMEOUT_MS;
        else process.env.OCR_TASK_STATUS_TG_TIMEOUT_MS = previousTimeout;
        if (previousRetries === undefined) delete process.env.OCR_TASK_STATUS_TG_RETRIES;
        else process.env.OCR_TASK_STATUS_TG_RETRIES = previousRetries;
      });

      const taskId = `close-timeout-${Date.now()}`;
      const taskKey = `openclaw:task-status:${taskId}`;
      cleanupFns.push(() => {
        del(taskKey);
        try { redisCli(['SREM', 'openclaw:task-status:active', taskId]); } catch {}
      });

      const stdoutWrites = [];
      const originalStdoutWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk, encoding, cb) => {
        stdoutWrites.push(String(chunk));
        if (typeof encoding === 'function') return encoding();
        if (typeof cb === 'function') cb();
        return true;
      });

      redisCli(['HSET', taskKey,
        'task_id', taskId,
        'run_id', taskId,
        'title', `Close timeout ${taskId}`,
        'agents', '["coder"]',
        'topic_id', '72',
        'chat_id', '-1003891295903',
        'status', 'running',
        'message_id', '888002',
        'coordinator_id', 'teamlead',
        'owner_id', 'teamlead',
        'close_owner_id', 'teamlead',
        'creator_id', 'teamlead',
        'created_at', new Date().toISOString(),
        'updated_at', new Date().toISOString(),
      ]);
      redisCli(['SADD', 'openclaw:task-status:active', taskId]);

      const startedAt = Date.now();
      await cmdTaskStatusClose([
        '--task-id', taskId,
        '--result', 'success',
        '--actor-id', 'teamlead',
      ]);
      process.stdout.write = originalStdoutWrite;
      const elapsedMs = Date.now() - startedAt;

      assert.ok(elapsedMs < 2000, `close elapsed ${elapsedMs}ms should stay bounded`);
      const persisted = getTaskData(taskId);
      assert.equal(persisted.status, 'completed');
      assert.equal(persisted.closed_by, 'teamlead');
      assert.ok(stdoutWrites.some((line) => line.includes('"closed":true')), 'close command should still output success');
      checks.push(`task-status-close bounded timeout: completed in ${elapsedMs}ms despite hung TG edit`);
    }

    // Check 4: bootstrap_pending path — ensureTaskStatusTracker returns
    // bootstrap_pending: true without calling TG, and agent is joined.
    {
      const taskId = `bootstrap-pending-${Date.now()}`;
      const taskKey = `openclaw:task-status:${taskId}`;
      cleanupFns.push(() => {
        del(taskKey);
        try { redisCli(['SREM', 'openclaw:task-status:active', taskId]); } catch {}
      });

      // Pre-seed a tracker with bootstrap_pending='1' and no message_id
      redisCli(['HSET', taskKey,
        'task_id', taskId,
        'run_id', taskId,
        'title', `Bootstrap pending ${taskId}`,
        'agents', '["coder"]',
        'topic_id', '72',
        'chat_id', '-1003891295903',
        'status', 'running',
        'bootstrap_pending', '1',
        'coordinator_id', 'teamlead',
        'owner_id', 'teamlead',
        'close_owner_id', 'teamlead',
        'creator_id', 'teamlead',
        'created_at', new Date().toISOString(),
        'updated_at', new Date().toISOString(),
      ]);
      redisCli(['SADD', 'openclaw:task-status:active', taskId]);

      // Mock TG to track if any call is made
      let tgCalled = false;
      const restoreHttps = installHungTelegramRequestMock();
      const origRequest = https.request;
      // The hung mock already installed; wrap to detect calls
      const wrappedRequest = https.request;
      https.request = (...args) => {
        tgCalled = true;
        return wrappedRequest(...args);
      };
      cleanupFns.push(() => { https.request = origRequest; });

      const result = await ensureTaskStatusTracker(taskId, {
        agent_id: 'tester',
        chat_id: '-1003891295903',
        topic_id: '72',
        run_id: taskId,
        title: `Bootstrap pending ${taskId}`,
        coordinator_id: 'teamlead',
      });

      // Restore HTTPS immediately
      https.request = origRequest;
      restoreHttps();
      cleanupFns.pop(); // remove the https restore cleanup
      cleanupFns.pop(); // remove the hung mock cleanup (already restored)

      assert.equal(result.ok, true, 'bootstrap_pending path should return ok');
      assert.equal(result.bootstrap_pending, true, 'should indicate bootstrap_pending');
      assert.equal(result.message_id, null, 'no message_id when bootstrap_pending');
      assert.equal(result.created, false, 'not created — pending');
      assert.equal(result.joined, true, 'agent should be joined');
      assert.equal(tgCalled, false, 'should NOT call Telegram when bootstrap_pending');

      // Verify agent was added to agents[]
      const persisted = getTaskData(taskId);
      const agents = JSON.parse(persisted.agents);
      assert.ok(agents.includes('tester'), 'tester should be in agents[]');
      assert.ok(agents.includes('coder'), 'coder should still be in agents[]');
      checks.push('bootstrap_pending: returns pending, joins agent, does not call TG');
    }

    console.log(JSON.stringify({
      ok: true,
      test: 'task-status-timeout-idempotency',
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
