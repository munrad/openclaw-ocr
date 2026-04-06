/**
 * commands/feedback-loop.mjs — Autonomous feedback loops between agents
 *
 * Loops:
 *   code-test   — coder → tester → (if bugs) → coder → tester
 *   code-review — coder → reviewer → (if issues) → coder → reviewer
 *   test-devops — tester → devops → (if infra fix) → tester
 *
 * Redis keys:
 *   openclaw:feedback-loop:<loop-id>   — Hash with loop data
 *   openclaw:feedback-loops:active     — Set of active loop IDs
 */
import { withRetry } from '../lib/retry.mjs';
import { redis, redisRaw, parseJson, parseHgetall, withLock } from '../lib/redis.mjs';
import { KEYS, genLoopId, now } from '../lib/schema.mjs';
import { output, argError } from '../lib/errors.mjs';
import { validateAgentId } from '../lib/known-agents.mjs';

const VALID_TYPES = ['code-test', 'code-review', 'test-devops'];
const VALID_VERDICTS = ['pass', 'fail', 'fix'];
const DEFAULT_MAX_ITERATIONS = 2;

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
 * Determine the next agent based on loop type and who just reported.
 * In a feedback loop, work alternates between initiator and target.
 */
function nextAgent(type, currentAgent, initiator, target) {
  return currentAgent === target ? initiator : target;
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

async function finalizeLoop(loopId, patch = {}) {
  const loopKey = KEYS.feedbackLoop(loopId);
  const ts = new Date().toISOString();
  await withRetry(() => {
    redis('SREM', KEYS.feedbackLoopsActive, loopId);
    const fields = ['updated_at', ts];
    for (const [key, value] of Object.entries(patch)) {
      fields.push(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    redis('HSET', loopKey, ...fields);
    redis('EXPIRE', loopKey, '43200');
    return true;
  });
}

// ─── Commands ────────────────────────────────────────────────────────────────

/**
 * ocr start-loop --type <type> --task-id <id> --initiator <agent> --target <agent> --context <json>
 */
export async function cmdStartLoop(args) {
  const p = parseArgs(args);

  if (!p.type)      throw argError('start-loop requires --type (code-test|code-review|test-devops)');
  if (!p['task-id']) throw argError('start-loop requires --task-id');
  if (!p.initiator) throw argError('start-loop requires --initiator');
  if (!p.target)    throw argError('start-loop requires --target');

  if (!VALID_TYPES.includes(p.type)) {
    throw argError(`start-loop: invalid type "${p.type}". Valid: ${VALID_TYPES.join(', ')}`);
  }

  // P0-4: initiator and target must be different agents
  if (p.initiator === p.target) {
    throw argError('initiator and target must be different agents');
  }

  // P0-1: validate agent-ids
  validateAgentId(p.initiator, 'start-loop');
  validateAgentId(p.target, 'start-loop');

  const context = p.context ? parseJson(p.context, null) : {};
  if (p.context && context === null) {
    throw argError('start-loop: invalid JSON in --context');
  }

  const parentLoopId = p['parent-loop-id'] || null;

  const loopId = genLoopId();
  const loopKey = KEYS.feedbackLoop(loopId);
  const ts = new Date().toISOString();

  const loopData = {
    type: p.type,
    task_id: p['task-id'],
    initiator: p.initiator,
    target: p.target,
    iteration: '1',
    max_iterations: String(DEFAULT_MAX_ITERATIONS),
    state: 'active',
    context: JSON.stringify(context),
    history: JSON.stringify([]),
    created_at: ts,
    updated_at: ts,
  };

  if (parentLoopId) {
    loopData.parent_loop_id = parentLoopId;
  }

  await withRetry(() => {
    // HSET all fields
    const hsetArgs = [];
    for (const [k, v] of Object.entries(loopData)) {
      hsetArgs.push(k, v);
    }
    redis('HSET', loopKey, ...hsetArgs);
    redis('EXPIRE', loopKey, '43200'); // 12h TTL as safety net
  });

  // Add to active set
  await withRetry(() => {
    redis('SADD', KEYS.feedbackLoopsActive, loopId);
  });

  // Track parent-child loop relationship
  if (parentLoopId) {
    try {
      redis('SADD', `openclaw:feedback-loop:${parentLoopId}:children`, loopId);
    } catch { /* best effort */ }
  }

  // Emit event
  await emitEvent('feedback_loop_started', {
    agent: p.initiator,
    loop_id: loopId,
    type: p.type,
    task_id: p['task-id'],
    initiator: p.initiator,
    target: p.target,
  });

  output({
    ok: true,
    loop_id: loopId,
    type: p.type,
    task_id: p['task-id'],
    state: 'active',
    iteration: 1,
    max_iterations: DEFAULT_MAX_ITERATIONS,
    next_agent: p.target,
    message: `Feedback loop started. ${p.target} should act next.`,
  });
}

/**
 * ocr loop-result --loop-id <id> --agent <agent> --verdict <pass|fail|fix> --details <json>
 */
export async function cmdLoopResult(args) {
  const p = parseArgs(args);

  if (!p['loop-id']) throw argError('loop-result requires --loop-id');
  if (!p.agent)      throw argError('loop-result requires --agent');
  if (!p.verdict)    throw argError('loop-result requires --verdict (pass|fail|fix)');

  if (!VALID_VERDICTS.includes(p.verdict)) {
    throw argError(`loop-result: invalid verdict "${p.verdict}". Valid: ${VALID_VERDICTS.join(', ')}`);
  }

  // P0-1: validate agent-id
  validateAgentId(p.agent, 'loop-result');

  const details = p.details ? parseJson(p.details, null) : {};
  if (p.details && details === null) {
    throw argError('loop-result: invalid JSON in --details');
  }

  const loopId = p['loop-id'];
  const loopKey = KEYS.feedbackLoop(loopId);
  const lockKey = `openclaw:locks:loop:${loopId}`;

  await withLock(lockKey, async () => {

  // Fetch current loop data
  const raw = await withRetry(() => redisRaw(['HGETALL', loopKey]));
  const loop = parseHgetall(raw);

  if (!loop.state) {
    output({ ok: false, error: 'not_found', message: `Loop ${loopId} not found` }, 1);
    return;
  }

  if (loop.state !== 'active') {
    output({ ok: false, error: 'invalid_state', message: `Loop ${p['loop-id']} is ${loop.state}, not active` }, 1);
    return;
  }

  const iteration = parseInt(loop.iteration, 10);
  const maxIterations = parseInt(loop.max_iterations, 10);
  const history = parseJson(loop.history, []);
  const ts = new Date().toISOString();

  // Add this result to history
  history.push({
    iteration,
    agent: p.agent,
    verdict: p.verdict,
    details,
    timestamp: ts,
  });

  if (p.verdict === 'pass') {
    // ── PASS: loop completed — keep terminal hash for status/list + GC ──
    await finalizeLoop(p['loop-id'], {
      state: 'completed',
      history,
      completed_at: ts,
      completed_by: p.agent,
    });

    await emitEvent('feedback_loop_completed', {
      agent: p.agent,
      loop_id: p['loop-id'],
      type: loop.type,
      task_id: loop.task_id,
      iteration,
      verdict: 'pass',
    });

    output({
      ok: true,
      loop_id: p['loop-id'],
      action: 'completed',
      state: 'completed',
      iteration,
      message: 'Feedback loop completed successfully.',
    });

  } else {
    // ── FAIL or FIX ──
    // "fix" = initiator fixed the issue, target should re-verify (no iteration bump)
    // "fail" = target found problems, initiator should fix (iteration bumps)
    const isFail = p.verdict === 'fail';
    const next = nextAgent(loop.type, p.agent, loop.initiator, loop.target);

    if (isFail) {
      // Target reported failure — this consumes an iteration
      if (iteration < maxIterations) {
        const newIteration = iteration + 1;

        await withRetry(() => {
          redis('HSET', loopKey,
            'iteration', String(newIteration),
            'history', JSON.stringify(history),
            'updated_at', ts,
          );
        });

        await emitEvent('feedback_loop_iteration', {
          agent: p.agent,
          loop_id: p['loop-id'],
          type: loop.type,
          task_id: loop.task_id,
          iteration: newIteration,
          verdict: p.verdict,
          next_agent: next,
          details,
        });

        output({
          ok: true,
          loop_id: p['loop-id'],
          action: 'continue',
          state: 'active',
          iteration: newIteration,
          next_agent: next,
          verdict: p.verdict,
          message: `Iteration ${newIteration}/${maxIterations}. ${next} should act next.`,
        });

      } else {
        // Max iterations reached: escalate, but keep terminal hash for inspection/GC
        await finalizeLoop(p['loop-id'], {
          state: 'escalated',
          history,
          escalated_at: ts,
          escalation_reason: 'max_iterations_reached',
        });

        await emitEvent('feedback_loop_escalated', {
          agent: p.agent,
          loop_id: p['loop-id'],
          type: loop.type,
          task_id: loop.task_id,
          iteration,
          verdict: p.verdict,
          reason: 'max_iterations_reached',
        });

        output({
          ok: true,
          loop_id: p['loop-id'],
          action: 'escalate',
          state: 'escalated',
          iteration,
          reason: 'max_iterations_reached',
          message: `Max iterations (${maxIterations}) reached. Escalating to coordinator.`,
        });
      }

    } else {
      // "fix" — initiator applied a fix, target should re-verify (same iteration)
      await withRetry(() => {
        redis('HSET', loopKey,
          'history', JSON.stringify(history),
          'updated_at', ts,
        );
      });

      await emitEvent('feedback_loop_iteration', {
        agent: p.agent,
        loop_id: p['loop-id'],
        type: loop.type,
        task_id: loop.task_id,
        iteration,
        verdict: p.verdict,
        next_agent: next,
        details,
      });

      output({
        ok: true,
        loop_id: p['loop-id'],
        action: 'continue',
        state: 'active',
        iteration,
        next_agent: next,
        verdict: p.verdict,
        message: `Fix applied. ${next} should verify (iteration ${iteration}/${maxIterations}).`,
      });
    }
  }

  }); // end withLock
}

/**
 * ocr loop-status [--loop-id <id>] [--active]
 */
export async function cmdLoopStatus(args) {
  const p = parseArgs(args);

  if (p['loop-id']) {
    // Detailed status for a specific loop
    const loopKey = KEYS.feedbackLoop(p['loop-id']);
    const raw = await withRetry(() => redisRaw(['HGETALL', loopKey]));
    const loop = parseHgetall(raw);

    if (!loop.state) {
      output({ ok: false, error: 'not_found', message: `Loop ${p['loop-id']} not found` }, 1);
      return;
    }

    output({
      ok: true,
      loop_id: p['loop-id'],
      type: loop.type,
      task_id: loop.task_id,
      initiator: loop.initiator,
      target: loop.target,
      iteration: parseInt(loop.iteration, 10),
      max_iterations: parseInt(loop.max_iterations, 10),
      state: loop.state,
      context: parseJson(loop.context, {}),
      history: parseJson(loop.history, []),
      created_at: loop.created_at,
      updated_at: loop.updated_at,
    });

  } else if (args.includes('--active')) {
    // List active loops
    const raw = await withRetry(() => redisRaw(['SMEMBERS', KEYS.feedbackLoopsActive]));
    const trimmed = raw.trim();
    const ids = [];

    if (trimmed && trimmed !== '(empty array)' && trimmed !== '(nil)') {
      const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        const id = line.replace(/^\d+\)\s*/, '').replace(/^"(.*)"$/, '$1');
        if (id) ids.push(id);
      }
    }

    // Fetch summary for each active loop
    const loops = [];
    for (const id of ids) {
      const loopRaw = await withRetry(() => redisRaw(['HGETALL', KEYS.feedbackLoop(id)]));
      const loop = parseHgetall(loopRaw);
      if (loop.state) {
        loops.push({
          loop_id: id,
          type: loop.type,
          task_id: loop.task_id,
          initiator: loop.initiator,
          target: loop.target,
          iteration: parseInt(loop.iteration, 10),
          state: loop.state,
        });
      }
    }

    output({ ok: true, active_loops: loops, count: loops.length });

  } else {
    throw argError('loop-status requires --loop-id <id> or --active');
  }
}

/**
 * ocr loop-list [--status active|completed|escalated] [--limit N]
 */
export async function cmdLoopList(args) {
  const p = parseArgs(args);
  const statusFilter = p.status || null;
  const limit = parseInt(p.limit, 10) || 20;

  // Scan for all feedback loop keys
  const allKeys = [];
  let cursor = '0';

  do {
    const raw = await withRetry(() =>
      redisRaw(['SCAN', cursor, 'MATCH', 'openclaw:feedback-loop:fl-*', 'COUNT', '100'])
    );
    const lines = raw.trim().split('\n').map(l => l.trim()).filter(Boolean);
    // First line is the next cursor
    const cleaned = lines.map(l => l.replace(/^\d+\)\s*/, '').replace(/^"(.*)"$/, '$1'));
    cursor = cleaned[0] || '0';
    for (let i = 1; i < cleaned.length; i++) {
      if (cleaned[i] && cleaned[i] !== '(empty array)') {
        allKeys.push(cleaned[i]);
      }
    }
  } while (cursor !== '0');

  // Fetch and filter
  const loops = [];
  for (const key of allKeys) {
    if (loops.length >= limit) break;

    const raw = await withRetry(() => redisRaw(['HGETALL', key]));
    const loop = parseHgetall(raw);
    if (!loop.state) continue;

    if (statusFilter && loop.state !== statusFilter) continue;

    const loopId = key.replace('openclaw:feedback-loop:', '');
    loops.push({
      loop_id: loopId,
      type: loop.type,
      task_id: loop.task_id,
      initiator: loop.initiator,
      target: loop.target,
      iteration: parseInt(loop.iteration, 10),
      max_iterations: parseInt(loop.max_iterations, 10),
      state: loop.state,
      created_at: loop.created_at,
      updated_at: loop.updated_at,
    });
  }

  // Sort by created_at descending
  loops.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  output({ ok: true, loops, count: loops.length });
}
