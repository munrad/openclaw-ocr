import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

function ocr(args) {
  const out = execFileSync('node', [OCR_BIN.pathname, ...args], {
    encoding: 'utf8',
    env: process.env,
  }).trim();
  return JSON.parse(out);
}

function pendingEntries(group = 'openclaw-workers') {
  const raw = redisCli(['XPENDING', 'openclaw:tasks:stream', group, '-', '+', '100']);
  if (!raw || raw === '(nil)') return [];
  const clean = raw.split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => l.replace(/^\d+\)\s*/, '').replace(/^"(.*)"$/, '$1').replace(/^\(integer\)\s*/, ''));
  const out = [];
  for (let i = 0; i + 3 < clean.length; i += 4) {
    out.push({ msg_id: clean[i], consumer: clean[i + 1], idle_ms: Number(clean[i + 2]) || 0, delivery_count: Number(clean[i + 3]) || 0 });
  }
  return out;
}

const cleanup = {
  taskIds: new Set(),
  taskStreamMsgIds: new Set(),
  pipelineIds: new Set(),
  loopIds: new Set(),
  groups: new Set(),
};

function cleanupArtifacts() {
  for (const taskId of cleanup.taskIds) {
    try { redisCli(['DEL', `openclaw:tasks:result:${taskId}`]); } catch {}
    try { redisCli(['DEL', `openclaw:locks:task:${taskId}`]); } catch {}
    try { redisCli(['ZREM', 'openclaw:tasks:priority', taskId]); } catch {}
  }
  for (const msgId of cleanup.taskStreamMsgIds) {
    try { redisCli(['XDEL', 'openclaw:tasks:stream', msgId]); } catch {}
  }
  for (const pipelineId of cleanup.pipelineIds) {
    try { redisCli(['SREM', 'openclaw:pipelines:active', pipelineId]); } catch {}
    try { redisCli(['DEL', `openclaw:pipeline:${pipelineId}`]); } catch {}
  }
  for (const loopId of cleanup.loopIds) {
    try { redisCli(['SREM', 'openclaw:feedback-loops:active', loopId]); } catch {}
    try { redisCli(['DEL', `openclaw:feedback-loop:${loopId}`]); } catch {}
  }
  for (const group of cleanup.groups) {
    try { redisCli(['XGROUP', 'DESTROY', 'openclaw:tasks:stream', group]); } catch {}
  }
}

try {
  ocr(['init']);

  // 1) Claimed tasks must stay recoverable; watchdog must requeue instead of dropping them.
  const watchdogGroup = `watchdog-test-${Date.now()}`;
  cleanup.groups.add(watchdogGroup);
  try { redisCli(['XGROUP', 'DESTROY', 'openclaw:tasks:stream', watchdogGroup]); } catch {}
  redisCli(['XGROUP', 'CREATE', 'openclaw:tasks:stream', watchdogGroup, '$', 'MKSTREAM']);

  const pushed = ocr(['push-task', JSON.stringify({
    type: 'lifecycle-hygiene-test',
    target_agent: 'coder',
    priority: 7,
    payload: { scope: 'watchdog' },
  })]);
  assert.equal(pushed.ok, true);
  const taskId = pushed.task_id;
  cleanup.taskIds.add(taskId);

  const claimed = ocr(['claim-task', 'coder', watchdogGroup]);
  assert.equal(claimed.ok, true);
  assert.equal(claimed.task_id, taskId);
  cleanup.taskStreamMsgIds.add(claimed.stream_msg_id);

  const pendingAfterClaim = pendingEntries(watchdogGroup);
  assert.ok(pendingAfterClaim.some((entry) => entry.msg_id === claimed.stream_msg_id && entry.consumer === 'coder'));

  const watchdog = ocr(['watchdog', '--group', watchdogGroup, '--idle-ms', '0']);
  assert.equal(watchdog.ok, true);
  const requeuedAction = watchdog.actions.find((action) => action.task_id === taskId && action.action === 'requeued');
  assert.ok(requeuedAction, 'watchdog should requeue orphaned task instead of ACK-dropping it');
  cleanup.taskStreamMsgIds.add(requeuedAction.requeued_msg_id);

  const reclaimed = ocr(['claim-task', 'coder', watchdogGroup]);
  assert.equal(reclaimed.ok, true);
  assert.equal(reclaimed.task_id, taskId);
  assert.equal(reclaimed.stream_msg_id, requeuedAction.requeued_msg_id);

  const completed = ocr(['complete-task', taskId, JSON.stringify({ agent: 'coder', summary: 'done' })]);
  assert.equal(completed.ok, true);
  assert.equal(redisCli(['ZSCORE', 'openclaw:tasks:priority', taskId]), '');

  // 2) Completed pipelines must remain queryable until GC, not disappear immediately.
  const pipelineTaskId = `t-pipeline-${Date.now()}`;
  const startedPipeline = ocr(['start-pipeline', '--task-id', pipelineTaskId, '--template', 'documentation']);
  assert.equal(startedPipeline.ok, true);
  cleanup.pipelineIds.add(startedPipeline.pipeline_id);

  for (let i = 0; i < 3; i++) {
    const advanced = ocr([
      'advance-pipeline',
      '--pipeline-id', startedPipeline.pipeline_id,
      '--result', JSON.stringify({ verdict: 'done', output: `step-${i + 1}` }),
    ]);
    assert.equal(advanced.ok, true);
  }

  const pipelineStatus = ocr(['get-pipeline', '--pipeline-id', startedPipeline.pipeline_id]);
  assert.equal(pipelineStatus.ok, true);
  assert.equal(pipelineStatus.state, 'completed');
  assert.equal(pipelineStatus.history.length, 3);
  assert.equal(redisCli(['SISMEMBER', 'openclaw:pipelines:active', startedPipeline.pipeline_id]), '0');
  assert.equal(redisCli(['EXISTS', `openclaw:pipeline:by-task:${pipelineTaskId}`]), '0');
  const completedPipelines = ocr(['list-pipelines', '--status', 'completed', '--limit', '20']);
  assert.ok(completedPipelines.pipelines.some((p) => p.pipeline_id === startedPipeline.pipeline_id));

  // 3) Completed feedback loops must remain queryable until GC, not disappear immediately.
  const loopTaskId = `t-loop-${Date.now()}`;
  const startedLoop = ocr([
    'start-loop',
    '--type', 'code-review',
    '--task-id', loopTaskId,
    '--initiator', 'coder',
    '--target', 'reviewer',
  ]);
  assert.equal(startedLoop.ok, true);
  cleanup.loopIds.add(startedLoop.loop_id);

  const loopFail = ocr([
    'loop-result',
    '--loop-id', startedLoop.loop_id,
    '--agent', 'reviewer',
    '--verdict', 'fail',
    '--details', JSON.stringify({ issue: 'needs fix' }),
  ]);
  assert.equal(loopFail.ok, true);
  assert.equal(loopFail.state, 'active');

  const loopFix = ocr([
    'loop-result',
    '--loop-id', startedLoop.loop_id,
    '--agent', 'coder',
    '--verdict', 'fix',
    '--details', JSON.stringify({ patch: 'applied' }),
  ]);
  assert.equal(loopFix.ok, true);

  const loopPass = ocr([
    'loop-result',
    '--loop-id', startedLoop.loop_id,
    '--agent', 'reviewer',
    '--verdict', 'pass',
    '--details', JSON.stringify({ verdict: 'clean' }),
  ]);
  assert.equal(loopPass.ok, true);
  assert.equal(loopPass.state, 'completed');

  const loopStatus = ocr(['loop-status', '--loop-id', startedLoop.loop_id]);
  assert.equal(loopStatus.ok, true);
  assert.equal(loopStatus.state, 'completed');
  assert.equal(loopStatus.history.length, 3);
  assert.equal(redisCli(['SISMEMBER', 'openclaw:feedback-loops:active', startedLoop.loop_id]), '0');
  const completedLoops = ocr(['loop-list', '--status', 'completed', '--limit', '20']);
  assert.ok(completedLoops.loops.some((loop) => loop.loop_id === startedLoop.loop_id));

  console.log(JSON.stringify({ ok: true, task_id: taskId, pipeline_id: startedPipeline.pipeline_id, loop_id: startedLoop.loop_id }));
} finally {
  cleanupArtifacts();
}
