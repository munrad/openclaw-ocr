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

async function main() {
  const taskId = `tswr-${Date.now()}`;
  const watcherKey = 'openclaw:task-status-watcher:last_event_id';
  const createdMessages = [];
  const snapshots = {
    coder: snapshotHash('openclaw:agents:status:coder'),
    reviewer: snapshotHash('openclaw:agents:status:reviewer'),
    watcherTask: null,
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
    del(watcherKey);

    const create = ocr([
      'task-status-create',
      '--task-id', taskId,
      '--topic-id', '1',
      '--title', `Watcher fallback ${taskId}`,
      '--agents', 'tester',
      '--run-id', taskId,
      '--coordinator-id', 'teamlead',
      '--owner-id', 'teamlead',
    ]).json;
    assert.equal(create.ok, true);
    createdMessages.push({ chatId: create.chat_id || '-1003891295903', messageId: create.message_id });

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
    assert.match(watcherLogs, /Pub\/Sub: disabled/i);

    ocr(['set-status', 'coder', JSON.stringify({
      state: 'working',
      step: `fallback join ${taskId}`,
      progress: 25,
      run_id: taskId,
    })]);

    let agents = [];
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const taskHash = hgetall(`openclaw:task-status:${taskId}`);
      agents = JSON.parse(taskHash.agents || '[]');
      if (agents.includes('coder')) break;
    }
    assert.ok(agents.includes('tester'));
    assert.ok(agents.includes('coder'), 'watcher should auto-join coder via XREAD fallback');

    const savedLastEventId = redisCli(['GET', watcherKey]);
    assert.match(savedLastEventId, /^\d+-\d+$/);

    await stopWatcher();

    // Emit a new event while watcher is offline; restart must resume from saved last_event_id.
    ocr(['set-status', 'reviewer', JSON.stringify({
      state: 'reviewing',
      step: `resume join ${taskId}`,
      progress: 60,
      run_id: taskId,
    })]);

    watcherProc = spawn('node', [OCR_BIN.pathname, 'daemon', 'task-status'], {
      env: watcherEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    watcherProc.stdout.on('data', (chunk) => { watcherLogs += String(chunk); });
    watcherProc.stderr.on('data', (chunk) => { watcherLogs += String(chunk); });

    let resumedAgents = [];
    for (let i = 0; i < 24; i++) {
      await sleep(500);
      const taskHash = hgetall(`openclaw:task-status:${taskId}`);
      resumedAgents = JSON.parse(taskHash.agents || '[]');
      if (resumedAgents.includes('reviewer')) break;
    }
    assert.ok(resumedAgents.includes('reviewer'), 'watcher should resume from last_event_id and process reviewer event');

    const finalTaskHash = hgetall(`openclaw:task-status:${taskId}`);
    assert.equal(finalTaskHash.message_id, String(create.message_id), 'watcher must not create duplicate tracker messages');

    await stopWatcher();

    const close = ocr([
      'task-status-close',
      '--task-id', taskId,
      '--result', 'success',
      '--actor-id', 'teamlead',
    ]).json;
    assert.equal(close.ok, true);

    console.log(JSON.stringify({
      ok: true,
      checks: [
        'watcher fallback with STATUS_PUBSUB_ENABLED=0',
        'watcher saves last_event_id',
        'watcher resumes after restart from stream',
        'watcher does not create duplicate task-status message',
      ],
    }));
  } finally {
    await stopWatcher().catch(() => {});
    for (const msg of createdMessages) {
      await deleteTelegramMessage(msg.chatId, msg.messageId).catch(() => {});
    }
    del(`openclaw:task-status:${taskId}`, 'openclaw:task-status:active');
    restoreHash('openclaw:agents:status:coder', snapshots.coder);
    restoreHash('openclaw:agents:status:reviewer', snapshots.reviewer);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
