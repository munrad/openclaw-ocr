/**
 * commands/orchestrator.mjs — Minimal coordinator runtime for OCR-backed fan-out.
 *
 * This command is intentionally coordinator-owned: it accepts a decomposition
 * plan, persists a lightweight orchestration record, optionally creates a
 * single task-status tracker, and fans out child tasks with shared run
 * metadata so worker agents can operate in parallel.
 */
import { randomBytes } from 'node:crypto';

import { redis, parseJson } from '../lib/redis.mjs';
import { KEYS, genTaskId, now } from '../lib/schema.mjs';
import { output, argError } from '../lib/errors.mjs';
import { getDefaultTelegramChatId, getDefaultTelegramTopicId } from '../lib/config.mjs';
import { resolveCoordinatorBindings, requireExplicitCoordinator } from '../lib/coordinator-bindings.mjs';
import {
  createTaskPayload,
  createTaskStatusMessage,
  ensureBootstrappedAgentStatus,
  persistTaskStatus,
} from './task-status.mjs';
import { ensureGroups, pushTaskPayload } from './tasks.mjs';

const ORCHESTRATION_TTL_SEC = '604800';

function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-/g, '_');
    const next = args[i + 1];
    if (next !== undefined && !String(next).startsWith('--')) {
      result[key] = args[++i];
    } else {
      result[key] = true;
    }
  }
  return result;
}

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (value === true || value === 'true' || value === '1' || value === 1) return true;
  if (value === false || value === 'false' || value === '0' || value === 0) return false;
  return defaultValue;
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function buildSimpleSpec(opts) {
  const goal = String(opts.goal || '').trim();
  const agents = uniqueStrings(String(opts.agents || '').split(','));
  if (!goal) throw argError('orchestrate-fanout requires --goal when --spec is not provided');
  if (agents.length === 0) throw argError('orchestrate-fanout requires --agents when --spec is not provided');

  return {
    task_id: opts.task_id,
    run_id: opts.run_id,
    goal,
    title: opts.title || goal,
    coordinator_id: opts.coordinator_id || opts.coordinator,
    owner_id: opts.owner_id || opts.owner,
    close_owner_id: opts.close_owner_id || opts.close_owner,
    creator_id: opts.creator_id || opts.creator,
    topic_id: opts.topic_id,
    chat_id: opts.chat_id,
    context: opts.context ? parseJson(opts.context, opts.context) : undefined,
    metadata: opts.metadata ? parseJson(opts.metadata, {}) : {},
    create_tracker: opts.create_tracker,
    children: agents.map((agentId, index) => ({
      agent: agentId,
      title: `${goal} (${agentId})`,
      type: opts.type || 'general',
      priority: Number.isFinite(Number(opts.priority)) ? Number(opts.priority) : undefined,
      acceptance_criteria: opts.acceptance_criteria || '',
      order: index,
    })),
  };
}

function buildSpec(opts) {
  if (opts.spec) {
    const parsed = parseJson(opts.spec, null);
    if (!parsed || typeof parsed !== 'object') {
      throw argError('orchestrate-fanout: invalid JSON in --spec');
    }
    return parsed;
  }
  return buildSimpleSpec(opts);
}

function normalizeChildren(children, goal, parentRunId, coordinatorId) {
  if (!Array.isArray(children) || children.length === 0) {
    throw argError('orchestrate-fanout requires children[]');
  }

  const agentIds = uniqueStrings(children.map((child) => child?.agent));
  if (agentIds.length !== children.length) {
    throw argError('orchestrate-fanout children[] must have unique non-empty agent ids');
  }

  return children.map((child, index) => ({
    agent: String(child.agent).trim(),
    title: String(child.title || child.subtask || `${goal} (${child.agent})`).trim(),
    type: String(child.type || 'general').trim() || 'general',
    priority: Number.isFinite(Number(child.priority)) ? Number(child.priority) : 50,
    acceptance_criteria: String(child.acceptance_criteria || child.acceptance || '').trim(),
    payload: (child.payload && typeof child.payload === 'object') ? child.payload : {},
    child_run_id: String(
      child.child_run_id
      || `${parentRunId}:${child.agent}:${index + 1}:${randomBytes(2).toString('hex')}`,
    ).trim(),
    order: Number.isFinite(Number(child.order)) ? Number(child.order) : index,
    coordinator_id: coordinatorId,
  }));
}

function wantsTracker(spec, opts) {
  const explicit = spec.create_tracker ?? opts.create_tracker;
  if (explicit !== undefined) return parseBoolean(explicit, false);
  return Boolean(spec.chat_id || opts.chat_id || spec.topic_id || opts.topic_id);
}

function persistFallbackTracker(taskId, trackerInput, trackerError) {
  const fallbackDeliveryState = trackerError.delivery_state
    || (trackerError.error === 'telegram_token_missing' ? 'suppressed' : 'pending');
  persistTaskStatus(taskId, {
    ...createTaskPayload(taskId, trackerInput),
    delivery_state: fallbackDeliveryState,
    delivery_error: trackerError.description || trackerError.error || 'tracker_persisted_without_message',
    bootstrap_pending: fallbackDeliveryState === 'pending' ? '1' : '0',
  });

  return {
    ok: false,
    message_id: null,
    delivery_state: fallbackDeliveryState,
    error: trackerError.error,
    description: trackerError.description || trackerError.error || 'tracker_persisted_without_message',
  };
}

function writeOrchestrationRecord(taskId, record) {
  const fields = ['task_id', taskId];
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null) continue;
    fields.push(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  redis('HSET', KEYS.orchestration(taskId), ...fields);
  redis('EXPIRE', KEYS.orchestration(taskId), ORCHESTRATION_TTL_SEC);
}

function emitOrchestrationEvent(type, data) {
  try {
    redis(
      'XADD',
      KEYS.eventsStream,
      'MAXLEN',
      '~',
      '10000',
      '*',
      'type',
      type,
      'timestamp',
      now(),
      'agent',
      data.coordinator_id || 'system',
      'data',
      JSON.stringify(data),
    );
  } catch {
    // best effort; orchestration must not fail on event emission
  }
}

export async function cmdOrchestrateFanout(args) {
  const opts = parseArgs(args);
  const spec = buildSpec(opts);
  const explicitBindings = requireExplicitCoordinator(spec, opts);
  if (!explicitBindings) {
    throw argError('orchestrate-fanout requires --coordinator-id or OPENCLAW_COORDINATOR_ID');
  }

  const bindings = resolveCoordinatorBindings(spec, opts);
  const goal = String(spec.goal || '').trim();
  if (!goal) throw argError('orchestrate-fanout requires goal');

  const taskId = String(spec.task_id || genTaskId()).trim();
  const parentRunId = String(spec.parent_run_id || spec.run_id || taskId).trim() || taskId;
  const title = String(spec.title || goal || taskId).trim() || taskId;
  const context = spec.context && typeof spec.context === 'object' ? spec.context : {};
  const metadata = spec.metadata && typeof spec.metadata === 'object' ? spec.metadata : {};
  const children = normalizeChildren(spec.children, goal, parentRunId, bindings.coordinator_id);
  const childAgents = children.map((child) => child.agent);

  ensureGroups();

  const trackerInput = {
    title,
    agents: childAgents,
    topic_id: spec.topic_id || opts.topic_id || getDefaultTelegramTopicId(),
    chat_id: spec.chat_id || opts.chat_id || getDefaultTelegramChatId(),
    run_id: parentRunId,
    coordinator_id: bindings.coordinator_id,
    owner_id: bindings.owner_id,
    close_owner_id: bindings.close_owner_id,
    creator_id: bindings.creator_id,
  };

  let tracker = null;
  if (wantsTracker(spec, opts)) {
    const trackerResult = await createTaskStatusMessage(taskId, trackerInput);
    tracker = trackerResult.ok
      ? {
          ok: true,
          message_id: trackerResult.message_id,
          delivery_state: trackerResult.task?.delivery_state || 'confirmed',
        }
      : persistFallbackTracker(taskId, trackerInput, trackerResult);
  }

  for (const child of children) {
    ensureBootstrappedAgentStatus(child.agent, {
      task_id: taskId,
      run_id: parentRunId,
      state: 'queued',
      step: child.title || 'queued by coordinator',
      progress: 0,
    });
  }

  const createdAt = new Date().toISOString();
  const createdChildren = [];

  writeOrchestrationRecord(taskId, {
    run_id: parentRunId,
    coordinator_id: bindings.coordinator_id,
    owner_id: bindings.owner_id,
    title,
    goal,
    phase: 'fanout_started',
    status: 'active',
    child_agents: childAgents,
    child_count: children.length,
    tracker_enabled: tracker ? '1' : '0',
    created_at: createdAt,
    updated_at: createdAt,
    context,
    metadata,
  });

  emitOrchestrationEvent('orchestration_started', {
    task_id: taskId,
    run_id: parentRunId,
    coordinator_id: bindings.coordinator_id,
    child_agents: childAgents,
    child_count: children.length,
    tracker_enabled: Boolean(tracker),
  });

  try {
    for (const child of children) {
      const childPayload = {
        type: child.type,
        priority: child.priority,
        target_agent: child.agent,
        payload: {
          goal,
          subtask: child.title,
          acceptance_criteria: child.acceptance_criteria,
          parent_task_id: taskId,
          parent_run_id: parentRunId,
          run_id: parentRunId,
          child_run_id: child.child_run_id,
          assigned_by: bindings.coordinator_id,
          coordination_mode: 'parallel',
          orchestrator: 'ocr:orchestrate-fanout',
          child_index: child.order,
          child_count: children.length,
          sibling_agents: childAgents,
          context,
          metadata,
          ...child.payload,
        },
      };

      const childTaskId = await pushTaskPayload(childPayload);
      const createdChild = {
        task_id: childTaskId,
        agent: child.agent,
        child_run_id: child.child_run_id,
        type: child.type,
        title: child.title,
        acceptance_criteria: child.acceptance_criteria,
      };
      createdChildren.push(createdChild);
      emitOrchestrationEvent('orchestration_child_task_created', {
        task_id: taskId,
        run_id: parentRunId,
        coordinator_id: bindings.coordinator_id,
        child_task_id: childTaskId,
        child_agent: child.agent,
        child_run_id: child.child_run_id,
      });
    }
  } catch (err) {
    writeOrchestrationRecord(taskId, {
      run_id: parentRunId,
      coordinator_id: bindings.coordinator_id,
      owner_id: bindings.owner_id,
      title,
      goal,
      phase: 'fanout_failed',
      status: 'failed',
      child_agents: childAgents,
      child_count: children.length,
      created_children: createdChildren,
      error: String(err.message || err),
      updated_at: new Date().toISOString(),
      context,
      metadata,
    });
    output({
      ok: false,
      error: 'fanout_failed',
      task_id: taskId,
      run_id: parentRunId,
      created_children: createdChildren,
      description: String(err.message || err),
    }, 1);
    return;
  }

  writeOrchestrationRecord(taskId, {
    run_id: parentRunId,
    coordinator_id: bindings.coordinator_id,
    owner_id: bindings.owner_id,
    title,
    goal,
    phase: 'fanout_completed',
    status: 'active',
    child_agents: childAgents,
    child_count: children.length,
    created_children: createdChildren,
    tracker_enabled: tracker ? '1' : '0',
    tracker_delivery_state: tracker?.delivery_state,
    updated_at: new Date().toISOString(),
    context,
    metadata,
  });

  output({
    ok: true,
    task_id: taskId,
    run_id: parentRunId,
    coordinator_id: bindings.coordinator_id,
    child_count: createdChildren.length,
    children: createdChildren,
    tracker,
  });
}
