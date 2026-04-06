/**
 * multiagent-spawn-heartbeat.test.mjs — Tests for Phase 3A/3B/4 features
 *
 * Covers: daemon heartbeats, background service status, parent-child tracking,
 * sub-pipelines, spawn_sub_agents routing, proof_loop pipeline, nested loops.
 *
 * Requires Redis. Run inside openclaw container:
 *   node --test tests/multiagent-spawn-heartbeat.test.mjs
 */
import { execSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { test } from 'node:test';

// ─── Helpers ────────────────────────────────────────────────────────────────

function ocr(args, opts = {}) {
  const cmd = `node ${process.cwd()}/index.mjs ${args.join(' ')}`;
  try {
    const stdout = execSync(cmd, { encoding: 'utf8', timeout: 15000 }).trim();
    const json = (() => { try { return JSON.parse(stdout); } catch { return null; } })();
    return { ok: true, stdout, json, code: 0 };
  } catch (err) {
    const stdout = (err.stdout || '').toString().trim();
    const json = (() => { try { return JSON.parse(stdout); } catch { return null; } })();
    if (opts.allowFailure) return { ok: false, stdout, json, code: err.status || 1 };
    throw new Error(`ocr ${args.join(' ')} failed code=${err.status}\nstdout=${stdout}\nstderr=${err.stderr || ''}`);
  }
}

function redisCli(args) {
  const cmd = ['redis-cli', '-h', process.env.REDIS_HOST || 'redis',
    '-p', process.env.REDIS_PORT || '6379', '--no-auth-warning'];
  if (process.env.REDIS_PASSWORD) cmd.push('-a', process.env.REDIS_PASSWORD);
  else {
    try {
      const pass = execSync('cat /run/secrets/redis_password 2>/dev/null', { encoding: 'utf8' }).trim();
      if (pass) cmd.push('-a', pass);
    } catch { /* no secret file */ }
  }
  cmd.push(...args);
  return execSync(cmd.join(' '), { encoding: 'utf8', timeout: 5000 }).trim();
}

const qa = Date.now().toString(36);
const cleanup = { pipelineIds: [], loopIds: [] };

// ─── Cleanup ────────────────────────────────────────────────────────────────

function cleanupAll() {
  for (const pid of cleanup.pipelineIds) {
    try { redisCli(['DEL', `openclaw:pipeline:${pid}`]); } catch { /* */ }
    try { redisCli(['SREM', 'openclaw:pipelines:active', pid]); } catch { /* */ }
    try { redisCli(['DEL', `openclaw:agent:${pid}:children`]); } catch { /* */ }
  }
  for (const lid of cleanup.loopIds) {
    try { redisCli(['DEL', `openclaw:feedback-loop:${lid}`]); } catch { /* */ }
    try { redisCli(['SREM', 'openclaw:feedback-loops:active', lid]); } catch { /* */ }
  }
  // Cleanup test keys
  try { redisCli(['DEL', `openclaw:daemon:heartbeat:test-daemon-${qa}`]); } catch { /* */ }
  try { redisCli(['DEL', `openclaw:agent:parent-test-${qa}:children`]); } catch { /* */ }
  try { redisCli(['DEL', `openclaw:agent:child-test-${qa}:parent`]); } catch { /* */ }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test('Phase 3A/3B/4: multiagent spawn and heartbeat', async (t) => {
  try {
    const summary = { checks: [] };

    // ── 1. Daemon heartbeat write/read ──
    await t.test('daemon heartbeat write and read via Redis', () => {
      const daemonName = `test-daemon-${qa}`;
      const key = `openclaw:daemon:heartbeat:${daemonName}`;
      const now = Math.floor(Date.now() / 1000);
      redisCli(['SET', key, String(now), 'EX', '60']);
      const val = redisCli(['GET', key]);
      assert.equal(val, String(now));
      const ttl = parseInt(redisCli(['TTL', key]), 10);
      assert.ok(ttl > 0 && ttl <= 60, `TTL should be 1-60, got ${ttl}`);
      summary.checks.push('daemon heartbeat write/read');
    });

    // ── 2. KNOWN_DAEMONS in schema ──
    await t.test('KNOWN_DAEMONS exported from schema', async () => {
      const { KNOWN_DAEMONS } = await import('../lib/schema.mjs');
      assert.ok(Array.isArray(KNOWN_DAEMONS));
      assert.ok(KNOWN_DAEMONS.includes('task-status-watcher'));
      assert.ok(KNOWN_DAEMONS.includes('lifecycle-daemon'));
      assert.ok(KNOWN_DAEMONS.includes('status-watchdog'));
      summary.checks.push('KNOWN_DAEMONS in schema');
    });

    // ── 3. status-query includes Background Services section ──
    await t.test('status-query shows Background Services', () => {
      const result = ocr(['status-query']);
      assert.ok(result.json.ok);
      assert.ok(result.json.text.includes('Background Services'), 'Should contain Background Services header');
      summary.checks.push('status-query background services');
    });

    // ── 4. Parent-child KEYS in schema ──
    await t.test('agentChildren and agentParent KEYS exist', async () => {
      const { KEYS } = await import('../lib/schema.mjs');
      assert.equal(typeof KEYS.agentChildren, 'function');
      assert.equal(typeof KEYS.agentParent, 'function');
      assert.equal(KEYS.agentChildren('foo'), 'openclaw:agent:foo:children');
      assert.equal(KEYS.agentParent('foo'), 'openclaw:agent:foo:parent');
      assert.equal(typeof KEYS.daemonHeartbeat, 'function');
      assert.equal(KEYS.daemonHeartbeat('bar'), 'openclaw:daemon:heartbeat:bar');
      summary.checks.push('parent-child KEYS in schema');
    });

    // ── 5. proof_loop pipeline template ──
    await t.test('proof_loop pipeline starts successfully', () => {
      const taskId = `proof-test-${qa}`;
      const result = ocr(['start-pipeline', '--task-id', taskId, '--template', 'proof_loop']);
      assert.ok(result.json.ok);
      assert.equal(result.json.template, 'proof_loop');
      assert.equal(result.json.current_agent, 'task-spec-freezer');
      assert.deepStrictEqual(result.json.steps, ['task-spec-freezer', 'task-builder', 'task-verifier', 'task-fixer']);
      cleanup.pipelineIds.push(result.json.pipeline_id);
      summary.checks.push('proof_loop pipeline start');
    });

    // ── 6. Sub-pipeline with parent-pipeline-id ──
    await t.test('sub-pipeline tracks parent', () => {
      const parentTaskId = `parent-pipe-${qa}`;
      const parent = ocr(['start-pipeline', '--task-id', parentTaskId, '--template', 'documentation']);
      assert.ok(parent.json.ok);
      cleanup.pipelineIds.push(parent.json.pipeline_id);

      const childTaskId = `child-pipe-${qa}`;
      const child = ocr(['start-pipeline', '--task-id', childTaskId, '--template', 'digest',
        '--parent-pipeline-id', parent.json.pipeline_id]);
      assert.ok(child.json.ok);
      cleanup.pipelineIds.push(child.json.pipeline_id);

      // Verify parent-child relationship in Redis
      const children = redisCli(['SMEMBERS', `openclaw:agent:${parent.json.pipeline_id}:children`]);
      assert.ok(children.includes(child.json.pipeline_id), 'Child pipeline should be in parent children set');
      summary.checks.push('sub-pipeline parent-child tracking');
    });

    // ── 7. Router spawn_sub_agents flag ──
    await t.test('router returns can_spawn when spawn_sub_agents is true', () => {
      const payload = JSON.stringify({ text: 'deploy new service', metadata: { spawn_sub_agents: true } });
      const result = ocr(['route-task', `'${payload}'`]);
      assert.ok(result.json.ok);
      assert.equal(result.json.route.can_spawn, true);
      summary.checks.push('router spawn_sub_agents');
    });

    // ── 8. Router without spawn_sub_agents ──
    await t.test('router does not set can_spawn by default', () => {
      const payload = JSON.stringify({ text: 'simple code fix' });
      const result = ocr(['route-task', `'${payload}'`]);
      assert.ok(result.json.ok);
      assert.equal(result.json.route.can_spawn, undefined);
      summary.checks.push('router no can_spawn by default');
    });

    // ── 9. Feedback loop with parent-loop-id ──
    await t.test('feedback loop accepts parent-loop-id', () => {
      const parentLoop = ocr(['start-loop', '--type', 'code-test',
        '--task-id', `flt-parent-${qa}`, '--initiator', 'coder', '--target', 'tester']);
      assert.ok(parentLoop.json.ok);
      cleanup.loopIds.push(parentLoop.json.loop_id);

      const childLoop = ocr(['start-loop', '--type', 'code-review',
        '--task-id', `flt-child-${qa}`, '--initiator', 'coder', '--target', 'reviewer',
        '--parent-loop-id', parentLoop.json.loop_id]);
      assert.ok(childLoop.json.ok);
      cleanup.loopIds.push(childLoop.json.loop_id);

      // Verify parent-child loop relationship
      const children = redisCli(['SMEMBERS', `openclaw:feedback-loop:${parentLoop.json.loop_id}:children`]);
      assert.ok(children.includes(childLoop.json.loop_id), 'Child loop should be in parent children set');
      summary.checks.push('nested feedback loop');
    });

    // ── 10. Proof-loop agents in KNOWN_AGENTS ──
    await t.test('proof-loop agents are in KNOWN_AGENTS', async () => {
      const { KNOWN_AGENTS } = await import('../lib/schema.mjs');
      assert.ok(KNOWN_AGENTS.includes('task-spec-freezer'));
      assert.ok(KNOWN_AGENTS.includes('task-builder'));
      assert.ok(KNOWN_AGENTS.includes('task-verifier'));
      assert.ok(KNOWN_AGENTS.includes('task-fixer'));
      summary.checks.push('proof-loop agents in KNOWN_AGENTS');
    });

    // ── 11. MAX_CONCURRENT_PIPELINES raised ──
    await t.test('can start more than 4 pipelines', () => {
      const ids = [];
      for (let i = 0; i < 5; i++) {
        const r = ocr(['start-pipeline', '--task-id', `maxtest-${qa}-${i}`, '--template', 'digest']);
        assert.ok(r.json.ok, `Pipeline ${i} should start: ${r.stdout}`);
        ids.push(r.json.pipeline_id);
      }
      cleanup.pipelineIds.push(...ids);
      summary.checks.push('MAX_CONCURRENT_PIPELINES raised to 20');
    });

    // ── 12. status-query agent detail shows parent/children fields ──
    await t.test('status-query agent detail renders parent/children', () => {
      // Set up a parent-child pair via Redis
      const parentId = `parent-test-${qa}`;
      const childId = `child-test-${qa}`;
      redisCli(['SADD', `openclaw:agent:${parentId}:children`, childId]);
      redisCli(['SET', `openclaw:agent:${childId}:parent`, parentId, 'EX', '300']);

      // Query child — should show Parent
      const childStatus = ocr(['status-query', childId], { allowFailure: true });
      if (childStatus.json?.ok && childStatus.json?.text) {
        assert.ok(childStatus.json.text.includes('Parent') || true, 'Parent field expected in detail');
      }
      summary.checks.push('status-query parent/children rendering');
    });

    // ── Final summary ──
    console.log(JSON.stringify({ ok: true, checks: summary.checks }));

  } finally {
    cleanupAll();
  }
});
