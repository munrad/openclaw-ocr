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
const baseRedisArgs = ['-h', CONFIG.host, '-p', String(CONFIG.port), '--no-auth-warning'];
if (password) baseRedisArgs.push('-a', password);

function redisCli(args) {
  return execFileSync('redis-cli', [...baseRedisArgs, ...args], { encoding: 'utf8' }).trim();
}

function redisJson(args) {
  const out = redisCli(['--raw', ...args]);
  return out;
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

function exists(key) {
  return redisCli(['EXISTS', key]) === '1';
}

function ttl(key) {
  return Number(redisCli(['TTL', key]));
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
  return raw.split('\n').map(s => s.trim()).filter(Boolean);
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

const created = {
  taskIds: [],
  taskStatusIds: [],
  pipelineIds: [],
  loopIds: [],
  roundtableIds: [],
  bugIds: [],
  messages: [],
  extraKeys: [],
};

async function main() {
  const qa = `qa-${Date.now()}`;
  const summary = { qa, checks: [], anomalies: [] };

  // init
  const init = ocr(['init']).json;
  assert.equal(init.ok, true);
  summary.checks.push('init');

  // tasks: targeted claim/complete/fail
  const testGroup = `qa-group-${Date.now()}`;
  try { redisCli(['XGROUP', 'CREATE', 'openclaw:tasks:stream', testGroup, '$', 'MKSTREAM']); } catch {}

  const pushed1 = ocr(['push-task', JSON.stringify({ type: 'general', target_agent: 'tester', payload: { qa, kind: 'complete' } })]).json;
  created.taskIds.push(pushed1.task_id);
  const claim1 = ocr(['claim-task', 'tester', testGroup]).json;
  assert.equal(claim1.ok, true);
  assert.equal(claim1.task_id, pushed1.task_id);
  const complete1 = ocr(['complete-task', pushed1.task_id, JSON.stringify({ agent: 'tester', summary: `done ${qa}` })]).json;
  assert.equal(complete1.ok, true);
  const task1Hash = hgetall(`openclaw:tasks:result:${pushed1.task_id}`);
  assert.equal(task1Hash.status, 'done');
  assert.equal(exists(`openclaw:locks:task:${pushed1.task_id}`), false);
  summary.checks.push('tasks: claim+complete');

  const pushed2 = ocr(['push-task', JSON.stringify({ type: 'general', target_agent: 'reviewer', payload: { qa, kind: 'reroute' } })]).json;
  created.taskIds.push(pushed2.task_id);
  const testerMiss = ocr(['claim-task', 'tester', testGroup], { allowFailure: true });
  assert.equal(testerMiss.code, 1);
  assert.equal(testerMiss.json.reason, 'no_tasks');
  const reviewerClaim = ocr(['claim-task', 'reviewer', testGroup]).json;
  assert.equal(reviewerClaim.ok, true);
  assert.equal(reviewerClaim.task_id, pushed2.task_id);
  const fail2 = ocr(['fail-task', pushed2.task_id, `expected fail ${qa}`]).json;
  assert.equal(fail2.ok, true);
  const task2Hash = hgetall(`openclaw:tasks:result:${pushed2.task_id}`);
  assert.equal(task2Hash.status, 'failed');
  summary.checks.push('tasks: target-agent reroute+fail');

  // recover-tasks
  const recover = ocr(['recover-tasks', '--idle-ms', '0', '--agent', `cleanup-${qa}`]).json;
  assert.equal(recover.ok, true);
  assert.ok(Array.isArray(recover.recovered));
  summary.checks.push('recover-tasks (shared Redis smoke)');

  // pipeline normal completion
  const pipelineTask = `qa-pipeline-${qa}`;
  const startedPipeline = ocr(['start-pipeline', '--task-id', pipelineTask, '--template', 'documentation', '--context', JSON.stringify({ qa })]).json;
  created.pipelineIds.push(startedPipeline.pipeline_id);
  assert.equal(startedPipeline.current_agent, 'writer');
  const gp1 = ocr(['get-pipeline', '--pipeline-id', startedPipeline.pipeline_id]).json;
  assert.equal(gp1.state, 'active');
  ocr(['advance-pipeline', '--pipeline-id', startedPipeline.pipeline_id, '--result', JSON.stringify({ verdict: 'done', output: 'writer done' })]);
  ocr(['advance-pipeline', '--pipeline-id', startedPipeline.pipeline_id, '--result', JSON.stringify({ verdict: 'done', output: 'fact-checker done' })]);
  const endPipeline = ocr(['advance-pipeline', '--pipeline-id', startedPipeline.pipeline_id, '--result', JSON.stringify({ verdict: 'done', output: 'reviewer done' })]).json;
  assert.equal(endPipeline.state, 'completed');
  assert.equal(exists(`openclaw:pipeline:${startedPipeline.pipeline_id}`), true);
  assert.equal(exists(`openclaw:pipeline:by-task:${pipelineTask}`), false);
  const completedPipeline = ocr(['get-pipeline', '--pipeline-id', startedPipeline.pipeline_id]).json;
  assert.equal(completedPipeline.state, 'completed');
  summary.checks.push('pipeline: normal completion retention + mapping cleanup');

  // pipeline loop/escalation
  const loopPipelineTask = `qa-code-review-${qa}`;
  const startedLoopPipeline = ocr(['start-pipeline', '--task-id', loopPipelineTask, '--template', 'code_review']).json;
  created.pipelineIds.push(startedLoopPipeline.pipeline_id);
  const adv1 = ocr(['advance-pipeline', '--pipeline-id', startedLoopPipeline.pipeline_id, '--result', JSON.stringify({ verdict: 'fail', output: 'review issues' })]).json;
  assert.equal(adv1.action, 'loop_back');
  const adv2 = ocr(['advance-pipeline', '--pipeline-id', startedLoopPipeline.pipeline_id, '--result', JSON.stringify({ verdict: 'fail', output: 'still issues' })]).json;
  assert.equal(adv2.state, 'escalated');
  assert.equal(exists(`openclaw:pipeline:${startedLoopPipeline.pipeline_id}`), true);
  assert.equal(exists(`openclaw:pipeline:by-task:${loopPipelineTask}`), false);
  const escalatedPipeline = ocr(['get-pipeline', '--pipeline-id', startedLoopPipeline.pipeline_id]).json;
  assert.equal(escalatedPipeline.state, 'escalated');
  summary.checks.push('pipeline: loop escalation retention + mapping cleanup');

  // feedback loop pass + escalation
  const fl1 = ocr(['start-loop', '--type', 'code-test', '--task-id', `qa-fl-pass-${qa}`, '--initiator', 'coder', '--target', 'tester', '--context', JSON.stringify({ qa })]).json;
  created.loopIds.push(fl1.loop_id);
  const fl1Status = ocr(['loop-status', '--loop-id', fl1.loop_id]).json;
  assert.equal(fl1Status.state, 'active');
  const fl1Done = ocr(['loop-result', '--loop-id', fl1.loop_id, '--agent', 'tester', '--verdict', 'pass', '--details', JSON.stringify({ qa, ok: true })]).json;
  assert.equal(fl1Done.state, 'completed');
  assert.equal(exists(`openclaw:feedback-loop:${fl1.loop_id}`), true);
  const fl1Completed = ocr(['loop-status', '--loop-id', fl1.loop_id]).json;
  assert.equal(fl1Completed.state, 'completed');

  const fl2 = ocr(['start-loop', '--type', 'code-review', '--task-id', `qa-fl-escalate-${qa}`, '--initiator', 'coder', '--target', 'reviewer']).json;
  created.loopIds.push(fl2.loop_id);
  const fl2a = ocr(['loop-result', '--loop-id', fl2.loop_id, '--agent', 'reviewer', '--verdict', 'fail', '--details', JSON.stringify({ qa, round: 1 })]).json;
  assert.equal(fl2a.iteration, 2);
  const fl2b = ocr(['loop-result', '--loop-id', fl2.loop_id, '--agent', 'coder', '--verdict', 'fix', '--details', JSON.stringify({ qa, fixed: true })]).json;
  assert.equal(fl2b.state, 'active');
  const fl2c = ocr(['loop-result', '--loop-id', fl2.loop_id, '--agent', 'reviewer', '--verdict', 'fail', '--details', JSON.stringify({ qa, round: 2 })]).json;
  assert.equal(fl2c.state, 'escalated');
  assert.equal(exists(`openclaw:feedback-loop:${fl2.loop_id}`), true);
  const fl2Escalated = ocr(['loop-status', '--loop-id', fl2.loop_id]).json;
  assert.equal(fl2Escalated.state, 'escalated');
  summary.checks.push('feedback loops retention');

  // roundtable + auto cleanup
  const rt = ocr(['roundtable-create', '--topic', `QA smoke ${qa}`, '--participants', 'coder,tester']).json;
  created.roundtableIds.push(rt.rt_id);
  const rtRead0 = ocr(['roundtable-read', rt.rt_id]).json;
  assert.equal(rtRead0.ok, true);
  ocr(['roundtable-contribute', rt.rt_id, '--agent', 'coder', '--round', '1', '--summary', `coder says ${qa}`, '--agrees_with', 'none']);
  const tally1 = ocr(['roundtable-tally', rt.rt_id]).json;
  assert.equal(tally1.ok, true);
  ocr(['roundtable-contribute', rt.rt_id, '--agent', 'tester', '--round', '1', '--summary', `tester says ${qa}`, '--disagrees_with', 'coder']);
  assert.equal(exists(`openclaw:roundtable:${rt.rt_id}`), false);
  assert.equal(exists(`openclaw:roundtable:${rt.rt_id}:rounds`), false);
  summary.checks.push('roundtable auto-cleanup');

  // bugs workflow
  const bug = ocr(['bug-report', 'P2', `QA smoke bug ${qa}`, '--reporter', 'tester']).json;
  created.bugIds.push(bug.bug_id);
  const bugDetail = ocr(['bug-detail', bug.bug_id]).json;
  assert.equal(bugDetail.ok, true);
  assert.match(bugDetail.bug.description, new RegExp(qa));
  const bugAssign = ocr(['bug-assign', bug.bug_id, 'coder']).json;
  assert.equal(bugAssign.ok, true);
  const bugFixed = ocr(['bug-fix', bug.bug_id, '--comment', `fixed ${qa}`]).json;
  assert.equal(bugFixed.ok, true);
  const bugListFixed = ocr(['bug-list', '--status', 'fixed', '--reporter', 'tester']).json;
  assert.ok(bugListFixed.bugs.some(b => b.id === bug.bug_id));
  summary.checks.push('bugs');

  // ─── Task-Status v3 Contract Tests ──────────────────────────────────────────

  // 1. Idempotent create
  const tsTaskId = `ts-${qa}`;
  created.taskStatusIds.push(tsTaskId);
  const tsCreate1 = ocr([
    'task-status-create',
    '--task-id', tsTaskId,
    '--topic-id', '1',
    '--title', `QA task ${qa}`,
    '--agents', 'tester',
    '--run-id', tsTaskId,
    '--coordinator-id', 'teamlead',
    '--owner-id', 'coder',
  ]).json;
  assert.equal(tsCreate1.ok, true);
  assert.ok(tsCreate1.message_id, 'create should return message_id');
  created.messages.push({ chatId: tsCreate1.chat_id || '-1003891295903', messageId: tsCreate1.message_id });

  // Second create with same task_id → must return same message_id (idempotent)
  const tsCreate2 = ocr([
    'task-status-create',
    '--task-id', tsTaskId,
    '--topic-id', '1',
    '--title', `QA task ${qa} duplicate`,
    '--agents', 'tester',
    '--coordinator-id', 'teamlead',
  ]).json;
  assert.equal(tsCreate2.ok, true);
  assert.equal(tsCreate2.message_id, tsCreate1.message_id, 'idempotent create must return same message_id');
  assert.equal(tsCreate2.idempotent, true);
  summary.checks.push('task-status: idempotent create');

  // 2. Immutable binding: coordinator/owner unchanged after create
  const tsHash1 = hgetall(`openclaw:task-status:${tsTaskId}`);
  assert.equal(tsHash1.coordinator_id, 'teamlead');
  assert.equal(tsHash1.owner_id, 'coder');
  summary.checks.push('task-status: immutable binding');

  // 3. Agent join
  const joinResult = ocr(['task-status-join', '--task-id', tsTaskId, '--agent-id', 'coder']).json;
  assert.equal(joinResult.ok, true);
  assert.ok(joinResult.agents.includes('tester'));
  assert.ok(joinResult.agents.includes('coder'));

  // Duplicate join is safe (idempotent)
  const joinResult2 = ocr(['task-status-join', '--task-id', tsTaskId, '--agent-id', 'coder']).json;
  assert.equal(joinResult2.ok, true);
  const joinAgents = JSON.parse(hgetall(`openclaw:task-status:${tsTaskId}`).agents || '[]');
  assert.equal(joinAgents.filter(a => a === 'coder').length, 1, 'no duplicate agents after re-join');
  summary.checks.push('task-status: agent join');

  // 4. Join non-existent task
  const joinFail = ocr(['task-status-join', '--task-id', `ts-nonexistent-${qa}`, '--agent-id', 'coder'], { allowFailure: true }).json;
  assert.equal(joinFail.ok, false);
  assert.equal(joinFail.error, 'task_not_found');
  summary.checks.push('task-status: join non-existent fails');

  // 5. Unauthorized close (tester is not coordinator or owner)
  const closeDenied = ocr(['task-status-close', '--task-id', tsTaskId, '--result', 'success', '--actor-id', 'tester'], { allowFailure: true }).json;
  assert.equal(closeDenied.ok, false);
  assert.equal(closeDenied.error, 'not_closer');
  summary.checks.push('task-status: unauthorized close rejected');

  // 6. Close without actor-id → arg_error
  const closeNoActor = ocr(['task-status-close', '--task-id', tsTaskId, '--result', 'success'], { allowFailure: true });
  assert.notEqual(closeNoActor.code, 0, 'close without actor-id should fail');
  summary.checks.push('task-status: close requires actor-id');

  // 7. Manual update
  const manualUpdate = ocr(['task-status-update', '--task-id', tsTaskId]).json;
  assert.equal(manualUpdate.ok, true);
  summary.checks.push('task-status: manual update');

  // 8. Authorized close (teamlead is coordinator)
  const closeOk = ocr(['task-status-close', '--task-id', tsTaskId, '--result', 'success', '--actor-id', 'teamlead']).json;
  assert.equal(closeOk.ok, true);
  const tsClosedHash = hgetall(`openclaw:task-status:${tsTaskId}`);
  assert.equal(tsClosedHash.status, 'completed');
  assert.equal(tsClosedHash.closed_by, 'teamlead');
  assert.ok(!smembers('openclaw:task-status:active').includes(tsTaskId));
  summary.checks.push('task-status: authorized close');

  // 9. Join closed task → rejected
  const joinClosed = ocr(['task-status-join', '--task-id', tsTaskId, '--agent-id', 'reviewer'], { allowFailure: true }).json;
  assert.equal(joinClosed.ok, false);
  assert.equal(joinClosed.error, 'task_closed');
  summary.checks.push('task-status: join closed task fails');

  // 10. Watcher: append-only (no auto-create, auto-joins agents by run_id)
  const watcherTaskId = `ts-watcher-${qa}`;
  created.taskStatusIds.push(watcherTaskId);

  // Create task first (coordinator creates)
  const watcherCreate = ocr([
    'task-status-create',
    '--task-id', watcherTaskId,
    '--topic-id', '1',
    '--title', `Watcher test ${qa}`,
    '--agents', 'tester',
    '--coordinator-id', 'teamlead',
    '--owner-id', 'teamlead',
  ]).json;
  assert.equal(watcherCreate.ok, true);
  created.messages.push({ chatId: watcherCreate.chat_id || '-1003891295903', messageId: watcherCreate.message_id });

  const watcherProc = spawn('node', [OCR_BIN.pathname, 'daemon', 'task-status'], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let watcherLogs = '';
  watcherProc.stdout.on('data', (chunk) => { watcherLogs += String(chunk); });
  watcherProc.stderr.on('data', (chunk) => { watcherLogs += String(chunk); });
  let watcherStopped = false;
  const stopWatcher = async () => {
    if (watcherStopped) return;
    watcherStopped = true;
    watcherProc.kill('SIGTERM');
    await new Promise((resolve) => watcherProc.once('close', resolve));
  };

  try {
    await sleep(1500);

    // Agent reports status with run_id matching the task → watcher should auto-join
    ocr(['set-status', 'coder', JSON.stringify({ state: 'working', step: `watcher join ${qa}`, progress: 20, run_id: watcherTaskId })]);

    let watcherAgents = [];
    for (let i = 0; i < 15; i++) {
      await sleep(500);
      const wHash = hgetall(`openclaw:task-status:${watcherTaskId}`);
      watcherAgents = JSON.parse(wHash.agents || '[]');
      if (watcherAgents.includes('coder')) break;
    }
    assert.ok(watcherAgents.includes('tester'), 'original agent still present');
    assert.ok(watcherAgents.includes('coder'), 'watcher auto-joined coder by run_id');

    // Watcher must NOT create messages for unknown run_ids
    const unknownTaskId = `ts-unknown-${qa}`;
    created.taskStatusIds.push(unknownTaskId);
    ocr(['set-status', 'reviewer', JSON.stringify({ state: 'working', step: `unknown ${qa}`, progress: 5, run_id: unknownTaskId })]);
    await sleep(3000);
    const unknownHash = hgetall(`openclaw:task-status:${unknownTaskId}`);
    assert.ok(!unknownHash.message_id, 'watcher must NOT auto-create for unknown task');

    // Status query still works
    const statusQuery = ocr(['status-query', 'tester']).json;
    assert.equal(statusQuery.ok, true);
  } finally {
    await stopWatcher();
  }

  // Close watcher test task
  ocr(['task-status-close', '--task-id', watcherTaskId, '--result', 'success', '--actor-id', 'teamlead']);
  summary.checks.push('task-status: watcher append-only + no auto-create');

  // gc stale/orphan cleanup
  const oldIso = '2000-01-01T00:00:00.000Z';
  const oldPipelineId = `p-${Date.now() - 999999999999}-gc`;
  const oldLoopId = `fl-${Date.now() - 999999999999}-gc`;
  const oldRtId = `rt-${Date.now() - 999999999999}-gc`;
  const oldTaskId = `t-${Date.now() - 999999999999}-gc`;
  const oldTsId = `ts-gc-${qa}`;
  const orphanRounds = `openclaw:roundtable:rt-orphan-${qa}:rounds`;
  created.extraKeys.push(
    `openclaw:pipeline:${oldPipelineId}`,
    `openclaw:pipeline:by-task:qa-old-${qa}`,
    `openclaw:feedback-loop:${oldLoopId}`,
    `openclaw:tasks:result:${oldTaskId}`,
    `openclaw:roundtable:${oldRtId}`,
    `openclaw:roundtable:${oldRtId}:rounds`,
    orphanRounds,
    `openclaw:task-status:${oldTsId}`,
  );
  redisCli(['HSET', `openclaw:pipeline:${oldPipelineId}`, 'state', 'active', 'created_at', oldIso]);
  redisCli(['SET', `openclaw:pipeline:by-task:qa-old-${qa}`, oldPipelineId]);
  redisCli(['HSET', `openclaw:feedback-loop:${oldLoopId}`, 'state', 'active', 'created_at', oldIso]);
  redisCli(['HSET', `openclaw:tasks:result:${oldTaskId}`, 'status', 'done', 'created_at', oldIso]);
  redisCli(['HSET', `openclaw:roundtable:${oldRtId}`, 'status', 'active', 'created_at', oldIso]);
  redisCli(['XADD', `openclaw:roundtable:${oldRtId}:rounds`, '*', 'agent', 'tester', 'round', '1', 'summary', 'old']);
  redisCli(['XADD', orphanRounds, '*', 'agent', 'tester', 'round', '1', 'summary', 'orphan']);
  redisCli(['HSET', `openclaw:task-status:${oldTsId}`, 'status', 'running', 'created_at', oldIso]);
  const gcDry = ocr(['gc', '--dry-run']).json;
  assert.equal(gcDry.ok, true);
  const gcReal = ocr(['gc']).json;
  assert.equal(gcReal.ok, true);
  assert.equal(exists(`openclaw:pipeline:${oldPipelineId}`), false);
  assert.equal(exists(`openclaw:pipeline:by-task:qa-old-${qa}`), false);
  assert.equal(exists(`openclaw:feedback-loop:${oldLoopId}`), false);
  assert.equal(exists(`openclaw:tasks:result:${oldTaskId}`), false);
  assert.equal(exists(`openclaw:roundtable:${oldRtId}`), false);
  assert.equal(exists(`openclaw:roundtable:${oldRtId}:rounds`), false);
  assert.equal(exists(orphanRounds), false);
  assert.equal(exists(`openclaw:task-status:${oldTsId}`), false);
  summary.checks.push('gc');

  // basic redis hygiene assertions for created runtime keys
  assert.ok(ttl(`openclaw:tasks:result:${pushed1.task_id}`) > 0);
  assert.ok(ttl(`openclaw:tasks:result:${pushed2.task_id}`) > 0);
  summary.checks.push('ttl sanity');

  console.log(JSON.stringify({ ok: true, summary }, null, 2));
}

try {
  await main();
} finally {
  for (const bugId of created.bugIds) {
    del(`openclaw:bugs:${bugId}`);
    redisCli(['ZREM', 'openclaw:bugs:open', bugId]);
    redisCli(['ZREM', 'openclaw:bugs:fixed', bugId]);
    redisCli(['ZREM', 'openclaw:bugs:wontfix', bugId]);
  }
  for (const taskId of created.taskIds) {
    del(`openclaw:tasks:result:${taskId}`, `openclaw:locks:task:${taskId}`);
  }
  for (const pipelineId of created.pipelineIds) {
    del(`openclaw:pipeline:${pipelineId}`);
  }
  for (const loopId of created.loopIds) {
    del(`openclaw:feedback-loop:${loopId}`);
    redisCli(['SREM', 'openclaw:feedback-loops:active', loopId]);
  }
  for (const rtId of created.roundtableIds) {
    del(`openclaw:roundtable:${rtId}`, `openclaw:roundtable:${rtId}:rounds`);
  }
  for (const taskId of created.taskStatusIds) {
    redisCli(['SREM', 'openclaw:task-status:active', taskId]);
    del(`openclaw:task-status:${taskId}`);
  }
  for (const key of created.extraKeys) del(key);
  del('openclaw:agents:status:tester', 'openclaw:agents:status:coder', 'openclaw:agents:status:reviewer');
  del('openclaw:heartbeat:tester', 'openclaw:heartbeat:coder', 'openclaw:heartbeat:reviewer');
  for (const msg of created.messages) {
    try { await deleteTelegramMessage(msg.chatId, msg.messageId); } catch {}
  }
}
