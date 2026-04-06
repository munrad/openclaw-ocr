import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { CONFIG } from '../lib/config.mjs';
import { ensureTaskStatusTracker, getTaskData } from '../commands/task-status.mjs';

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

async function main() {
  const taskId = `bootstrap-pending-${Date.now()}`;
  const taskKey = `openclaw:task-status:${taskId}`;
  const agentStatusKey = 'openclaw:agents:status:tester';
  const agentStatusSnapshot = redisCli(['--raw', 'HGETALL', agentStatusKey]);

  try {
    redisCli(['HSET', taskKey,
      'task_id', taskId,
      'run_id', taskId,
      'title', `Bootstrap pending ${taskId}`,
      'agents', '["coder"]',
      'topic_id', '1',
      'chat_id', '-1003891295903',
      'status', 'running',
      'coordinator_id', 'teamlead',
      'owner_id', 'teamlead',
      'close_owner_id', 'teamlead',
      'creator_id', 'teamlead',
      'bootstrap_pending', '1',
      'created_at', new Date().toISOString(),
      'updated_at', new Date().toISOString(),
    ]);
    redisCli(['SADD', 'openclaw:task-status:active', taskId]);

    const result = await ensureTaskStatusTracker(taskId, {
      agent_id: 'tester',
      chat_id: '-1003891295903',
      topic_id: '1',
      run_id: taskId,
      title: `Bootstrap pending ${taskId}`,
      coordinator_id: 'teamlead',
    });

    assert.equal(result.ok, true);
    assert.equal(result.created, false);
    assert.equal(result.bootstrap_pending, true);
    assert.equal(result.fallback_reason, 'bootstrap_pending_from_prior_attempt');
    assert.equal(result.message_id, null);

    const task = getTaskData(taskId);
    const agents = JSON.parse(task.agents || '[]');
    assert.deepEqual(agents.sort(), ['coder', 'tester'].sort());
    assert.equal(task.bootstrap_pending, '1');
    assert.ok(!task.message_id, 'duplicate prevention path must not create message_id');

    console.log(JSON.stringify({
      ok: true,
      test: 'task-status-bootstrap-pending',
      checks: [
        'bootstrap_pending path does not re-attempt TG create',
        'agent is merged into agents list',
        'message_id stays empty until explicit recovery',
      ],
    }));
  } finally {
    del(taskKey);
    try { redisCli(['SREM', 'openclaw:task-status:active', taskId]); } catch {}
    del(agentStatusKey);
    if (agentStatusSnapshot.trim()) {
      const lines = agentStatusSnapshot.split('\n').filter(Boolean);
      if (lines.length) {
        const args = ['HSET', agentStatusKey];
        for (let i = 0; i < lines.length; i += 2) args.push(lines[i], lines[i + 1] ?? '');
        redisCli(args);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
