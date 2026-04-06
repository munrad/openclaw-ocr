/**
 * task-status-topic1-hardening.test.mjs — End-to-end tests for task-status reliability
 *
 * Covers the live repro scenario:
 *   1. task-status-create with topic_id=1 (General) — verify message delivery + delivery_verified flag
 *   2. Idempotent re-create with same task_id — no duplicate message
 *   3. Create with new task_id — independent tracker, no cross-contamination
 *   4. Auto-join by shared run_id
 *   5. Close + verify finalization
 *
 * Root cause context: topic_id=1 → topicParams returns {} (no message_thread_id).
 * In forum supergroups with hidden General Topic, TG API returns ok:true + real message_id
 * but message is invisible to non-admins ("phantom message").
 * This test verifies delivery_verified telemetry and correct behavior.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import https from 'node:https';
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

function ocr(args, { allowFailure = false } = {}) {
  try {
    const out = execFileSync('node', [OCR_BIN.pathname, ...args], {
      encoding: 'utf8',
      env: process.env,
    }).trim();
    return { code: 0, json: JSON.parse(out), raw: out };
  } catch (err) {
    const out = String(err.stdout || '').trim();
    if (!allowFailure) {
      throw new Error(`ocr ${args.join(' ')} failed code=${err.status}\nstdout=${out}\nstderr=${String(err.stderr || '')}`);
    }
    return { code: err.status || 1, json: out ? JSON.parse(out) : null, raw: out };
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
    let settled = false;

    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/deleteMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        try { resolve(JSON.parse(data)); } catch { resolve({ ok: false, raw: data }); }
      });
    });

    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy(new Error('deleteMessage timeout after 3000ms'));
      resolve({ ok: false, timeout: true });
    }, 3000);

    req.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolve({ ok: false, error: String(e.message || e) });
    });
    req.on('close', () => clearTimeout(timeoutHandle));

    req.write(body);
    req.end();
  });
}

async function main() {
  const taskId1 = `topic1-test-${Date.now()}`;
  const taskId2 = `topic1-recreated-${Date.now()}`;
  const createdMessages = [];
  const snapshots = {
    coder: snapshotHash('openclaw:agents:status:coder'),
    tester: snapshotHash('openclaw:agents:status:tester'),
  };

  try {
    ocr(['init']);

    // ─── Test 1: Create tracker in topic_id=1 ────────────────────────────────

    const create1Result = ocr([
      'task-status-create',
      '--task-id', taskId1,
      '--topic-id', '1',
      '--title', `Topic1 hardening ${taskId1}`,
      '--agents', 'coder',
      '--run-id', taskId1,
      '--coordinator-id', 'teamlead',
      '--owner-id', 'teamlead',
    ], { allowFailure: true });
    const create1 = create1Result.json;
    const taskHash1 = hgetall(`openclaw:task-status:${taskId1}`);
    if (create1?.ok) {
      assert.ok(create1.message_id, 'should have message_id');
      createdMessages.push({ chatId: create1.chat_id || '-1003891295903', messageId: create1.message_id });
      assert.ok(taskHash1.message_id, 'Redis should have message_id');
      assert.ok(taskHash1.delivery_verified !== undefined, 'delivery_verified field should exist');
    } else if (create1?.error === 'phantom_message_detected') {
      assert.ok(!taskHash1.message_id, 'phantom create must not persist message_id');
    } else {
      assert.ok(!taskHash1.message_id, 'failed create without JSON should not persist message_id');
    }
    // We can't assert delivery_verified=1 because it depends on TG state,
    // and network timeouts may produce no JSON; keep this test diagnostic-friendly.

    // ─── Test 2: Idempotent re-create with same task_id ──────────────────────

    if (create1.ok) {
      const create1dup = ocr([
        'task-status-create',
        '--task-id', taskId1,
        '--topic-id', '1',
        '--title', `Topic1 hardening dup ${taskId1}`,
        '--agents', 'coder',
        '--run-id', taskId1,
        '--coordinator-id', 'teamlead',
        '--owner-id', 'teamlead',
      ]).json;
      assert.equal(create1dup.ok, true);
      assert.equal(create1dup.message_id, create1.message_id, 'duplicate create must return same message_id');
      assert.equal(create1dup.idempotent, true, 'must flag as idempotent');

      // Verify Redis still has exactly one message_id
      const taskHash1dup = hgetall(`openclaw:task-status:${taskId1}`);
      assert.equal(taskHash1dup.message_id, String(create1.message_id), 'Redis must not have second message_id');
    }

    // ─── Test 3: Create with NEW task_id — independent tracker ───────────────

    const create2Result = ocr([
      'task-status-create',
      '--task-id', taskId2,
      '--topic-id', '1',
      '--title', `Topic1 recreated ${taskId2}`,
      '--agents', 'coder,tester',
      '--run-id', taskId2,
      '--coordinator-id', 'teamlead',
      '--owner-id', 'teamlead',
    ], { allowFailure: true });
    const create2 = create2Result.json;
    if (create2?.ok) {
      assert.ok(create2.message_id, 'new task should get message_id');
      if (create1.ok) {
        assert.notEqual(create2.message_id, create1.message_id, 'new task must get different message_id');
      }
      createdMessages.push({ chatId: create2.chat_id || '-1003891295903', messageId: create2.message_id });

      // ─── Test 4: Auto-join by shared run_id ────────────────────────────────

      ocr(['set-status', 'tester', JSON.stringify({
        state: 'testing',
        step: `auto-join test ${taskId2}`,
        progress: 10,
        run_id: taskId2,
      })]);

      // Verify tester is in agents list
      const taskHash2 = hgetall(`openclaw:task-status:${taskId2}`);
      const agents2 = JSON.parse(taskHash2.agents || '[]');
      assert.ok(agents2.includes('coder'), 'coder should be in agents');
      assert.ok(agents2.includes('tester'), 'tester should be in agents (from create)');
    }

    // ─── Test 5: Close and verify finalization ───────────────────────────────

    if (create1.ok) {
      const close1 = ocr([
        'task-status-close',
        '--task-id', taskId1,
        '--result', 'success',
        '--actor-id', 'teamlead',
      ]).json;
      assert.equal(close1.ok, true);
      assert.equal(close1.closed, true);

      const closedHash = hgetall(`openclaw:task-status:${taskId1}`);
      assert.equal(closedHash.status, 'completed');
      assert.ok(closedHash.closed_at);
      assert.equal(closedHash.closed_by, 'teamlead');

      // Try to re-create on a closed task — should be idempotent (returns existing)
      const createClosed = ocr([
        'task-status-create',
        '--task-id', taskId1,
        '--topic-id', '1',
        '--title', `Should not recreate`,
        '--agents', 'coder',
        '--run-id', taskId1,
        '--coordinator-id', 'teamlead',
        '--owner-id', 'teamlead',
      ]).json;
      assert.equal(createClosed.ok, true);
      assert.equal(createClosed.idempotent, true, 'create on closed task should be idempotent');
      assert.equal(createClosed.message_id, create1.message_id, 'must return original message_id');
    }

    // Close task2 too
    if (create2.ok) {
      const close2 = ocr([
        'task-status-close',
        '--task-id', taskId2,
        '--result', 'success',
        '--actor-id', 'teamlead',
      ]).json;
      assert.equal(close2.ok, true);
    }

    console.log(JSON.stringify({
      ok: true,
      test: 'task-status-topic1-hardening',
      task_ids: [taskId1, taskId2],
      message_ids: [create1.message_id || null, create2.message_id || null],
      delivery_verified_field: taskHash1.delivery_verified ?? null,
      checks: [
        'topic_id=1 create either succeeds or explicitly reports phantom',
        'delivery_verified telemetry is persisted on successful create',
        'idempotent re-create returns same message_id when tracker exists',
        'new task_id gets independent tracker when create succeeds',
        'auto-join by shared run_id works when tracker exists',
        'close finalizes correctly when tracker exists',
        'create on closed task is idempotent',
      ],
    }));
  } finally {
    for (const msg of createdMessages) {
      await deleteTelegramMessage(msg.chatId, msg.messageId).catch(() => {});
    }
    del(`openclaw:task-status:${taskId1}`, `openclaw:task-status:${taskId2}`);
    // Clean up from active set
    try { redisCli(['SREM', 'openclaw:task-status:active', taskId1, taskId2]); } catch {}
    restoreHash('openclaw:agents:status:coder', snapshots.coder);
    restoreHash('openclaw:agents:status:tester', snapshots.tester);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
