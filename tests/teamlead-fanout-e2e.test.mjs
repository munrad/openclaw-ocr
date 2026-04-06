import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import { setTimeout as sleep } from 'node:timers/promises';
import { CONFIG } from '../lib/config.mjs';

const OCR_BIN = new URL('../index.mjs', import.meta.url);
const password = CONFIG.password || process.env.REDIS_PASSWORD || (() => {
  try { return readFileSync('/run/secrets/redis_password', 'utf8').trim(); } catch { return ''; }
})();
const baseRedisArgs = ['-h', CONFIG.host, '-p', String(CONFIG.port), '-n', String(CONFIG.db || 0), '--no-auth-warning'];
if (password) baseRedisArgs.push('-a', password);

function redisCli(args) {
  return execFileSync('redis-cli', [...baseRedisArgs, ...args], { encoding: 'utf8' }).trim();
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

function del(...keys) {
  if (keys.length) redisCli(['DEL', ...keys]);
}

function hgetall(key) {
  const raw = redisCli(['--raw', 'HGETALL', key]);
  const lines = raw.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const obj = {};
  for (let i = 0; i < lines.length; i += 2) obj[lines[i]] = lines[i + 1] ?? '';
  return obj;
}

function smembers(key) {
  const raw = redisCli(['--raw', 'SMEMBERS', key]);
  return raw.split('\n').map((s) => s.trim()).filter(Boolean);
}

function snapshotHash(key) {
  const obj = hgetall(key);
  return Object.keys(obj).length ? obj : null;
}

function restoreHash(key, snapshot) {
  del(key);
  if (!snapshot) return;
  const args = ['HSET', key];
  for (const [k, v] of Object.entries(snapshot)) args.push(k, String(v));
  redisCli(args);
}

function deleteTelegramMessage(chatId, messageId) {
  const token = process.env.OPENCLAW_TELEGRAM_BOT_TOKEN;
  if (!token || !messageId) return Promise.resolve({ ok: false, skipped: true });
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: chatId, message_id: Number(messageId) });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/deleteMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ ok: false, raw: data }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: String(e.message || e) }));
    req.write(body);
    req.end();
  });
}

async function main() {
  const qa = `teamlead-fanout-${Date.now()}`;
  const skipTelegram = process.env.OCR_INTEGRATION_SKIP_TELEGRAM === '1';
  const workerGroup = `qa-teamlead-${Date.now()}`;
  const rootTitle = `Telegram dedupe orchestration ${qa}`;
  const trackedAgents = ['teamlead', 'coder', 'tester', 'reviewer', 'writer'];
  const childAgents = ['coder', 'tester', 'reviewer', 'writer'];
  const snapshots = Object.fromEntries(
    trackedAgents.map((agentId) => [agentId, snapshotHash(`openclaw:agents:status:${agentId}`)])
  );
  const createdMessages = [];
  const createdTaskIds = [];
  const childTaskIds = new Map();
  let watcherProc = null;
  let watcherLogs = '';
  let rootTaskId = null;

  async function stopWatcher() {
    if (!watcherProc) return;
    const proc = watcherProc;
    watcherProc = null;
    proc.kill('SIGTERM');
    await new Promise((resolve) => proc.once('close', resolve));
  }

  try {
    ocr(['init']);
    try { redisCli(['XGROUP', 'CREATE', 'openclaw:tasks:stream', workerGroup, '$', 'MKSTREAM']); } catch {}

    const rootPush = ocr(['push-task', JSON.stringify({
      type: 'feature',
      target_agent: 'teamlead',
      payload: {
        qa,
        objective: 'dedupe incoming telegram tasks with redis as source of truth',
        requested_agents: childAgents,
      },
    })]).json;
    rootTaskId = rootPush.task_id;
    createdTaskIds.push(rootTaskId);

    const rootClaim = ocr(['claim-task', 'teamlead', workerGroup]).json;
    assert.equal(rootClaim.ok, true);
    assert.equal(rootClaim.task_id, rootTaskId);
    assert.deepEqual(rootClaim.payload.requested_agents, childAgents);

    const duplicateRootClaim = ocr(['claim-task', 'teamlead', workerGroup], { allowFailure: true });
    assert.equal(duplicateRootClaim.code, 1);
    assert.equal(duplicateRootClaim.json.reason, 'no_tasks');

    ocr(['set-status', 'teamlead', JSON.stringify({
      state: 'working',
      step: `planning fan-out ${qa}`,
      progress: 10,
      run_id: rootTaskId,
    })]);

    const taskStatusResult = ocr([
      'task-status-create',
      '--task-id', rootTaskId,
      '--topic-id', '1',
      '--title', rootTitle,
      '--agents', 'coder',
      '--run-id', rootTaskId,
      '--coordinator-id', 'teamlead',
      '--owner-id', 'teamlead',
    ], { allowFailure: true }).json;
    const taskStatus = taskStatusResult?.ok
      ? taskStatusResult
      : (() => {
          if (!skipTelegram) {
            assert.equal(taskStatusResult?.ok, true);
          }
          const createdAt = new Date().toISOString();
          const synthetic = {
            ok: true,
            task_id: rootTaskId,
            message_id: '777001',
            chat_id: '-1003891295903',
          };
          redisCli(['HSET', `openclaw:task-status:${rootTaskId}`,
            'task_id', rootTaskId,
            'run_id', rootTaskId,
            'title', rootTitle,
            'agents', '["coder"]',
            'topic_id', '1',
            'chat_id', synthetic.chat_id,
            'message_id', synthetic.message_id,
            'status', 'running',
            'coordinator_id', 'teamlead',
            'owner_id', 'teamlead',
            'close_owner_id', 'teamlead',
            'creator_id', 'teamlead',
            'created_at', createdAt,
            'updated_at', createdAt,
          ]);
          redisCli(['SADD', 'openclaw:task-status:active', rootTaskId]);
          return synthetic;
        })();
    createdMessages.push({ chatId: taskStatus.chat_id || '-1003891295903', messageId: taskStatus.message_id });

    watcherProc = spawn('node', [OCR_BIN.pathname, 'daemon', 'task-status'], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    watcherProc.stdout.on('data', (chunk) => { watcherLogs += String(chunk); });
    watcherProc.stderr.on('data', (chunk) => { watcherLogs += String(chunk); });

    await sleep(1500);
    assert.match(watcherLogs, /task-status-watcher/i);

    for (const agentId of childAgents) {
      const pushed = ocr(['push-task', JSON.stringify({
        type: agentId === 'writer' ? 'docs' : 'general',
        target_agent: agentId,
        payload: {
          qa,
          parent_task_id: rootTaskId,
          run_id: rootTaskId,
          assigned_by: 'teamlead',
          role: agentId,
        },
      })]).json;
      createdTaskIds.push(pushed.task_id);
      childTaskIds.set(agentId, pushed.task_id);
    }

    ocr(['set-status', 'teamlead', JSON.stringify({
      state: 'waiting',
      step: `awaiting coder/tester/reviewer/writer ${qa}`,
      progress: 25,
      run_id: rootTaskId,
    })]);

    for (const agentId of childAgents) {
      const claim = ocr(['claim-task', agentId, workerGroup]).json;
      assert.equal(claim.ok, true);
      assert.equal(claim.task_id, childTaskIds.get(agentId));
      assert.equal(claim.payload.parent_task_id, rootTaskId);
      assert.equal(claim.payload.run_id, rootTaskId);
      assert.equal(claim.payload.assigned_by, 'teamlead');
    }

    ocr(['set-status', 'coder', JSON.stringify({
      state: 'working',
      step: `implement dedupe ${qa}`,
      progress: 35,
      run_id: rootTaskId,
    })]);
    ocr(['set-status', 'tester', JSON.stringify({
      state: 'waiting',
      step: `waiting for implementation ${qa}`,
      progress: 5,
      run_id: rootTaskId,
    })]);
    ocr(['set-status', 'reviewer', JSON.stringify({
      state: 'waiting',
      step: `waiting for review target ${qa}`,
      progress: 5,
      run_id: rootTaskId,
    })]);
    ocr(['set-status', 'writer', JSON.stringify({
      state: 'waiting',
      step: `waiting for technical outcome ${qa}`,
      progress: 5,
      run_id: rootTaskId,
    })]);

    let trackerAgents = [];
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const taskHash = hgetall(`openclaw:task-status:${rootTaskId}`);
      trackerAgents = JSON.parse(taskHash.agents || '[]');
      if (childAgents.every((agentId) => trackerAgents.includes(agentId))) break;
    }
    assert.ok(childAgents.every((agentId) => trackerAgents.includes(agentId)), 'watcher should auto-join all child agents by shared run_id');
    for (const agentId of childAgents) {
      assert.equal(trackerAgents.filter((id) => id === agentId).length, 1, `tracker should contain ${agentId} exactly once`);
    }

    ocr(['set-status', 'reviewer', JSON.stringify({
      state: 'reviewing',
      step: `reviewing implementation ${qa}`,
      progress: 40,
      run_id: rootTaskId,
    })]);
    ocr(['set-status', 'reviewer', JSON.stringify({
      state: 'reviewing',
      step: `deep review ${qa}`,
      progress: 55,
      run_id: rootTaskId,
    })]);
    await sleep(2000);

    const trackerHashAfterReplay = hgetall(`openclaw:task-status:${rootTaskId}`);
    const trackerAgentsAfterReplay = JSON.parse(trackerHashAfterReplay.agents || '[]');
    assert.equal(trackerAgentsAfterReplay.filter((agentId) => agentId === 'reviewer').length, 1, 'replayed reviewer statuses must not duplicate tracker membership');

    ocr(['complete-task', childTaskIds.get('coder'), JSON.stringify({ agent: 'coder', summary: `implementation ready ${qa}` })]);
    ocr(['set-status', 'coder', JSON.stringify({
      state: 'completed',
      step: `implemented ${qa}`,
      progress: 100,
      run_id: rootTaskId,
    })]);

    ocr(['set-status', 'tester', JSON.stringify({
      state: 'testing',
      step: `running e2e ${qa}`,
      progress: 60,
      run_id: rootTaskId,
    })]);
    ocr(['complete-task', childTaskIds.get('tester'), JSON.stringify({ agent: 'tester', summary: `tests green ${qa}` })]);
    ocr(['set-status', 'tester', JSON.stringify({
      state: 'completed',
      step: `tested ${qa}`,
      progress: 100,
      run_id: rootTaskId,
    })]);

    ocr(['set-status', 'reviewer', JSON.stringify({
      state: 'reviewing',
      step: `approving ${qa}`,
      progress: 80,
      run_id: rootTaskId,
    })]);
    ocr(['complete-task', childTaskIds.get('reviewer'), JSON.stringify({ agent: 'reviewer', summary: `review accepted ${qa}` })]);
    ocr(['set-status', 'reviewer', JSON.stringify({
      state: 'completed',
      step: `reviewed ${qa}`,
      progress: 100,
      run_id: rootTaskId,
    })]);

    ocr(['set-status', 'writer', JSON.stringify({
      state: 'working',
      step: `updating docs ${qa}`,
      progress: 85,
      run_id: rootTaskId,
    })]);
    ocr(['complete-task', childTaskIds.get('writer'), JSON.stringify({ agent: 'writer', summary: `docs updated ${qa}` })]);
    ocr(['set-status', 'writer', JSON.stringify({
      state: 'completed',
      step: `documented ${qa}`,
      progress: 100,
      run_id: rootTaskId,
    })]);

    ocr(['set-status', 'teamlead', JSON.stringify({
      state: 'reviewing',
      step: `aggregating child outputs ${qa}`,
      progress: 90,
      run_id: rootTaskId,
    })]);

    for (const agentId of childAgents) {
      const taskHash = hgetall(`openclaw:tasks:result:${childTaskIds.get(agentId)}`);
      const statusHash = hgetall(`openclaw:agents:status:${agentId}`);
      assert.equal(taskHash.status, 'done');
      assert.equal(statusHash.run_id, rootTaskId);
      assert.equal(statusHash.state, 'completed');
    }

    const finalTrackerHash = hgetall(`openclaw:task-status:${rootTaskId}`);
    const finalTrackerAgents = JSON.parse(finalTrackerHash.agents || '[]');
    assert.equal(finalTrackerHash.run_id, rootTaskId);
    assert.equal(finalTrackerHash.coordinator_id, 'teamlead');
    assert.equal(finalTrackerHash.owner_id, 'teamlead');
    assert.ok(childAgents.every((agentId) => finalTrackerAgents.includes(agentId)));
    for (const agentId of childAgents) {
      assert.equal(finalTrackerAgents.filter((id) => id === agentId).length, 1, `final tracker should contain ${agentId} exactly once`);
    }

    const rootComplete = ocr(['complete-task', rootTaskId, JSON.stringify({
      agent: 'teamlead',
      summary: `coordinated fan-out ${qa}`,
      artifacts: { child_agents: childAgents },
    })]).json;
    assert.equal(rootComplete.ok, true);
    ocr(['set-status', 'teamlead', JSON.stringify({
      state: 'completed',
      step: `completed orchestration ${qa}`,
      progress: 100,
      run_id: rootTaskId,
    })]);

    const closeTaskStatus = ocr([
      'task-status-close',
      '--task-id', rootTaskId,
      '--result', 'success',
      '--actor-id', 'teamlead',
    ]).json;
    assert.equal(closeTaskStatus.ok, true);

    const rootResultHash = hgetall(`openclaw:tasks:result:${rootTaskId}`);
    const closedTrackerHash = hgetall(`openclaw:task-status:${rootTaskId}`);
    assert.equal(rootResultHash.status, 'done');
    assert.equal(closedTrackerHash.status, 'completed');
    assert.equal(closedTrackerHash.closed_by, 'teamlead');
    assert.ok(!smembers('openclaw:task-status:active').includes(rootTaskId));

    console.log(JSON.stringify({
      ok: true,
      summary: {
        qa,
        root_task_id: rootTaskId,
        child_tasks: Object.fromEntries(childTaskIds),
        checks: [
          'root task claimed once by teamlead',
          'teamlead created shared task-status tracker',
          'teamlead fan-out preserved parent_task_id + shared run_id',
          'task-status watcher auto-joined coder/tester/reviewer/writer',
          'replayed child statuses did not duplicate tracker membership',
          'all child tasks completed with shared run_id context',
          'teamlead completed and closed the root task',
        ],
      },
    }, null, 2));
  } finally {
    await stopWatcher().catch(() => {});
    if (rootTaskId) {
      redisCli(['SREM', 'openclaw:task-status:active', rootTaskId]);
      del(`openclaw:task-status:${rootTaskId}`);
    }
    for (const taskId of createdTaskIds) {
      del(`openclaw:tasks:result:${taskId}`, `openclaw:locks:task:${taskId}`);
    }
    try { redisCli(['XGROUP', 'DESTROY', 'openclaw:tasks:stream', workerGroup]); } catch {}
    for (const agentId of trackedAgents) {
      restoreHash(`openclaw:agents:status:${agentId}`, snapshots[agentId]);
    }
    for (const msg of createdMessages) {
      await deleteTelegramMessage(msg.chatId, msg.messageId).catch(() => {});
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
