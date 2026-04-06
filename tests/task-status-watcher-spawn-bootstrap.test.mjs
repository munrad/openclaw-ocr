import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import { setTimeout as sleep } from 'node:timers/promises';
import { CONFIG } from '../lib/config.mjs';

const OCR_BIN = new URL('../index.mjs', import.meta.url);

function redisCli(args) {
  const base = ['-h', CONFIG.host, '-p', String(CONFIG.port), '--no-auth-warning'];
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
  const taskId = `spawn-bootstrap-${Date.now()}`;
  const testAgent = `spawnbot-${Date.now()}`;
  const watcherKey = 'openclaw:task-status-watcher:last_event_id';
  const createdMessages = [];
  const heartbeatKey = `openclaw:heartbeat:${testAgent}`;
  const snapshots = {
    agent: snapshotHash(`openclaw:agents:status:${testAgent}`),
    task: snapshotHash(`openclaw:task-status:${taskId}`),
  };

  let watcherProc = null;
  let watcherLogs = '';

  async function stopWatcher() {
    if (!watcherProc) return;
    const proc = watcherProc;
    watcherProc = null;
    proc.kill('SIGTERM');
    await new Promise((resolve) => proc.once('close', resolve));
  }

  try {
    ocr(['init']);
    del(watcherKey, `openclaw:task-status:${taskId}`);
    del(`openclaw:agents:status:${testAgent}`);

    const watcherEnv = {
      ...process.env,
      STATUS_PUBSUB_ENABLED: '0',
    };

    watcherProc = spawn('node', [OCR_BIN.pathname, 'daemon', 'task-status'], {
      env: watcherEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    watcherProc.stdout.on('data', (chunk) => { watcherLogs += String(chunk); });
    watcherProc.stderr.on('data', (chunk) => { watcherLogs += String(chunk); });

    await sleep(1500);
    assert.match(watcherLogs, /task-status-watcher/i);

    ocr(['emit', 'agent_spawned', JSON.stringify({
      agent: testAgent,
      agent_id: testAgent,
      run_id: taskId,
      task_id: taskId,
      title: `Spawn bootstrap ${taskId}`,
      channel: 'telegram',
      to: 'channel:-1003891295903',
      thread_id: '1',
      chat_id: '-1003891295903',
      topic_id: '1',
      label: 'ocr-bootstrap-test',
      mode: 'run',
      target_kind: 'subagent',
    })]);

    let taskHash = {};
    let agentHash = {};
    for (let i = 0; i < 24; i++) {
      await sleep(500);
      taskHash = hgetall(`openclaw:task-status:${taskId}`);
      agentHash = hgetall(`openclaw:agents:status:${testAgent}`);
      if (taskHash.message_id && agentHash.state === 'queued') break;
    }

    assert.ok(taskHash.message_id, 'spawn should create tracker message immediately');
    assert.deepEqual(JSON.parse(taskHash.agents || '[]'), [testAgent]);
    assert.equal(agentHash.state, 'queued');
    assert.equal(agentHash.step, 'spawned, awaiting first worker update');
    assert.equal(agentHash.progress, '0');
    assert.equal(agentHash.run_id, taskId);
    createdMessages.push({ chatId: taskHash.chat_id || '-1003891295903', messageId: taskHash.message_id });

    const initialMessageId = taskHash.message_id;

    ocr(['emit', 'agent_spawned', JSON.stringify({
      agent: testAgent,
      agent_id: testAgent,
      run_id: taskId,
      task_id: taskId,
      title: `Spawn bootstrap ${taskId}`,
      channel: 'telegram',
      to: 'channel:-1003891295903',
      thread_id: '1',
      chat_id: '-1003891295903',
      topic_id: '1',
      label: 'ocr-bootstrap-test',
      mode: 'run',
      target_kind: 'subagent',
    })]);

    await sleep(1000);
    const duplicateTaskHash = hgetall(`openclaw:task-status:${taskId}`);
    assert.equal(duplicateTaskHash.message_id, initialMessageId, 'duplicate agent_spawned must be idempotent');

    ocr(['set-status', testAgent, JSON.stringify({
      state: 'working',
      step: `first worker update ${taskId}`,
      progress: 20,
      run_id: taskId,
    })]);

    for (let i = 0; i < 24; i++) {
      await sleep(500);
      const updatedAgent = hgetall(`openclaw:agents:status:${testAgent}`);
      const updatedTask = hgetall(`openclaw:task-status:${taskId}`);
      if (updatedAgent.state === 'working' && updatedTask.message_id === initialMessageId) break;
    }

    const afterFirstStatusTaskHash = hgetall(`openclaw:task-status:${taskId}`);
    const afterFirstStatusAgentHash = hgetall(`openclaw:agents:status:${testAgent}`);
    assert.equal(afterFirstStatusTaskHash.message_id, initialMessageId, 'first worker status must reuse existing tracker');
    assert.equal(afterFirstStatusAgentHash.state, 'working');
    assert.equal(afterFirstStatusAgentHash.run_id, taskId);

    // degrade -> stale
    del(heartbeatKey);
    redisCli(['HSET', `openclaw:agents:status:${testAgent}`, 'updated_at', '1-0']);
    ocr(['reconcile-statuses', '--agents', testAgent, '--active-stale-grace-ms', '0']);

    for (let i = 0; i < 24; i++) {
      await sleep(500);
      const degraded = hgetall(`openclaw:agents:status:${testAgent}`);
      if (degraded.state === 'stale') break;
    }
    assert.equal(hgetall(`openclaw:agents:status:${testAgent}`).state, 'stale', 'reconcile should degrade active status to stale');

    // stale -> idle auto-idle
    del(heartbeatKey);
    redisCli(['HSET', `openclaw:agents:status:${testAgent}`, 'updated_at', '1-0']);
    ocr(['reconcile-statuses', '--agents', testAgent, '--stale-to-idle-ms', '0']);

    for (let i = 0; i < 24; i++) {
      await sleep(500);
      const autoIdled = hgetall(`openclaw:agents:status:${testAgent}`);
      if (autoIdled.state === 'idle') break;
    }
    assert.equal(hgetall(`openclaw:agents:status:${testAgent}`).state, 'idle', 'reconcile should auto-idle stale status');
    assert.equal(hgetall(`openclaw:task-status:${taskId}`).message_id, initialMessageId, 'degraded/auto-idled lifecycle must not duplicate tracker');

    await stopWatcher();

    ocr(['emit', 'agent_spawned', JSON.stringify({
      agent: testAgent,
      agent_id: testAgent,
      run_id: taskId,
      task_id: taskId,
      title: `Spawn bootstrap ${taskId}`,
      channel: 'telegram',
      to: 'channel:-1003891295903',
      thread_id: '1',
      chat_id: '-1003891295903',
      topic_id: '1',
      label: 'ocr-bootstrap-test',
      mode: 'run',
      target_kind: 'subagent',
    })]);

    watcherProc = spawn('node', [OCR_BIN.pathname, 'daemon', 'task-status'], {
      env: watcherEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    watcherProc.stdout.on('data', (chunk) => { watcherLogs += String(chunk); });
    watcherProc.stderr.on('data', (chunk) => { watcherLogs += String(chunk); });

    for (let i = 0; i < 24; i++) {
      await sleep(500);
      const replayedTask = hgetall(`openclaw:task-status:${taskId}`);
      if (replayedTask.message_id === initialMessageId) break;
    }
    assert.equal(hgetall(`openclaw:task-status:${taskId}`).message_id, initialMessageId, 'watcher replay/restart must stay idempotent');

    await stopWatcher();

    const close = ocr([
      'task-status-close',
      '--task-id', taskId,
      '--result', 'success',
      '--actor-id', testAgent,
    ], { allowFailure: true }).json;
    if (close?.ok) {
      assert.equal(close.ok, true);
    }

    console.log(JSON.stringify({
      ok: true,
      checks: [
        'agent_spawned bootstraps tracker immediately',
        'agent_spawned bootstraps initial queued status before first worker status',
        'duplicate agent_spawned is idempotent',
        'first worker status reuses existing tracker',
        'agent_status_degraded and agent_auto_idled propagate without tracker duplication',
        'watcher restart/replay does not create duplicates',
      ],
    }));
  } finally {
    await stopWatcher().catch(() => {});
    for (const msg of createdMessages) {
      await deleteTelegramMessage(msg.chatId, msg.messageId).catch(() => {});
    }
    del(`openclaw:task-status:${taskId}`, watcherKey, 'openclaw:task-status:active', heartbeatKey);
    restoreHash(`openclaw:agents:status:${testAgent}`, snapshots.agent);
    restoreHash(`openclaw:task-status:${taskId}`, snapshots.task);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
