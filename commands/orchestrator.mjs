/**
 * commands/orchestrator.mjs — Minimal coordinator runtime for OCR-backed fan-out.
 *
 * This module intentionally stays coordinator-owned: it accepts a ready
 * decomposition plan, persists a lightweight orchestration record, optionally
 * creates a single task-status tracker, and fans out child tasks with shared
 * run metadata so worker agents can operate in parallel.
 */
import { randomBytes } from 'node:crypto';

import { redis, redisRaw, parseHgetall, parseJson, withLock } from '../lib/redis.mjs';
import { KEYS, genTaskId, now } from '../lib/schema.mjs';
import { output, argError } from '../lib/errors.mjs';
import { getDefaultTelegramChatId, getDefaultTelegramTopicId } from '../lib/config.mjs';
import { resolveCoordinatorBindings, requireExplicitCoordinator } from '../lib/coordinator-bindings.mjs';
import {
  createTaskPayload,
  createTaskStatusMessage,
  ensureBootstrappedAgentStatus,
  getAgentStatuses,
  getTaskData,
  closeTaskStatusTracker,
  persistTaskStatus,
} from './task-status.mjs';
import { ensureGroups, pushTaskPayload } from './tasks.mjs';

const ORCHESTRATION_TTL_SEC = '604800';
const DEFAULT_MAX_FANOUT_CHILDREN = 8;
const DEFAULT_MAX_ACTIVE_ORCHESTRATIONS = 10;
const ACTIVE_INDEX_LOCK_KEY = 'openclaw:locks:orchestrations:active-index';

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

function parsePositiveInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.floor(numeric);
}

function getMaxFanoutChildren() {
  return parsePositiveInteger(process.env.OPENCLAW_MAX_FANOUT_CHILDREN, DEFAULT_MAX_FANOUT_CHILDREN);
}

function getMaxActiveOrchestrations() {
  return parsePositiveInteger(process.env.OPENCLAW_MAX_ACTIVE_ORCHESTRATIONS, DEFAULT_MAX_ACTIVE_ORCHESTRATIONS);
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
      data.coordinator_id || data.actor_id || 'system',
      'data',
      JSON.stringify(data),
    );
  } catch {
    // best effort; orchestration must not fail on event emission
  }
}

function readOrchestrationRecord(taskId) {
  try {
    const raw = redisRaw(['HGETALL', KEYS.orchestration(taskId)]);
    return parseHgetall(raw);
  } catch {
    return {};
  }
}

function parseOrchestrationRecord(rawRecord = {}) {
  if (!rawRecord || Object.keys(rawRecord).length === 0) return null;

  return {
    ...rawRecord,
    child_agents: parseJson(rawRecord.child_agents, []),
    created_children: parseJson(rawRecord.created_children, []),
    context: parseJson(rawRecord.context, {}),
    metadata: parseJson(rawRecord.metadata, {}),
    tracker_enabled: rawRecord.tracker_enabled === '1' || rawRecord.tracker_enabled === 1,
    child_count: Number.parseInt(rawRecord.child_count, 10) || 0,
    tracker_close: parseJson(rawRecord.tracker_close, null),
    child_result_summary: parseJson(rawRecord.child_result_summary, null),
    child_status_summary: parseJson(rawRecord.child_status_summary, null),
  };
}

function getActiveOrchestrationIds() {
  const raw = redisRaw(['SMEMBERS', KEYS.orchestrationsActive]).trim();
  return raw ? raw.split('\n').map((line) => line.trim()).filter(Boolean) : [];
}

function pruneActiveOrchestrationsIndex() {
  const activeIds = getActiveOrchestrationIds();
  const survivingIds = [];

  for (const orchestrationId of activeIds) {
    const record = parseOrchestrationRecord(readOrchestrationRecord(orchestrationId));
    if (!record || record.status !== 'active') {
      try { redis('SREM', KEYS.orchestrationsActive, orchestrationId); } catch { /* best effort */ }
      continue;
    }
    survivingIds.push(orchestrationId);
  }

  return survivingIds;
}

function scanOrchestrationIds() {
  const raw = redisRaw(['--scan', '--pattern', 'openclaw:orchestration:*']).trim();
  if (!raw) return [];
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((key) => key.replace(/^openclaw:orchestration:/, ''));
}

function getTaskResult(taskId) {
  try {
    const raw = redisRaw(['HGETALL', KEYS.taskResult(taskId)]);
    return parseHgetall(raw);
  } catch {
    return {};
  }
}

function summarizeChildResults(children = []) {
  const summary = { done: 0, failed: 0, pending: 0, unknown: 0 };
  const results = children.map((child) => {
    const taskResult = getTaskResult(child.task_id);
    const normalizedStatus = taskResult.status === 'done'
      ? 'done'
      : taskResult.status === 'failed'
        ? 'failed'
        : taskResult.status === 'pending'
          ? 'pending'
          : 'unknown';
    summary[normalizedStatus] += 1;
    return {
      ...child,
      result: taskResult,
      result_status: normalizedStatus,
    };
  });
  return { results, summary };
}

function summarizeAgentStates(agentIds = [], options = {}) {
  const childSpecs = new Map(
    (options.children || [])
      .filter((child) => child?.agent)
      .map((child) => [String(child.agent).trim(), child]),
  );
  const agentStatuses = getAgentStatuses(agentIds, {
    expected_run_id: options.expected_run_id || options.expectedRunId,
    fallback_state: 'queued',
    fallback_step: (agentId) => {
      const child = childSpecs.get(String(agentId || '').trim());
      return String(child?.title || 'queued by coordinator').trim() || 'queued by coordinator';
    },
  });
  const summary = {};
  const statuses = agentIds.map((agentId) => {
    const status = agentStatuses.get(agentId) || {};
    const state = String(status.state || 'unknown').trim() || 'unknown';
    summary[state] = (summary[state] || 0) + 1;
    return { agent: agentId, ...status };
  });
  return { statuses, summary };
}

function parseTrackerRecord(taskData = {}) {
  if (!taskData || Object.keys(taskData).length === 0) return null;
  return {
    ...taskData,
    agents: parseJson(taskData.agents, []),
  };
}

function allowedOrchestrationClosers(record = {}) {
  return new Set(
    [record.coordinator_id, record.owner_id, record.close_owner_id]
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  );
}

function buildOrchestrationSnapshot(taskId) {
  const record = parseOrchestrationRecord(readOrchestrationRecord(taskId));
  if (!record) return null;

  const tracker = parseTrackerRecord(getTaskData(taskId));
  const childResults = summarizeChildResults(record.created_children);
  const childStatuses = summarizeAgentStates(record.child_agents, {
    expected_run_id: record.run_id,
    children: record.created_children,
  });
  const activeIndexed = redis('SISMEMBER', KEYS.orchestrationsActive, taskId) === '1';

  return {
    ...record,
    active_indexed: activeIndexed,
    tracker,
    children: childResults.results,
    child_result_summary: childResults.summary,
    child_statuses: childStatuses.statuses,
    child_status_summary: childStatuses.summary,
    all_children_terminal: childResults.summary.pending === 0 && childResults.summary.unknown === 0,
    has_failed_children: childResults.summary.failed > 0,
  };
}

function evaluateCloseSafety(snapshot, result) {
  const childSummary = snapshot?.child_result_summary || { done: 0, failed: 0, pending: 0, unknown: 0 };
  if ((childSummary.pending || 0) > 0 || (childSummary.unknown || 0) > 0) {
    return {
      ok: false,
      error: 'children_incomplete',
      description: 'root orchestration still has pending or unknown child tasks',
      child_result_summary: childSummary,
    };
  }

  if (result === 'success' && (childSummary.failed || 0) > 0) {
    return {
      ok: false,
      error: 'child_failures_present',
      description: 'cannot close orchestration as success while child tasks are failed',
      child_result_summary: childSummary,
    };
  }

  return { ok: true, child_result_summary: childSummary };
}

async function reserveActiveOrchestration(taskId) {
  return withLock(ACTIVE_INDEX_LOCK_KEY, async () => {
    const existing = readOrchestrationRecord(taskId);
    if (Object.keys(existing).length > 0) {
      return { ok: false, error: 'task_id_exists', task_id: taskId };
    }

    const activeIds = pruneActiveOrchestrationsIndex();
    const activeLimit = getMaxActiveOrchestrations();
    if (activeIds.length >= activeLimit) {
      return {
        ok: false,
        error: 'active_orchestration_limit_exceeded',
        active: activeIds.length,
        limit: activeLimit,
      };
    }

    redis('SADD', KEYS.orchestrationsActive, taskId);
    return { ok: true, active_before: activeIds.length, limit: activeLimit };
  });
}

async function releaseActiveOrchestration(taskId) {
  return withLock(ACTIVE_INDEX_LOCK_KEY, async () => {
    try { redis('SREM', KEYS.orchestrationsActive, taskId); } catch { /* best effort */ }
    return { ok: true };
  });
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
  const maxChildren = getMaxFanoutChildren();

  if (children.length > maxChildren) {
    output({
      ok: false,
      error: 'fanout_limit_exceeded',
      task_id: taskId,
      child_count: children.length,
      limit: maxChildren,
      description: `orchestrate-fanout allows at most ${maxChildren} child agents per root task`,
    });
    return;
  }

  ensureGroups();

  const reservation = await reserveActiveOrchestration(taskId);
  if (!reservation.ok) {
    output({
      ok: false,
      ...reservation,
      description: reservation.error === 'task_id_exists'
        ? `orchestration root ${taskId} already exists`
        : `active orchestration limit reached (${reservation.limit})`,
    });
    return;
  }

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

  const createdAt = new Date().toISOString();
  writeOrchestrationRecord(taskId, {
    run_id: parentRunId,
    coordinator_id: bindings.coordinator_id,
    owner_id: bindings.owner_id,
    close_owner_id: bindings.close_owner_id,
    creator_id: bindings.creator_id,
    title,
    goal,
    phase: 'fanout_started',
    status: 'active',
    child_agents: childAgents,
    child_count: children.length,
    tracker_enabled: wantsTracker(spec, opts) ? '1' : '0',
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
    tracker_enabled: wantsTracker(spec, opts),
  });

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

    writeOrchestrationRecord(taskId, {
      tracker_enabled: '1',
      tracker_delivery_state: tracker?.delivery_state,
      tracker_message_id: tracker?.message_id || null,
      updated_at: new Date().toISOString(),
    });
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

  const createdChildren = [];

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
      close_owner_id: bindings.close_owner_id,
      creator_id: bindings.creator_id,
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
    await releaseActiveOrchestration(taskId);
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
    close_owner_id: bindings.close_owner_id,
    creator_id: bindings.creator_id,
    title,
    goal,
    phase: 'fanout_completed',
    status: 'active',
    child_agents: childAgents,
    child_count: children.length,
    created_children: createdChildren,
    tracker_enabled: tracker ? '1' : '0',
    tracker_delivery_state: tracker?.delivery_state,
    tracker_message_id: tracker?.message_id || null,
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

export async function cmdGetOrchestration(args) {
  const opts = parseArgs(args);
  const taskId = String(opts.task_id || '').trim();
  if (!taskId) throw argError('get-orchestration requires --task-id');

  const snapshot = buildOrchestrationSnapshot(taskId);
  if (!snapshot) {
    output({ ok: false, error: 'orchestration_not_found', task_id: taskId });
    return;
  }

  output({
    ok: true,
    task_id: taskId,
    orchestration: snapshot,
  });
}

export async function cmdListOrchestrations(args) {
  const opts = parseArgs(args);
  const statusFilter = String(opts.status || 'active').trim().toLowerCase();
  const limit = parsePositiveInteger(opts.limit, 20);

  const candidateIds = statusFilter === 'active'
    ? getActiveOrchestrationIds()
    : scanOrchestrationIds();

  const records = [];
  for (const taskId of candidateIds) {
    const record = parseOrchestrationRecord(readOrchestrationRecord(taskId));
    if (!record) continue;
    if (statusFilter !== 'all' && record.status !== statusFilter) continue;
    const childSummary = summarizeChildResults(record.created_children).summary;
    records.push({
      task_id: taskId,
      title: record.title,
      goal: record.goal,
      status: record.status,
      phase: record.phase,
      coordinator_id: record.coordinator_id,
      owner_id: record.owner_id,
      child_count: record.child_count,
      done_children: childSummary.done,
      failed_children: childSummary.failed,
      pending_children: childSummary.pending,
      unknown_children: childSummary.unknown,
      tracker_enabled: record.tracker_enabled,
      tracker_delivery_state: record.tracker_delivery_state || '',
      created_at: record.created_at || '',
      updated_at: record.updated_at || '',
    });
  }

  records.sort((left, right) => String(right.updated_at || '').localeCompare(String(left.updated_at || '')));

  output({
    ok: true,
    status: statusFilter,
    count: Math.min(records.length, limit),
    orchestrations: records.slice(0, limit),
  });
}

export async function cmdCloseOrchestration(args) {
  const opts = parseArgs(args);
  const taskId = String(opts.task_id || '').trim();
  const actorId = String(opts.actor_id || '').trim();
  const result = String(opts.result || 'success').trim() === 'fail' ? 'fail' : 'success';
  const summary = String(opts.summary || '').trim();
  const skipTrackerClose = parseBoolean(opts.skip_tracker_close, false);
  const force = parseBoolean(opts.force, false);

  if (!taskId) throw argError('close-orchestration requires --task-id');
  if (!actorId) throw argError('close-orchestration requires --actor-id');

  const record = parseOrchestrationRecord(readOrchestrationRecord(taskId));
  if (!record) {
    output({ ok: false, error: 'orchestration_not_found', task_id: taskId });
    return;
  }

  const allowed = allowedOrchestrationClosers(record);
  const hasStrictOwnership = allowed.size > 0;
  const actorAllowed = allowed.has(actorId);
  if (hasStrictOwnership && !actorAllowed) {
    output({ ok: false, error: 'not_closer', task_id: taskId, allowed: [...allowed] });
    process.exitCode = 1;
    return;
  }

  if (record.status !== 'active') {
    output({
      ok: true,
      closed: false,
      idempotent: true,
      task_id: taskId,
      status: record.status,
      phase: record.phase,
    });
    return;
  }

  const snapshot = buildOrchestrationSnapshot(taskId);
  const closeSafety = evaluateCloseSafety(snapshot, result);
  if (!closeSafety.ok && !force) {
    output({
      ok: false,
      task_id: taskId,
      result,
      ...closeSafety,
    });
    process.exitCode = 1;
    return;
  }

  const trackerClose = skipTrackerClose
    ? { ok: false, skipped: true, reason: 'skip_tracker_close' }
    : await closeTaskStatusTracker(taskId, {
        result,
        actor_id: actorId,
        projection_optional: true,
      });

  writeOrchestrationRecord(taskId, {
    status: result === 'fail' ? 'failed' : 'completed',
    phase: 'closed',
    closed_at: new Date().toISOString(),
    closed_by: actorId,
    close_result: result,
    close_summary: summary,
    forced_close: force ? '1' : '0',
    forced_close_reason: force && !closeSafety.ok ? closeSafety.error : '',
    tracker_close: trackerClose,
    child_result_summary: snapshot?.child_result_summary || null,
    child_status_summary: snapshot?.child_status_summary || null,
    updated_at: new Date().toISOString(),
  });

  await releaseActiveOrchestration(taskId);

  emitOrchestrationEvent('orchestration_closed', {
    task_id: taskId,
    run_id: record.run_id || taskId,
    coordinator_id: record.coordinator_id,
    actor_id: actorId,
    result,
    summary,
    tracker_close: trackerClose,
  });

  output({
    ok: true,
    closed: true,
    task_id: taskId,
    result,
    forced: force,
    forced_reason: force && !closeSafety.ok ? closeSafety.error : null,
    child_result_summary: snapshot?.child_result_summary || null,
    tracker_close: trackerClose,
  });
}
