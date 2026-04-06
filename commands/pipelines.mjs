/**
 * commands/pipelines.mjs — Multi-step pipeline orchestration
 *
 * Pipelines are ordered sequences of agent steps for task completion.
 * Some pipelines have feedback loops (e.g., code_review: coder ↔ reviewer).
 *
 * Redis keys:
 *   openclaw:pipeline:<pipeline-id>        — Hash with pipeline state
 *   openclaw:pipelines:active              — Set of active pipeline IDs
 *   openclaw:pipeline:by-task:<task-id>    — pipeline-id lookup
 *
 * Commands:
 *   ocr start-pipeline --task-id <id> --template <name> [--context <json>]
 *   ocr advance-pipeline --pipeline-id <id> --result <json>
 *   ocr get-pipeline --pipeline-id <id>
 *   ocr list-pipelines [--status active|completed|escalated] [--limit N]
 */
import { withRetry } from '../lib/retry.mjs';
import { redis, redisRaw, parseJson, parseHgetall, withLock } from '../lib/redis.mjs';
import { KEYS, genPipelineId, now } from '../lib/schema.mjs';
import { output, argError } from '../lib/errors.mjs';
import { resolveCoordinatorBindings } from '../lib/coordinator-bindings.mjs';
import { ensureTaskStatusTracker } from './task-status.mjs';

// ─── Pipeline Templates ──────────────────────────────────────────────────────

const PIPELINE_TEMPLATES = {
  feature_delivery:  { steps: ['planner', 'coder', 'tester', 'reviewer', 'planner'] },
  incident_response: { steps: ['monitor', 'devops', 'coder', 'tester', 'planner'] },
  security_fix:      { steps: ['devops', 'coder', 'tester', 'reviewer', 'planner'] },
  research_to_build: { steps: ['ai-researcher', 'coder', 'tester', 'planner'] },
  documentation:     { steps: ['writer', 'fact-checker', 'reviewer'] },
  digest:            { steps: ['flash', 'writer'] },
  health_check:      { steps: ['health', 'fact-checker'] },
  code_review:       { steps: ['coder', 'reviewer'], loop: { pairs: ['coder,reviewer'], max: 2 } },
  proof_loop:        { steps: ['task-spec-freezer', 'task-builder', 'task-verifier', 'task-fixer'], loop: { pairs: ['task-fixer,task-verifier'], max: 3 } },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key.startsWith('--') && args[i + 1] !== undefined) {
      parsed[key.slice(2)] = args[i + 1];
      i++;
    }
  }
  return parsed;
}

/**
 * Emit an event to the events stream.
 */
async function emitEvent(eventType, data) {
  await withRetry(() => {
    redis('XADD', KEYS.eventsStream, 'MAXLEN', '~', '10000', '*',
      'type', eventType,
      'timestamp', now(),
      'agent', data.agent || 'system',
      'data', JSON.stringify(data),
    );
  });
}

/**
 * Find the loop partner for a given agent in a pipeline with loops.
 */
function findLoopPartner(agent, loop) {
  if (!loop || !loop.pairs) return null;
  for (const pair of loop.pairs) {
    const [a, b] = pair.split(',');
    if (a === agent) return b;
    if (b === agent) return a;
  }
  return null;
}

async function finalizePipeline(pipelineId, pl, patch = {}) {
  const pipelineKey = KEYS.pipeline(pipelineId);
  const ts = new Date().toISOString();
  await withRetry(() => {
    redis('SREM', KEYS.pipelinesActive, pipelineId);
    const fields = ['updated_at', ts];
    for (const [key, value] of Object.entries(patch)) {
      fields.push(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    redis('HSET', pipelineKey, ...fields);
    redis('EXPIRE', pipelineKey, '3600'); // short TTL on close (1h)
    try { redis('DEL', KEYS.pipelineByTask(pl.task_id)); } catch { /* best effort */ }
    return true;
  });
}

// ─── Commands ────────────────────────────────────────────────────────────────

/**
 * ocr start-pipeline --task-id <id> --template <template> [--context <json>]
 */
export async function cmdStartPipeline(args) {
  const p = parseArgs(args);

  if (!p['task-id']) throw argError('start-pipeline requires --task-id');
  if (!p.template)   throw argError('start-pipeline requires --template');

  const template = PIPELINE_TEMPLATES[p.template];
  if (!template) {
    throw argError(`start-pipeline: unknown template "${p.template}". Valid: ${Object.keys(PIPELINE_TEMPLATES).join(', ')}`);
  }

  const context = p.context ? parseJson(p.context, null) : {};
  if (p.context && context === null) {
    throw argError('start-pipeline: invalid JSON in --context');
  }
  const bindings = resolveCoordinatorBindings({
    coordinator_id: p['coordinator-id'] || p.coordinator_id || p.coordinator,
    owner_id: p['owner-id'] || p.owner_id || p.owner,
    close_owner_id: p['close-owner-id'] || p.close_owner_id || p.close_owner,
    creator_id: p['creator-id'] || p.creator_id || p.creator,
  });

  // Enforce maxConcurrent pipelines
  const MAX_CONCURRENT_PIPELINES = 20;
  const activeCount = await withRetry(() => {
    const count = redis('SCARD', KEYS.pipelinesActive);
    return parseInt(count, 10) || 0;
  });

  if (activeCount >= MAX_CONCURRENT_PIPELINES) {
    output({ ok: false, error: `max concurrent pipelines reached (${MAX_CONCURRENT_PIPELINES}). Complete or cancel existing pipelines first.`, active: activeCount });
    return;
  }

  const parentPipelineId = p['parent-pipeline-id'] || null;

  const pipelineId = genPipelineId();
  const pipelineKey = KEYS.pipeline(pipelineId);
  const ts = new Date().toISOString();

  const pipelineData = {
    template: p.template,
    task_id: p['task-id'],
    steps: JSON.stringify(template.steps),
    current_step: '0',
    state: 'active',
    loop: template.loop ? JSON.stringify(template.loop) : '',
    loop_iterations: '0',
    context: JSON.stringify(context),
    history: JSON.stringify([]),
    created_at: ts,
    updated_at: ts,
  };

  if (parentPipelineId) {
    pipelineData.parent_pipeline_id = parentPipelineId;
  }

  await withRetry(() => {
    const hsetArgs = [];
    for (const [k, v] of Object.entries(pipelineData)) {
      hsetArgs.push(k, v);
    }
    redis('HSET', pipelineKey, ...hsetArgs);
    redis('EXPIRE', pipelineKey, '86400'); // 24h TTL as safety net
  });

  // Track parent-child pipeline relationship
  if (parentPipelineId) {
    try {
      redis('SADD', KEYS.agentChildren(parentPipelineId), pipelineId);
    } catch { /* best effort */ }
  }

  // Add to active set
  await withRetry(() => {
    redis('SADD', KEYS.pipelinesActive, pipelineId);
  });

  // Link task → pipeline
  await withRetry(() => {
    redis('SET', KEYS.pipelineByTask(p['task-id']), pipelineId, 'EX', '604800'); // 7 day TTL
  });

  // Emit event
  await emitEvent('pipeline_started', {
    agent: 'system',
    pipeline_id: pipelineId,
    template: p.template,
    task_id: p['task-id'],
    steps: template.steps,
    first_agent: template.steps[0],
  });

  // Auto-create task-status tracker for visibility
  const topicId = p['topic-id'] || '1';
  const title = p.title || `Pipeline: ${p.template} (${p['task-id']})`;
  let trackerResult = null;
  try {
    trackerResult = await ensureTaskStatusTracker(p['task-id'], {
      title,
      topic_id: topicId,
      chat_id: p['chat-id'] || p.chat_id,
      run_id: p['task-id'],
      coordinator_id: bindings.coordinator_id,
      owner_id: bindings.owner_id,
      close_owner_id: bindings.close_owner_id,
      creator_id: bindings.creator_id,
      agent_id: template.steps[0],
    });
    // Bootstrap statuses for all pipeline agents
    for (const agent of template.steps) {
      const { ensureBootstrappedAgentStatus } = await import('./task-status.mjs');
      ensureBootstrappedAgentStatus(agent, {
        task_id: p['task-id'],
        run_id: p['task-id'],
        state: agent === template.steps[0] ? 'queued' : 'idle',
        step: agent === template.steps[0] ? 'next up' : 'waiting',
      });
    }
  } catch (err) {
    process.stderr.write(`[ocr warn] auto-tracker for pipeline ${pipelineId} failed: ${err.message}\n`);
  }

  output({
    ok: true,
    pipeline_id: pipelineId,
    template: p.template,
    task_id: p['task-id'],
    state: 'active',
    steps: template.steps,
    current_step: 0,
    current_agent: template.steps[0],
    tracker: trackerResult ? { ok: trackerResult.ok, message_id: trackerResult.message_id } : null,
    message: `Pipeline started. ${template.steps[0]} should act first.`,
  });
}

/**
 * ocr advance-pipeline --pipeline-id <id> --result <json>
 *
 * Result JSON: { "verdict": "done|fail", "output": "...", "agent": "..." }
 */
export async function cmdAdvancePipeline(args) {
  const p = parseArgs(args);

  if (!p['pipeline-id']) throw argError('advance-pipeline requires --pipeline-id');
  if (!p.result)         throw argError('advance-pipeline requires --result <json>');

  const result = parseJson(p.result, null);
  if (!result) throw argError('advance-pipeline: invalid JSON in --result');

  const pipelineId = p['pipeline-id'];
  const pipelineKey = KEYS.pipeline(pipelineId);
  const lockKey = `openclaw:locks:pipeline:${pipelineId}`;

  await withLock(lockKey, async () => {

  // Fetch pipeline state
  const raw = await withRetry(() => redisRaw(['HGETALL', pipelineKey]));
  const pl = parseHgetall(raw);

  if (!pl.state) {
    output({ ok: false, error: 'not_found', message: `Pipeline ${pipelineId} not found` }, 1);
    return;
  }

  if (pl.state !== 'active') {
    output({ ok: false, error: 'invalid_state', message: `Pipeline ${p['pipeline-id']} is ${pl.state}, not active` }, 1);
    return;
  }

  const steps = parseJson(pl.steps, []);
  const currentStep = parseInt(pl.current_step, 10);
  const loop = pl.loop ? parseJson(pl.loop, null) : null;
  let loopIterations = parseInt(pl.loop_iterations, 10) || 0;
  const history = parseJson(pl.history, []);
  const ts = new Date().toISOString();

  const currentAgent = steps[currentStep];
  const verdict = result.verdict || 'done';

  // Record in history
  history.push({
    step: currentStep,
    agent: currentAgent,
    verdict,
    output: result.output || '',
    timestamp: ts,
  });

  // ── Handle sub-pipeline spawning (best effort) ──
  if (result.spawn_pipeline?.template) {
    try {
      const subTpl = PIPELINE_TEMPLATES[result.spawn_pipeline.template];
      if (subTpl) {
        const subId = genPipelineId();
        const subFields = ['template', result.spawn_pipeline.template, 'task_id', pl.task_id,
          'steps', JSON.stringify(subTpl.steps), 'current_step', '0', 'state', 'active',
          'loop', subTpl.loop ? JSON.stringify(subTpl.loop) : '', 'loop_iterations', '0',
          'context', JSON.stringify(result.spawn_pipeline.context || {}), 'history', '[]',
          'parent_pipeline_id', pipelineId, 'created_at', ts, 'updated_at', ts];
        redis('HSET', KEYS.pipeline(subId), ...subFields);
        redis('EXPIRE', KEYS.pipeline(subId), '86400');
        redis('SADD', KEYS.pipelinesActive, subId);
        redis('SADD', KEYS.agentChildren(pipelineId), subId);
      }
    } catch { /* best effort */ }
  }

  // ── Handle loop logic ──
  if (loop && verdict === 'fail') {
    const partner = findLoopPartner(currentAgent, loop);

    if (partner) {
      loopIterations++;

      if (loopIterations >= (loop.max || 2)) {
        // Max loop iterations — escalate, but keep terminal hash for inspection/GC
        await finalizePipeline(p['pipeline-id'], pl, {
          state: 'escalated',
          history,
          loop_iterations: String(loopIterations),
          escalated_at: ts,
          escalation_reason: 'loop_max_iterations',
        });

        await emitEvent('pipeline_escalated', {
          agent: currentAgent,
          pipeline_id: p['pipeline-id'],
          task_id: pl.task_id,
          reason: 'loop_max_iterations',
          loop_iterations: loopIterations,
        });

        output({
          ok: true,
          pipeline_id: p['pipeline-id'],
          action: 'escalated',
          state: 'escalated',
          reason: 'loop_max_iterations',
          loop_iterations: loopIterations,
          message: `Loop max iterations (${loop.max || 2}) reached. Escalating.`,
        });
        return;
      }

      // Go back to loop partner
      const partnerStep = steps.indexOf(partner);
      if (partnerStep === -1) {
        // Partner not in steps — shouldn't happen, escalate, but keep hash for debugging/GC
        await finalizePipeline(p['pipeline-id'], pl, {
          state: 'escalated',
          history,
          loop_iterations: String(loopIterations),
          escalated_at: ts,
          escalation_reason: 'loop_partner_not_found',
        });

        await emitEvent('pipeline_escalated', {
          agent: currentAgent,
          pipeline_id: p['pipeline-id'],
          task_id: pl.task_id,
          reason: 'loop_partner_not_found',
          loop_iterations: loopIterations,
        });

        output({
          ok: true,
          pipeline_id: p['pipeline-id'],
          action: 'escalated',
          state: 'escalated',
          reason: 'loop_partner_not_found',
          message: `Loop partner ${partner} not found in steps. Escalating.`,
        });
        return;
      }

      await withRetry(() => {
        redis('HSET', pipelineKey,
          'current_step', String(partnerStep),
          'loop_iterations', String(loopIterations),
          'history', JSON.stringify(history),
          'updated_at', ts,
        );
      });

      await emitEvent('pipeline_step_completed', {
        agent: currentAgent,
        pipeline_id: p['pipeline-id'],
        task_id: pl.task_id,
        step: currentStep,
        verdict,
        next_agent: partner,
        loop_iteration: loopIterations,
      });

      output({
        ok: true,
        pipeline_id: p['pipeline-id'],
        action: 'loop_back',
        state: 'active',
        current_step: partnerStep,
        current_agent: partner,
        loop_iterations: loopIterations,
        message: `Verdict: fail → looping back to ${partner} (iteration ${loopIterations}/${loop.max || 2}).`,
      });
      return;
    }
  }

  // ── Normal advance: next step ──
  const nextStep = currentStep + 1;

  if (nextStep >= steps.length) {
    // Pipeline completed: keep terminal state for get/list + later GC
    await finalizePipeline(p['pipeline-id'], pl, {
      state: 'completed',
      history,
      completed_at: ts,
      completed_by: currentAgent,
    });

    await emitEvent('pipeline_completed', {
      agent: currentAgent,
      pipeline_id: p['pipeline-id'],
      task_id: pl.task_id,
      template: pl.template,
      total_steps: steps.length,
    });

    output({
      ok: true,
      pipeline_id: p['pipeline-id'],
      action: 'completed',
      state: 'completed',
      total_steps: steps.length,
      message: 'Pipeline completed. All steps done.',
    });
    return;
  }

  // Advance to next step
  const nextAgent = steps[nextStep];

  await withRetry(() => {
    redis('HSET', pipelineKey,
      'current_step', String(nextStep),
      'history', JSON.stringify(history),
      'updated_at', ts,
    );
  });

  await emitEvent('pipeline_step_completed', {
    agent: currentAgent,
    pipeline_id: p['pipeline-id'],
    task_id: pl.task_id,
    step: currentStep,
    verdict,
    next_agent: nextAgent,
  });

  output({
    ok: true,
    pipeline_id: p['pipeline-id'],
    action: 'advance',
    state: 'active',
    current_step: nextStep,
    current_agent: nextAgent,
    previous_agent: currentAgent,
    message: `Step ${currentStep} (${currentAgent}) done → step ${nextStep} (${nextAgent}).`,
  });

  }); // end withLock
}

/**
 * ocr get-pipeline --pipeline-id <id>
 */
export async function cmdGetPipeline(args) {
  const p = parseArgs(args);

  if (!p['pipeline-id']) throw argError('get-pipeline requires --pipeline-id');

  const pipelineKey = KEYS.pipeline(p['pipeline-id']);
  const raw = await withRetry(() => redisRaw(['HGETALL', pipelineKey]));
  const pl = parseHgetall(raw);

  if (!pl.state) {
    output({ ok: false, error: 'not_found', message: `Pipeline ${p['pipeline-id']} not found` }, 1);
    return;
  }

  const steps = parseJson(pl.steps, []);
  const currentStep = parseInt(pl.current_step, 10);

  output({
    ok: true,
    pipeline_id: p['pipeline-id'],
    template: pl.template,
    task_id: pl.task_id,
    state: pl.state,
    steps,
    current_step: currentStep,
    current_agent: steps[currentStep] || null,
    loop: pl.loop ? parseJson(pl.loop, null) : null,
    loop_iterations: parseInt(pl.loop_iterations, 10) || 0,
    context: parseJson(pl.context, {}),
    history: parseJson(pl.history, []),
    created_at: pl.created_at,
    updated_at: pl.updated_at,
  });
}

/**
 * ocr list-pipelines [--status active|completed|escalated] [--limit N]
 */
export async function cmdListPipelines(args) {
  const p = parseArgs(args);
  const statusFilter = p.status || null;
  const limit = parseInt(p.limit, 10) || 20;

  // If filtering by active, use the set
  if (statusFilter === 'active') {
    const raw = await withRetry(() => redisRaw(['SMEMBERS', KEYS.pipelinesActive]));
    const trimmed = raw.trim();
    const ids = [];

    if (trimmed && trimmed !== '(empty array)' && trimmed !== '(nil)') {
      const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        const id = line.replace(/^\d+\)\s*/, '').replace(/^"(.*)"$/, '$1');
        if (id) ids.push(id);
      }
    }

    const pipelines = [];
    for (const id of ids.slice(0, limit)) {
      const plRaw = await withRetry(() => redisRaw(['HGETALL', KEYS.pipeline(id)]));
      const pl = parseHgetall(plRaw);
      if (pl.state) {
        const steps = parseJson(pl.steps, []);
        const currentStep = parseInt(pl.current_step, 10);
        pipelines.push({
          pipeline_id: id,
          template: pl.template,
          task_id: pl.task_id,
          state: pl.state,
          current_step: currentStep,
          current_agent: steps[currentStep] || null,
          steps,
          created_at: pl.created_at,
        });
      }
    }

    output({ ok: true, pipelines, count: pipelines.length });
    return;
  }

  // Scan for all pipeline keys
  const allKeys = [];
  let cursor = '0';

  do {
    const raw = await withRetry(() =>
      redisRaw(['SCAN', cursor, 'MATCH', 'openclaw:pipeline:p-*', 'COUNT', '100'])
    );
    const lines = raw.trim().split('\n').map(l => l.trim()).filter(Boolean);
    const cleaned = lines.map(l => l.replace(/^\d+\)\s*/, '').replace(/^"(.*)"$/, '$1'));
    cursor = cleaned[0] || '0';
    for (let i = 1; i < cleaned.length; i++) {
      if (cleaned[i] && cleaned[i] !== '(empty array)') {
        allKeys.push(cleaned[i]);
      }
    }
  } while (cursor !== '0');

  const pipelines = [];
  for (const key of allKeys) {
    if (pipelines.length >= limit) break;

    const raw = await withRetry(() => redisRaw(['HGETALL', key]));
    const pl = parseHgetall(raw);
    if (!pl.state) continue;

    if (statusFilter && pl.state !== statusFilter) continue;

    const pipelineId = key.replace('openclaw:pipeline:', '');
    const steps = parseJson(pl.steps, []);
    const currentStep = parseInt(pl.current_step, 10);

    pipelines.push({
      pipeline_id: pipelineId,
      template: pl.template,
      task_id: pl.task_id,
      state: pl.state,
      current_step: currentStep,
      current_agent: steps[currentStep] || null,
      steps,
      created_at: pl.created_at,
      updated_at: pl.updated_at,
    });
  }

  // Sort by created_at descending
  pipelines.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  output({ ok: true, pipelines, count: pipelines.length });
}
