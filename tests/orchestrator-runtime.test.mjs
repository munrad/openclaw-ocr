import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { CONFIG } from '../lib/config.mjs';
import { createTaskPayload, persistTaskStatus } from '../commands/task-status.mjs';
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

function exists(key) {
  return redisCli(['EXISTS', key]) === '1';
}

function sismember(key, member) {
  return redisCli(['SISMEMBER', key, member]) === '1';
}

function ocr(args, { env = process.env, allowFailure = false } = {}) {
  try {
    const out = execFileSync('node', [OCR_BIN.pathname, ...args], { encoding: 'utf8', env }).trim();
    return { json: JSON.parse(out), raw: out };
  } catch (error) {
    if (!allowFailure) throw error;
    const raw = String(error.stdout || '').trim();
    return { json: JSON.parse(raw), raw, error };
  }
}

test('orchestrate-fanout creates coordinator-owned child tasks with shared parent run metadata', () => {
  ocr(['init']);
  const group = `orchestrator-${Date.now()}`;
  let rootTaskId = null;
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
    rootTaskId = result.task_id;
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
    if (rootTaskId) {
      try { redisCli(['SREM', 'openclaw:orchestrations:active', rootTaskId]); } catch {}
    }
    try { redisCli(['XGROUP', 'DESTROY', 'openclaw:tasks:stream', group]); } catch {}
  }
});

test('orchestrate-fanout persists tracker ownership on degraded Telegram delivery', () => {
  const env = ensureTestTelegramEnv({ ...process.env });
  let rootTaskId = null;
  try {
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
    rootTaskId = result.task_id;
    assert.ok(result.tracker, 'tracker result must be present');

    const trackerHash = hgetall(`openclaw:task-status:${result.task_id}`);
    assert.equal(trackerHash.coordinator_id, 'teamlead');
    assert.equal(trackerHash.owner_id, 'teamlead');
    assert.equal(trackerHash.close_owner_id, 'teamlead');
    assert.equal(trackerHash.creator_id, 'teamlead');
    assert.equal(trackerHash.run_id, result.run_id);
  } finally {
    if (rootTaskId) {
      try { redisCli(['SREM', 'openclaw:orchestrations:active', rootTaskId]); } catch {}
    }
  }
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

test('orchestrate-fanout enforces the configured child fan-out limit', () => {
  const env = { ...process.env, OPENCLAW_MAX_FANOUT_CHILDREN: '1' };
  const taskId = `fanout-limit-${Date.now()}`;
  const result = ocr([
    'orchestrate-fanout',
    '--task-id', taskId,
    '--goal', 'Too many children for this test',
    '--agents', 'coder,tester',
    '--coordinator-id', 'teamlead',
  ], { env }).json;

  assert.equal(result.ok, false);
  assert.equal(result.error, 'fanout_limit_exceeded');
  assert.equal(result.limit, 1);
  assert.equal(exists(`openclaw:orchestration:${taskId}`), false);
});

test('orchestrate-fanout enforces active orchestration limits after pruning the active index', () => {
  const env = { ...process.env, OPENCLAW_MAX_ACTIVE_ORCHESTRATIONS: '1' };
  const first = ocr([
    'orchestrate-fanout',
    '--goal', 'First active orchestration',
    '--agents', 'coder',
    '--coordinator-id', 'teamlead',
    '--title', 'active-one',
  ], { env }).json;

  assert.equal(first.ok, true);
  assert.equal(sismember('openclaw:orchestrations:active', first.task_id), true);

  const second = ocr([
    'orchestrate-fanout',
    '--goal', 'Second active orchestration',
    '--agents', 'tester',
    '--coordinator-id', 'teamlead',
    '--title', 'active-two',
  ], { env }).json;

  assert.equal(second.ok, false);
  assert.equal(second.error, 'active_orchestration_limit_exceeded');
  assert.equal(second.limit, 1);

  try { redisCli(['SREM', 'openclaw:orchestrations:active', first.task_id]); } catch {}
});

test('get-orchestration returns trackerless snapshots with child result and status summaries', () => {
  ocr(['init']);
  const group = `orchestrator-snapshot-${Date.now()}`;
  let rootTaskId = null;
  try { redisCli(['XGROUP', 'CREATE', 'openclaw:tasks:stream', group, '$', 'MKSTREAM']); } catch {}
  try {
    const created = ocr([
      'orchestrate-fanout',
      '--goal', 'Inspect orchestrator snapshot coverage',
      '--agents', 'coder,tester',
      '--coordinator-id', 'teamlead',
      '--title', 'Snapshot QA',
    ]).json;

    assert.equal(created.ok, true);
    rootTaskId = created.task_id;

    const coderClaim = ocr(['claim-task', 'coder', group]).json;
    const testerClaim = ocr(['claim-task', 'tester', group]).json;
    ocr(['set-status', 'coder', JSON.stringify({
      state: 'completed',
      step: 'implemented fix',
      progress: 100,
      run_id: created.run_id,
    })]);
    ocr(['set-status', 'tester', JSON.stringify({
      state: 'failed',
      step: 'regression detected',
      progress: 80,
      run_id: created.run_id,
    })]);
    ocr(['complete-task', coderClaim.task_id, '{"agent":"coder","summary":"implementation done"}']);
    ocr(['fail-task', testerClaim.task_id, 'regression detected']);

    const snapshot = ocr(['get-orchestration', '--task-id', rootTaskId]).json;
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.orchestration.task_id, rootTaskId);
    assert.equal(snapshot.orchestration.child_result_summary.done, 1);
    assert.equal(snapshot.orchestration.child_result_summary.failed, 1);
    assert.equal(snapshot.orchestration.child_status_summary.completed, 1);
    assert.equal(snapshot.orchestration.child_status_summary.failed, 1);
    assert.equal(snapshot.orchestration.tracker, null);
    assert.equal(snapshot.orchestration.children.length, 2);
  } finally {
    if (rootTaskId) {
      try { redisCli(['SREM', 'openclaw:orchestrations:active', rootTaskId]); } catch {}
    }
    try { redisCli(['XGROUP', 'DESTROY', 'openclaw:tasks:stream', group]); } catch {}
  }
});

test('get-orchestration isolates child statuses to the orchestration run id', () => {
  const coder = `isolated-coder-${Date.now()}`;
  const tester = `isolated-tester-${Date.now()}`;
  let rootTaskId = null;
  let childTaskIds = [];

  try {
    ocr(['set-status', coder, JSON.stringify({
      state: 'working',
      step: 'foreign coder work',
      progress: 41,
      run_id: 'foreign-run',
    })]);
    ocr(['set-status', tester, JSON.stringify({
      state: 'testing',
      step: 'foreign tester work',
      progress: 73,
      run_id: 'foreign-run',
    })]);

    const created = ocr([
      'orchestrate-fanout',
      '--goal', 'Isolate statuses per orchestration run',
      '--agents', `${coder},${tester}`,
      '--coordinator-id', 'teamlead',
      '--title', 'Run isolation QA',
    ]).json;

    assert.equal(created.ok, true);
    rootTaskId = created.task_id;
    childTaskIds = created.children.map((child) => child.task_id);

    const expectedTitles = new Map(created.children.map((child) => [child.agent, child.title]));
    const snapshot = ocr(['get-orchestration', '--task-id', rootTaskId]).json;
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.orchestration.child_status_summary.queued, 2);

    const statuses = new Map(snapshot.orchestration.child_statuses.map((entry) => [entry.agent, entry]));
    const coderStatus = statuses.get(coder);
    const testerStatus = statuses.get(tester);

    assert.ok(coderStatus, 'coder child status must exist');
    assert.ok(testerStatus, 'tester child status must exist');

    assert.equal(coderStatus.state, 'queued');
    assert.equal(testerStatus.state, 'queued');
    assert.equal(coderStatus.run_id, created.run_id);
    assert.equal(testerStatus.run_id, created.run_id);
    assert.equal(coderStatus.step, expectedTitles.get(coder));
    assert.equal(testerStatus.step, expectedTitles.get(tester));
    assert.notEqual(coderStatus.step, 'foreign coder work');
    assert.notEqual(testerStatus.step, 'foreign tester work');
  } finally {
    const cleanupKeys = [
      `openclaw:agent_status:${coder}`,
      `openclaw:agent_status:${tester}`,
    ];
    if (rootTaskId) {
      cleanupKeys.push(`openclaw:orchestration:${rootTaskId}`);
      try { redisCli(['SREM', 'openclaw:orchestrations:active', rootTaskId]); } catch {}
    }
    for (const childTaskId of childTaskIds) {
      cleanupKeys.push(`openclaw:task:${childTaskId}`, `openclaw:task:result:${childTaskId}`);
    }
    try { redisCli(['DEL', ...cleanupKeys]); } catch {}
  }
});

test('list-orchestrations surfaces child progress counters for active roots', () => {
  ocr(['init']);
  const group = `orchestrator-list-${Date.now()}`;
  let rootTaskId = null;
  try { redisCli(['XGROUP', 'CREATE', 'openclaw:tasks:stream', group, '$', 'MKSTREAM']); } catch {}
  try {
    const created = ocr([
      'orchestrate-fanout',
      '--goal', 'List root orchestration counters',
      '--agents', 'coder,tester',
      '--coordinator-id', 'teamlead',
      '--title', 'List QA',
    ]).json;

    rootTaskId = created.task_id;
    const coderClaim = ocr(['claim-task', 'coder', group]).json;
    ocr(['complete-task', coderClaim.task_id, '{"agent":"coder","summary":"done"}']);

    const listed = ocr(['list-orchestrations', '--status', 'active']).json;
    assert.equal(listed.ok, true);
    const current = listed.orchestrations.find((entry) => entry.task_id === rootTaskId);
    assert.ok(current, 'current root must be listed');
    assert.equal(current.done_children, 1);
    assert.equal(current.pending_children, 1);
    assert.equal(current.failed_children, 0);
  } finally {
    if (rootTaskId) {
      try { redisCli(['SREM', 'openclaw:orchestrations:active', rootTaskId]); } catch {}
    }
    try { redisCli(['XGROUP', 'DESTROY', 'openclaw:tasks:stream', group]); } catch {}
  }
});

test('close-orchestration rejects incomplete children unless forced', () => {
  const created = ocr([
    'orchestrate-fanout',
    '--goal', 'Require force for incomplete children',
    '--agents', 'coder',
    '--coordinator-id', 'teamlead',
    '--title', 'Incomplete close QA',
  ]).json;

  assert.equal(created.ok, true);

  const denied = ocr([
    'close-orchestration',
    '--task-id', created.task_id,
    '--actor-id', 'teamlead',
    '--result', 'success',
  ], { allowFailure: true }).json;

  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'children_incomplete');

  const forced = ocr([
    'close-orchestration',
    '--task-id', created.task_id,
    '--actor-id', 'teamlead',
    '--result', 'success',
    '--force', 'true',
  ]).json;

  assert.equal(forced.ok, true);
  assert.equal(forced.forced, true);
  assert.equal(forced.forced_reason, 'children_incomplete');
  assert.equal(sismember('openclaw:orchestrations:active', created.task_id), false);
});

test('close-orchestration succeeds without force after child tasks reach terminal states', () => {
  ocr(['init']);
  const group = `orchestrator-close-happy-${Date.now()}`;
  let rootTaskId = null;
  try { redisCli(['XGROUP', 'CREATE', 'openclaw:tasks:stream', group, '$', 'MKSTREAM']); } catch {}
  try {
    const created = ocr([
      'orchestrate-fanout',
      '--goal', 'Terminal child happy path',
      '--agents', 'coder,tester',
      '--coordinator-id', 'teamlead',
      '--title', 'Terminal close QA',
    ]).json;

    rootTaskId = created.task_id;
    const coderClaim = ocr(['claim-task', 'coder', group]).json;
    const testerClaim = ocr(['claim-task', 'tester', group]).json;
    ocr(['complete-task', coderClaim.task_id, '{"agent":"coder","summary":"done"}']);
    ocr(['complete-task', testerClaim.task_id, '{"agent":"tester","summary":"verified"}']);

    const closed = ocr([
      'close-orchestration',
      '--task-id', rootTaskId,
      '--actor-id', 'teamlead',
      '--result', 'success',
      '--summary', 'all children terminal',
    ]).json;

    assert.equal(closed.ok, true);
    assert.equal(closed.forced, false);
    assert.equal(closed.child_result_summary.done, 2);
    assert.equal(closed.child_result_summary.pending, 0);

    const finalSnapshot = ocr(['get-orchestration', '--task-id', rootTaskId]).json;
    assert.equal(finalSnapshot.ok, true);
    assert.equal(finalSnapshot.orchestration.status, 'completed');
    assert.equal(finalSnapshot.orchestration.active_indexed, false);
  } finally {
    if (rootTaskId) {
      try { redisCli(['SREM', 'openclaw:orchestrations:active', rootTaskId]); } catch {}
    }
    try { redisCli(['XGROUP', 'DESTROY', 'openclaw:tasks:stream', group]); } catch {}
  }
});

test('close-orchestration closes the root and suppresses tracker projection when Telegram config is unavailable', () => {
  const taskId = `orchestration-close-${Date.now()}`;
  const createdAt = new Date().toISOString();

  try { redisCli(['DEL', `openclaw:orchestration:${taskId}`]); } catch {}
  try { redisCli(['SREM', 'openclaw:orchestrations:active', taskId]); } catch {}
  persistTaskStatus(taskId, {
    ...createTaskPayload(taskId, {
      title: 'Manual tracker seed',
      agents: ['coder'],
      chat_id: TEST_TELEGRAM_CHAT_ID,
      topic_id: '1',
      run_id: taskId,
      coordinator_id: 'teamlead',
      owner_id: 'teamlead',
      close_owner_id: 'teamlead',
      creator_id: 'teamlead',
    }),
    message_id: '123',
    created_at: createdAt,
    updated_at: createdAt,
  });

  redisCli(['HSET', `openclaw:orchestration:${taskId}`,
    'task_id', taskId,
    'run_id', taskId,
    'title', 'Recovery close QA',
    'goal', 'Close a root orchestration without Telegram credentials',
    'status', 'active',
    'phase', 'fanout_completed',
    'coordinator_id', 'teamlead',
    'owner_id', 'teamlead',
    'close_owner_id', 'teamlead',
    'creator_id', 'teamlead',
    'child_agents', '["coder"]',
    'created_children', '[]',
    'child_count', '1',
    'tracker_enabled', '1',
    'created_at', createdAt,
    'updated_at', createdAt,
  ]);
  redisCli(['EXPIRE', `openclaw:orchestration:${taskId}`, '604800']);
  redisCli(['SADD', 'openclaw:orchestrations:active', taskId]);

  const env = { ...process.env };
  env.OPENCLAW_TELEGRAM_BOT_TOKEN = ' ';
  env.OPENCLAW_TELEGRAM_CHAT_ID = ' ';
  env.OPENCLAW_TELEGRAM_TOPIC_ID = ' ';

  const closed = ocr([
    'close-orchestration',
    '--task-id', taskId,
    '--actor-id', 'teamlead',
    '--result', 'success',
    '--summary', 'manual recovery close',
  ], { env }).json;

  assert.equal(closed.ok, true);
  assert.equal(closed.closed, true);
  assert.equal(closed.result, 'success');
  assert.equal(closed.tracker_close.ok, true);
  assert.equal(closed.tracker_close.projection_skipped, true);

  const orchestrationHash = hgetall(`openclaw:orchestration:${taskId}`);
  assert.equal(orchestrationHash.status, 'completed');
  assert.equal(orchestrationHash.phase, 'closed');
  assert.equal(orchestrationHash.closed_by, 'teamlead');
  assert.equal(sismember('openclaw:orchestrations:active', taskId), false);

  const trackerHash = hgetall(`openclaw:task-status:${taskId}`);
  assert.equal(trackerHash.status, 'completed');
  assert.equal(trackerHash.delivery_state, 'suppressed');
});
