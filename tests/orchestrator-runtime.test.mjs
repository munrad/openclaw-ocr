import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { CONFIG } from '../lib/config.mjs';
import {
  TEST_TELEGRAM_CHAT_ID,
  ensureTestTelegramEnv,
} from './helpers/telegram-test-config.mjs';

const OCR_BIN = new URL('../index.mjs', import.meta.url);
ensureTestTelegramEnv(process.env);

const password = CONFIG.password || process.env.REDIS_PASSWORD || (() => {
  try { return readFileSync('/run/secrets/redis_password', 'utf8').trim(); } catch { return ''; }
})();
const baseRedisArgs = ['-h', CONFIG.host, '-p', String(CONFIG.port), '-n', String(CONFIG.db || 0), '--no-auth-warning'];
if (password) baseRedisArgs.push('-a', password);

function redisCli(args) {
  return execFileSync('redis-cli', [...baseRedisArgs, ...args], { encoding: 'utf8' }).trim();
}

function hgetall(key) {
  const raw = redisCli(['--raw', 'HGETALL', key]);
  const lines = raw.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const obj = {};
  for (let i = 0; i < lines.length; i += 2) obj[lines[i]] = lines[i + 1] ?? '';
  return obj;
}

function ocr(args, { env = process.env } = {}) {
  const out = execFileSync('node', [OCR_BIN.pathname, ...args], { encoding: 'utf8', env }).trim();
  return { json: JSON.parse(out), raw: out };
}

test('orchestrate-fanout creates coordinator-owned child tasks with shared parent run metadata', () => {
  ocr(['init']);
  const group = `orchestrator-${Date.now()}`;
  try { redisCli(['XGROUP', 'CREATE', 'openclaw:tasks:stream', group, '$', 'MKSTREAM']); } catch {}
  try {
    const result = ocr([
      'orchestrate-fanout',
      '--goal', 'Implement and verify fan-out runtime',
      '--agents', 'coder,tester',
      '--coordinator-id', 'teamlead',
      '--title', 'Fan-out runtime QA',
    ]).json;

    assert.equal(result.ok, true);
    assert.equal(result.coordinator_id, 'teamlead');
    assert.equal(result.child_count, 2);
    assert.equal(result.tracker, null);

    const orchestrationHash = hgetall(`openclaw:orchestration:${result.task_id}`);
    assert.equal(orchestrationHash.coordinator_id, 'teamlead');
    assert.equal(orchestrationHash.phase, 'fanout_completed');
    assert.equal(orchestrationHash.status, 'active');

    const coderClaim = ocr(['claim-task', 'coder', group]).json;
    const testerClaim = ocr(['claim-task', 'tester', group]).json;
    assert.equal(coderClaim.ok, true);
    assert.equal(testerClaim.ok, true);
    assert.equal(coderClaim.payload.parent_task_id, result.task_id);
    assert.equal(testerClaim.payload.parent_task_id, result.task_id);
    assert.equal(coderClaim.payload.parent_run_id, result.run_id);
    assert.equal(testerClaim.payload.parent_run_id, result.run_id);
    assert.equal(coderClaim.payload.run_id, result.run_id);
    assert.equal(testerClaim.payload.run_id, result.run_id);
    assert.equal(coderClaim.payload.assigned_by, 'teamlead');
    assert.equal(testerClaim.payload.assigned_by, 'teamlead');
  } finally {
    try { redisCli(['XGROUP', 'DESTROY', 'openclaw:tasks:stream', group]); } catch {}
  }
});

test('orchestrate-fanout persists tracker ownership on degraded Telegram delivery', () => {
  const env = ensureTestTelegramEnv({ ...process.env });
  const result = ocr([
    'orchestrate-fanout',
    '--goal', 'Track a degraded Telegram projection safely',
    '--agents', 'coder,tester',
    '--coordinator-id', 'teamlead',
    '--title', 'Tracker ownership QA',
    '--create-tracker', 'true',
    '--topic-id', '1',
    '--chat-id', TEST_TELEGRAM_CHAT_ID,
  ], { env }).json;

  assert.equal(result.ok, true);
  assert.ok(result.tracker, 'tracker result must be present');

  const trackerHash = hgetall(`openclaw:task-status:${result.task_id}`);
  assert.equal(trackerHash.coordinator_id, 'teamlead');
  assert.equal(trackerHash.owner_id, 'teamlead');
  assert.equal(trackerHash.close_owner_id, 'teamlead');
  assert.equal(trackerHash.creator_id, 'teamlead');
  assert.equal(trackerHash.run_id, result.run_id);
});

test('pipeline and roundtable auto-trackers use explicit coordinator ownership instead of hardcoded nerey', () => {
  const env = ensureTestTelegramEnv({ ...process.env });

  const pipelineTaskId = `pipeline-owner-${Date.now()}`;
  const pipeline = ocr([
    'start-pipeline',
    '--task-id', pipelineTaskId,
    '--template', 'documentation',
    '--coordinator-id', 'teamlead',
    '--owner-id', 'teamlead',
  ], { env }).json;
  assert.equal(pipeline.ok, true);
  const pipelineTrackerHash = hgetall(`openclaw:task-status:${pipelineTaskId}`);
  assert.equal(pipelineTrackerHash.coordinator_id, 'teamlead');
  assert.notEqual(pipelineTrackerHash.coordinator_id, 'nerey');

  const roundtable = ocr([
    'roundtable-create',
    '--topic', `Ownership QA ${Date.now()}`,
    '--participants', 'coder,tester',
    '--coordinator-id', 'reviewer',
    '--owner-id', 'reviewer',
  ], { env }).json;
  assert.equal(roundtable.ok, true);
  const roundtableTrackerHash = hgetall(`openclaw:task-status:${roundtable.rt_id}`);
  assert.equal(roundtableTrackerHash.coordinator_id, 'reviewer');
  assert.notEqual(roundtableTrackerHash.coordinator_id, 'nerey');
});
