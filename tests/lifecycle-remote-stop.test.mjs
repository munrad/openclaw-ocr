import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { CONFIG } from '../lib/config.mjs';

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

function hgetall(key) {
  const raw = redisCli(['--raw', 'HGETALL', key]);
  const lines = raw.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const obj = {};
  for (let i = 0; i < lines.length; i += 2) obj[lines[i]] = lines[i + 1] ?? '';
  return obj;
}

function del(...keys) {
  if (keys.length > 0) redisCli(['DEL', ...keys]);
}

async function waitFor(check, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

test('lifecycle stop uses Redis-backed coordination to end a lifecycle start process', async () => {
  const runId = `remote-stop-${Date.now()}`;
  const registrationKey = `openclaw:lifecycle:run:coder:${runId}`;
  const runsKey = 'openclaw:lifecycle:agent:coder:runs';
  const stopKey = `openclaw:lifecycle:stop:coder:${runId}`;
  const statusKey = 'openclaw:agents:status:coder';
  const heartbeatKey = 'openclaw:heartbeat:coder';

  let child = null;

  try {
    del(registrationKey, stopKey, statusKey, heartbeatKey);
    try { redisCli(['SREM', runsKey, runId]); } catch {}

    child = spawn('node', [
      OCR_BIN.pathname,
      'lifecycle',
      'start',
      'coder',
      '--run-id', runId,
      '--heartbeat-ms', '200',
      '--step', 'remote stop test',
    ], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    await waitFor(() => {
      const reg = hgetall(registrationKey);
      return reg.run_id === runId ? reg : null;
    });

    const startOutput = await waitFor(() => stdout.trim() ? stdout.trim() : null);
    const startPayload = JSON.parse(startOutput);
    assert.equal(startPayload.ok, true);
    assert.equal(startPayload.run_id, runId);

    const stopOut = execFileSync('node', [
      OCR_BIN.pathname,
      'lifecycle',
      'stop',
      'coder',
      '--run-id', runId,
      '--status', 'completed',
      '--step', 'remote stop applied',
    ], {
      encoding: 'utf8',
      env: process.env,
    }).trim();
    const stopPayload = JSON.parse(stopOut);
    assert.equal(stopPayload.ok, true);
    assert.equal(stopPayload.mode, 'remote_stop_requested');
    assert.equal(stopPayload.requests.length, 1);
    assert.equal(stopPayload.requests[0].run_id, runId);

    const exitResult = await Promise.race([
      new Promise((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
      }),
      sleep(3000).then(() => {
        throw new Error('Timed out waiting for lifecycle child process to exit');
      }),
    ]);

    assert.equal(exitResult.code, 0, `expected clean child exit, got ${JSON.stringify(exitResult)}`);

    const finalStatus = await waitFor(() => {
      const status = hgetall(statusKey);
      return status.state === 'completed' && status.run_id === runId ? status : null;
    });
    assert.equal(finalStatus.step, 'remote stop applied');
    assert.equal(redisCli(['SISMEMBER', runsKey, runId]), '0', 'run must be removed from registered lifecycle set');
    assert.equal(redisCli(['EXISTS', registrationKey]), '0', 'registration hash must be deleted after remote stop');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGTERM'); } catch {}
      await sleep(100);
    }
    try { redisCli(['SREM', runsKey, runId]); } catch {}
    del(registrationKey, stopKey, statusKey, heartbeatKey);
  }
});
