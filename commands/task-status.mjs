/**
 * commands/task-status.mjs — Task-scoped status message commands
 *
 * Creates/updates/closes a live status message in the Telegram topic
 * where the task was initiated.
 *
 * Contract (v3 — strict-only):
 *   1. Coordinator creates tracker once via task-status-create (idempotent)
 *   2. Downstream agents join via task-status-join (append-only)
 *   3. Watcher only updates TG message (no auto-create, no auto-close)
 *   4. Only coordinator/owner can close via task-status-close
 *
 * Commands:
 *   task-status-create --task-id <id> --topic-id <id> --title "..." --agents coder,tester --coordinator-id <id> [--owner-id <id>]
 *   task-status-join   --task-id <id> --agent-id <agent>
 *   task-status-update --task-id <id>
 *   task-status-close  --task-id <id> --result success|fail --actor-id <id>
 */
import https from 'node:https';
import { redis, redisRaw, parseHgetall, parseJson, withLock } from '../lib/redis.mjs';
import { KEYS } from '../lib/schema.mjs';
import { output, argError } from '../lib/errors.mjs';
import { writeAgentStatus } from '../lib/status-reconcile.mjs';

// ─── Config ──────────────────────────────────────────────────────────────────

const TG_TOKEN = process.env.OPENCLAW_TELEGRAM_BOT_TOKEN;
export const DEFAULT_CHAT_ID = '-1003891295903';
export const DEFAULT_TASK_TOPIC_ID = '1';
const TASK_STATUS_TTL_SEC = '86400';
const IMMUTABLE_BINDING_FIELDS = ['coordinator_id', 'owner_id', 'close_owner_id', 'creator_id'];

// ─── Arg Parser ──────────────────────────────────────────────────────────────

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

// ─── Telegram API ────────────────────────────────────────────────────────────

function tgApi(method, body, timeoutMs = taskStatusTgTimeoutMs()) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TG_TOKEN}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      clearTimeout(hardTimer);
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(chunks)); }
        catch { resolve({ ok: false, description: chunks }); }
      });
    });
    const hardTimer = setTimeout(() => {
      req.destroy(new Error(`Telegram request timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    req.on('error', (err) => {
      clearTimeout(hardTimer);
      reject(err);
    });
    req.write(data);
    req.end();
  });
}

const TG_MAX_RETRIES = 5;
// Absolute ceiling for all Telegram retries combined (hard wall-clock budget).
// IMPORTANT: Any Redis lock TTL that wraps tgApiSafe() MUST be derived from
// this same budget to guarantee the lock cannot expire while tgApiSafe is
// still retrying (avoid drift / heuristic mismatch).
const TG_MAX_WALL_CLOCK_MS = 30_000; // 30s

export function computeTelegramWallClockBudgetMs() {
  return TG_MAX_WALL_CLOCK_MS;
}

// Backward-compatible alias while callers converge on the shared helper name.
export const telegramWallClockBudgetMs = computeTelegramWallClockBudgetMs;

export function taskStatusTgRetries() {
  return Math.min(TG_MAX_RETRIES, Math.max(1, Number(process.env.OCR_TASK_STATUS_TG_RETRIES) || 3));
}

export function taskStatusTgTimeoutMs() {
  return Math.max(250, Number(process.env.OCR_TASK_STATUS_TG_TIMEOUT_MS) || 5000);
}

export async function tgApiSafe(method, body, retries = taskStatusTgRetries(), opts = {}) {
  const perRequestTimeout = opts.timeoutMs || taskStatusTgTimeoutMs();
  const deadline = Date.now() + computeTelegramWallClockBudgetMs();
  for (let attempt = 0; attempt < retries; attempt++) {
    if (Date.now() >= deadline) {
      return { ok: false, description: 'wall-clock deadline exceeded' };
    }
    try {
      const result = await tgApi(method, body, perRequestTimeout);
      if (result.ok) return result;
      if (result.error_code === 429) {
        const wait = (result.parameters?.retry_after || 5) * 1000;
        if (Date.now() + wait >= deadline) return { ok: false, description: 'wall-clock deadline exceeded (429 backoff)' };
        await new Promise(r => setTimeout(r, wait + 500));
        continue;
      }
      if (result.description?.includes('message is not modified')) return result;
      return result;
    } catch (err) {
      if (attempt < retries - 1) {
        const backoff = 2000 * (attempt + 1);
        if (Date.now() + backoff >= deadline) return { ok: false, description: 'wall-clock deadline exceeded (retry backoff)' };
        await new Promise(r => setTimeout(r, backoff));
      } else {
        return { ok: false, description: err.message || 'max retries exceeded' };
      }
    }
  }
  return { ok: false, description: 'max retries exceeded' };
}

// ─── HTML Helpers ────────────────────────────────────────────────────────────

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function parseTimestampMs(value) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) return null;
    return raw.length <= 10 ? numeric * 1000 : numeric;
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatTaskStatusTimestamp(taskData, agentStatuses, { isClosed = false } = {}) {
  const candidates = [
    taskData?.created_at,
    taskData?.updated_at,
    isClosed ? taskData?.closed_at : null,
  ];

  if (agentStatuses?.values) {
    for (const status of agentStatuses.values()) {
      candidates.push(status?.updated_at);
    }
  }

  let latestMs = null;
  for (const candidate of candidates) {
    const parsed = parseTimestampMs(candidate);
    if (!Number.isFinite(parsed)) continue;
    latestMs = latestMs === null ? parsed : Math.max(latestMs, parsed);
  }

  if (!Number.isFinite(latestMs)) return '—';

  return new Date(latestMs).toLocaleTimeString('ru-RU', {
    timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

/** For topic_id=1 (General), TG API doesn't accept message_thread_id */
export function topicParams(id) {
  const n = parseInt(id, 10);
  return (!n || n === 1) ? {} : { message_thread_id: n };
}

function uniqueAgents(agents) {
  return [...new Set((agents || []).map(a => String(a || '').trim()).filter(Boolean))];
}

function parseChatIdFromTarget(channel, to) {
  const normalizedChannel = String(channel || '').trim().toLowerCase();
  const normalizedTarget = String(to || '').trim();
  if (!normalizedChannel || !normalizedTarget) return '';
  if (normalizedChannel === 'telegram' && normalizedTarget.startsWith('channel:')) {
    return normalizedTarget.slice('channel:'.length).trim();
  }
  return '';
}

function getAgentStatus(agentId) {
  try {
    const raw = redisRaw(['HGETALL', KEYS.agentStatus(agentId)]);
    return parseHgetall(raw);
  } catch {
    return {};
  }
}

export function ensureBootstrappedAgentStatus(agentId, input = {}) {
  const normalizedAgentId = String(agentId || '').trim();
  if (!normalizedAgentId) return { ok: false, reason: 'missing_agent_id' };

  const existingStatus = getAgentStatus(normalizedAgentId);
  if (Object.keys(existingStatus).length > 0) {
    return { ok: true, agent_id: normalizedAgentId, bootstrapped: false, status: existingStatus };
  }

  const runId = String(input.run_id || input.task_id || '').trim();
  const state = String(input.state || 'queued').trim() || 'queued';
  const step = String(input.step || 'spawned, awaiting first worker update').trim()
    || 'spawned, awaiting first worker update';
  const progress = Number.isFinite(Number(input.progress)) ? String(Math.max(0, Number(input.progress))) : '0';
  const runEpoch = String(input.run_epoch || Date.now());

  writeAgentStatus(normalizedAgentId, {
    state,
    step,
    progress,
    ...(runId ? { run_id: runId } : {}),
    run_epoch: runEpoch,
    bootstrapped_by: 'agent_spawned',
  });

  return {
    ok: true,
    agent_id: normalizedAgentId,
    bootstrapped: true,
    status: {
      state,
      step,
      progress,
      ...(runId ? { run_id: runId } : {}),
      run_epoch: runEpoch,
    },
  };
}

// Race safety: concurrent calls may both see empty existing data,
// but createTaskStatusMessage acquires a Redis lock and does a
// double-check inside, preventing duplicate tracker creation.
export async function ensureTaskStatusTracker(taskId, input = {}) {
  const normalizedTaskId = String(taskId || '').trim();
  if (!normalizedTaskId) {
    return { ok: false, error: 'missing_task_id' };
  }

  const normalizedAgentId = String(input.agent_id || input.agent || '').trim();
  const normalizedChatId = String(
    input.chat_id || parseChatIdFromTarget(input.channel, input.to) || DEFAULT_CHAT_ID,
  ).trim();
  const normalizedTopicId = String(input.topic_id || input.thread_id || DEFAULT_TASK_TOPIC_ID).trim();
  const normalizedRunId = String(input.run_id || input.task_id || normalizedTaskId).trim() || normalizedTaskId;
  const normalizedTitle = String(
    input.title || input.label || input.task_title || input.task || normalizedTaskId,
  ).trim() || normalizedTaskId;
  const normalizedCoordinatorId = String(
    input.coordinator_id || input.owner_id || input.creator_id || normalizedAgentId || 'system',
  ).trim() || 'system';

  ensureBootstrappedAgentStatus(normalizedAgentId, {
    task_id: normalizedTaskId,
    run_id: normalizedRunId,
    state: input.initial_state || 'queued',
    step: input.initial_step || 'spawned, awaiting first worker update',
    progress: input.initial_progress ?? 0,
    run_epoch: input.run_epoch,
  });

  const existing = getTaskData(normalizedTaskId);
  const existingAgents = uniqueAgents(parseJson(existing.agents, []));
  const nextAgents = uniqueAgents([...existingAgents, normalizedAgentId]);

  // Short-circuit: if a prior create attempt failed (bootstrap_pending),
  // don't retry TG — just join the agent and return the pending state.
  if (!existing.message_id && (existing.bootstrap_pending === '1' || existing.bootstrap_pending === 1)) {
    const mergedAgents = uniqueAgents([...existingAgents, normalizedAgentId]);
    persistTaskStatus(normalizedTaskId, {
      ...existing,
      agents: JSON.stringify(mergedAgents),
      updated_at: new Date().toISOString(),
    });
    return {
      ok: true,
      task_id: normalizedTaskId,
      message_id: null,
      created: false,
      joined: !!normalizedAgentId,
      bootstrap_pending: true,
      fallback_reason: 'bootstrap_pending_from_prior_attempt',
    };
  }

  if (existing.message_id) {
    const lockKey = `openclaw:locks:task-status:${normalizedTaskId}`;
    return withLock(lockKey, async () => {
      const latest = getTaskData(normalizedTaskId);
      const latestAgents = uniqueAgents(parseJson(latest.agents, []));
      const mergedAgents = uniqueAgents([...latestAgents, normalizedAgentId]);
      persistTaskStatus(normalizedTaskId, {
        ...latest,
        ...(latest.title ? {} : { title: normalizedTitle }),
        ...(latest.run_id ? {} : { run_id: normalizedRunId }),
        ...(latest.chat_id ? {} : { chat_id: normalizedChatId }),
        ...(latest.topic_id ? {} : { topic_id: normalizedTopicId }),
        agents: JSON.stringify(mergedAgents),
        updated_at: new Date().toISOString(),
      });
      return { ok: true, task_id: normalizedTaskId, message_id: latest.message_id, created: false, joined: true };
    });
  }

  const created = await createTaskStatusMessage(normalizedTaskId, {
    title: existing.title || normalizedTitle,
    agents: nextAgents,
    topic_id: existing.topic_id || normalizedTopicId,
    chat_id: existing.chat_id || normalizedChatId,
    run_id: existing.run_id || normalizedRunId,
    coordinator_id: existing.coordinator_id || normalizedCoordinatorId,
    owner_id: existing.owner_id || normalizedCoordinatorId,
    close_owner_id: existing.close_owner_id || normalizedCoordinatorId,
    creator_id: existing.creator_id || normalizedCoordinatorId,
  });

  if (created.ok) {
    return {
      ok: true,
      task_id: normalizedTaskId,
      message_id: created.message_id,
      created: !created.idempotent,
      joined: normalizedAgentId ? true : false,
      idempotent: created.idempotent || false,
    };
  }

  const payload = preserveImmutableBindings(existing, {
    ...(Object.keys(existing).length > 0 ? existing : createTaskPayload(normalizedTaskId, {
      title: normalizedTitle,
      agents: nextAgents,
      topic_id: normalizedTopicId,
      chat_id: normalizedChatId,
      run_id: normalizedRunId,
      coordinator_id: normalizedCoordinatorId,
      owner_id: normalizedCoordinatorId,
      close_owner_id: normalizedCoordinatorId,
      creator_id: normalizedCoordinatorId,
    })),
    title: existing.title || normalizedTitle,
    run_id: existing.run_id || normalizedRunId,
    chat_id: existing.chat_id || normalizedChatId,
    topic_id: existing.topic_id || normalizedTopicId,
    agents: JSON.stringify(nextAgents),
    updated_at: new Date().toISOString(),
    bootstrap_pending: '1',
  });
  persistTaskStatus(normalizedTaskId, payload);

  return {
    ok: true,
    task_id: normalizedTaskId,
    created: false,
    joined: normalizedAgentId ? true : false,
    message_id: payload.message_id || null,
    bootstrap_pending: true,
    fallback_reason: created.error || 'tracker_persisted_without_message',
  };
}

// ─── Task Payload ────────────────────────────────────────────────────────────

function createTaskPayload(taskId, input = {}) {
  const topicId = String(input.topic_id || DEFAULT_TASK_TOPIC_ID);
  const chatId = String(input.chat_id || DEFAULT_CHAT_ID);
  const runId = String(input.run_id || taskId);
  const coordinatorId = String(input.coordinator_id || '').trim();
  const ownerId = String(input.owner_id || coordinatorId || '').trim();
  const closeOwnerId = String(input.close_owner_id || ownerId || coordinatorId || '').trim();
  const creatorId = String(input.creator_id || coordinatorId || '').trim();
  return {
    task_id: String(taskId),
    run_id: runId,
    title: String(input.title || taskId),
    agents: JSON.stringify(uniqueAgents(input.agents || [])),
    topic_id: topicId,
    chat_id: chatId,
    status: 'running',
    coordinator_id: coordinatorId,
    owner_id: ownerId,
    close_owner_id: closeOwnerId,
    creator_id: creatorId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

// ─── Redis Persistence ───────────────────────────────────────────────────────

function normalizeBindingValue(value) {
  const normalized = String(value || '').trim();
  return normalized || '';
}

function preserveImmutableBindings(existingTaskData = {}, nextTaskData = {}) {
  const mergedTaskData = { ...nextTaskData };

  for (const field of IMMUTABLE_BINDING_FIELDS) {
    const existingValue = normalizeBindingValue(existingTaskData[field]);
    const nextValue = normalizeBindingValue(nextTaskData[field]);

    if (!existingValue) continue;
    if (!nextValue || nextValue !== existingValue) {
      mergedTaskData[field] = existingValue;
    }
  }

  return mergedTaskData;
}

function writeTaskStatusHash(taskId, taskData) {
  const redisArgs = ['HSET', KEYS.taskStatus(taskId)];
  for (const [k, v] of Object.entries(taskData)) {
    if (v === undefined || v === null) continue;
    redisArgs.push(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  redis(...redisArgs);
  redis('EXPIRE', KEYS.taskStatus(taskId), TASK_STATUS_TTL_SEC);
}

export function persistTaskStatus(taskId, taskData) {
  const existingTaskData = getTaskData(taskId);
  const persistedTaskData = preserveImmutableBindings(existingTaskData, taskData);

  writeTaskStatusHash(taskId, persistedTaskData);
  if (persistedTaskData.status === 'completed' || persistedTaskData.status === 'failed') {
    redis('SREM', KEYS.taskStatusActive, taskId);
  } else {
    redis('SADD', KEYS.taskStatusActive, taskId);
  }
}

// ─── Create (idempotent) ─────────────────────────────────────────────────────

export async function createTaskStatusMessage(taskId, input = {}) {
  if (!TG_TOKEN) {
    return { ok: false, error: 'telegram_token_missing', description: 'OPENCLAW_TELEGRAM_BOT_TOKEN not set' };
  }

  // B1 fix (strict): lock TTL derived from the exact same wall-clock budget
  // enforced by tgApiSafe(). This makes the guarantee explicit and prevents
  // drift if retry/backoff heuristics change later.
  const lockTtl = Math.ceil(computeTelegramWallClockBudgetMs() / 1000) + 5; // +5s margin

  const lockKey = `openclaw:locks:task-status:${taskId}`;
  return withLock(lockKey, async () => {
    // Idempotency: if tracker already exists with a message_id, return it
    const existing = getTaskData(taskId);
    if (existing.message_id) {
      return {
        ok: true,
        task_id: String(taskId),
        message_id: existing.message_id,
        task: existing,
        idempotent: true,
      };
    }

    const agents = uniqueAgents(input.agents || []);
    if (agents.length === 0) {
      return { ok: false, error: 'no_agents' };
    }

    const taskData = createTaskPayload(taskId, { ...input, agents });
    const agentStatuses = getAgentStatuses(agents);
    const text = renderTaskStatus(taskData, agentStatuses);

    const sendBody = {
      chat_id: taskData.chat_id,
      text,
      parse_mode: 'HTML',
      ...topicParams(taskData.topic_id),
      disable_notification: true,
    };

    const sendResult = await tgApiSafe('sendMessage', sendBody);
    if (!sendResult.ok) {
      return { ok: false, error: 'tg_send_failed', description: sendResult.description };
    }

    const messageId = String(sendResult.result.message_id);
    taskData.message_id = messageId;
    persistTaskStatus(taskId, taskData);

    try {
      redis('XADD', KEYS.eventsStream, '*',
        'type', 'task_status_created',
        'timestamp', String(Math.floor(Date.now() / 1000)),
        'data', JSON.stringify({
          task_id: String(taskId),
          run_id: taskData.run_id,
          topic_id: taskData.topic_id,
          title: taskData.title,
          agents,
          message_id: messageId,
        }));
    } catch { /* non-critical */ }

    return { ok: true, task_id: String(taskId), message_id: messageId, task: taskData };
  }, { ttl: lockTtl });
}

// ─── Agent Emoji Map ─────────────────────────────────────────────────────────

const STATE_EMOJI = {
  working: '🟢', testing: '🟢', reviewing: '🟢', starting: '🟡', queued: '🟡', spawned: '🟡',
  waiting: '⏳', blocked: '❌', failed: '❌', stale: '⚠️',
  completed: '✅', idle: '⏳',
};

// ─── Render ──────────────────────────────────────────────────────────────────

export function renderTaskStatus(taskData, agentStatuses, closeResult) {
  const title = escapeHtml(taskData.title || 'Task');
  const agents = uniqueAgents(parseJson(taskData.agents, []));
  const isClosed = Boolean(closeResult || taskData.status === 'completed' || taskData.status === 'failed');
  const renderedAt = formatTaskStatusTimestamp(taskData, agentStatuses, { isClosed });

  const header = isClosed
    ? `${(closeResult === 'fail' || taskData.status === 'failed') ? '❌' : '✅'} <b>${title}</b> — ${((closeResult === 'fail' || taskData.status === 'failed') ? 'failed' : 'done')}`
    : `🔄 <b>${title}</b>`;

  let doneCount = 0;
  const lines = [];
  for (const agentId of agents) {
    const status = agentStatuses.get(agentId) || {};
    const state = status.state || 'idle';
    const stepRaw = status.step || status.status || state;
    const step = escapeHtml(stepRaw || state);
    const stateEmoji = isClosed
      ? ((closeResult === 'fail' || taskData.status === 'failed') && state === 'failed' ? '❌' : '✅')
      : (STATE_EMOJI[state] || '⏳');
    const progress = parseInt(status.progress, 10);
    const progressSuffix = (!isClosed && Number.isFinite(progress) && progress > 0) ? ` (${progress}%)` : '';
    if (isClosed || state === 'completed') doneCount++;
    lines.push(`├ ${stateEmoji} <b>${escapeHtml(agentId)}</b> — ${step}${progressSuffix}`);
  }

  return [
    header,
    '',
    ...lines,
    `└ ${doneCount}/${agents.length} done`,
    '',
    `<i>${isClosed ? 'Завершено' : 'Обновлено'}: ${renderedAt}</i>`,
  ].join('\n');
}

// ─── Get Agent Statuses ──────────────────────────────────────────────────────

export function getAgentStatuses(agentIds) {
  const statuses = new Map();
  for (const agentId of uniqueAgents(agentIds)) {
    try {
      const raw = redisRaw(['HGETALL', KEYS.agentStatus(agentId)]);
      const status = parseHgetall(raw);
      if (Object.keys(status).length > 0) {
        statuses.set(agentId, status);
      }
    } catch { /* skip */ }
  }
  return statuses;
}

// ─── Get Task Data ───────────────────────────────────────────────────────────

export function getTaskData(taskId) {
  try {
    const raw = redisRaw(['HGETALL', KEYS.taskStatus(taskId)]);
    return parseHgetall(raw);
  } catch {
    return {};
  }
}

// ─── Commands ────────────────────────────────────────────────────────────────

/**
 * task-status-create --task-id <id> --topic-id <id> --title "..." --agents coder,tester --coordinator-id <id> [--owner-id <id>] [--chat-id <id>] [--run-id <id>]
 */
export async function cmdTaskStatusCreate(args) {
  const opts = parseArgs(args);
  const taskId = opts.task_id;
  const topicId = opts.topic_id;
  const title = opts.title;
  const agentsStr = opts.agents;
  const chatId = opts.chat_id || DEFAULT_CHAT_ID;
  const runId = opts.run_id || taskId;
  const coordinatorId = opts.coordinator_id || opts.coordinator;
  const ownerId = opts.owner_id || opts.owner || coordinatorId;
  const closeOwnerId = opts.close_owner_id || opts.close_owner || ownerId;
  const creatorId = opts.creator_id || opts.creator || coordinatorId;

  if (!taskId) throw argError('task-status-create requires --task-id');
  if (!topicId) throw argError('task-status-create requires --topic-id');
  if (!title) throw argError('task-status-create requires --title');
  if (!agentsStr) throw argError('task-status-create requires --agents');
  if (!coordinatorId) throw argError('task-status-create requires --coordinator-id');
  if (!TG_TOKEN) throw argError('OPENCLAW_TELEGRAM_BOT_TOKEN not set');

  const agents = uniqueAgents(agentsStr.split(','));
  if (agents.length === 0) throw argError('--agents must list at least one agent');

  const result = await createTaskStatusMessage(taskId, {
    title,
    agents,
    topic_id: topicId,
    chat_id: chatId,
    run_id: runId,
    coordinator_id: coordinatorId,
    owner_id: ownerId,
    close_owner_id: closeOwnerId,
    creator_id: creatorId,
  });

  if (!result.ok) {
    output(result);
    return;
  }

  output({
    ok: true,
    task_id: taskId,
    message_id: result.message_id,
    topic_id: result.task?.topic_id || topicId,
    chat_id: result.task?.chat_id || chatId,
    coordinator_id: result.task?.coordinator_id || coordinatorId,
    owner_id: result.task?.owner_id || ownerId,
    close_owner_id: result.task?.close_owner_id || closeOwnerId,
    creator_id: result.task?.creator_id || creatorId,
    idempotent: result.idempotent || false,
  });
}

/**
 * task-status-join --task-id <id> --agent-id <agent>
 */
export async function cmdTaskStatusJoin(args) {
  const opts = parseArgs(args);
  const taskId = opts.task_id;
  const agentId = opts.agent_id;

  if (!taskId) throw argError('task-status-join requires --task-id');
  if (!agentId) throw argError('task-status-join requires --agent-id');

  const lockKey = `openclaw:locks:task-status:${taskId}`;

  await withLock(lockKey, async () => {
    const taskData = getTaskData(taskId);
    if (!taskData.message_id) {
      output({ ok: false, error: 'task_not_found', task_id: taskId });
      return;
    }

    if (taskData.status === 'completed' || taskData.status === 'failed') {
      output({ ok: false, error: 'task_closed', task_id: taskId });
      return;
    }

    const agents = uniqueAgents([...parseJson(taskData.agents, []), agentId]);
    persistTaskStatus(taskId, {
      ...taskData,
      agents: JSON.stringify(agents),
      updated_at: new Date().toISOString(),
    });

    output({ ok: true, task_id: taskId, agent_id: agentId, agents });
  });
}

/**
 * task-status-update --task-id <id>
 */
export async function cmdTaskStatusUpdate(args) {
  const opts = parseArgs(args);
  const taskId = opts.task_id;

  if (!taskId) throw argError('task-status-update requires --task-id');
  if (!TG_TOKEN) throw argError('OPENCLAW_TELEGRAM_BOT_TOKEN not set');

  const taskData = getTaskData(taskId);
  if (!taskData.message_id) {
    output({ ok: false, error: 'task_not_found', task_id: taskId });
    return;
  }

  if (taskData.status === 'completed' || taskData.status === 'failed') {
    output({ ok: true, updated: false, reason: 'task_already_closed' });
    return;
  }

  const agents = parseJson(taskData.agents, []);
  const agentStatuses = getAgentStatuses(agents);
  const text = renderTaskStatus(taskData, agentStatuses);

  const editBody = {
    chat_id: taskData.chat_id || DEFAULT_CHAT_ID,
    message_id: parseInt(taskData.message_id, 10),
    text,
    parse_mode: 'HTML',
  };

  const editResult = await tgApiSafe('editMessageText', editBody);
  output({
    ok: true,
    updated: true,
    tg_ok: editResult.ok,
    modified: Boolean(editResult.ok),
    skipped: Boolean(editResult.description?.includes('message is not modified')),
  });
}

/**
 * task-status-close --task-id <id> --result success|fail --actor-id <id>
 */
export async function cmdTaskStatusClose(args) {
  const opts = parseArgs(args);
  const taskId = opts.task_id;
  const result = opts.result || 'success';
  const actorId = opts.actor_id;
  const force = opts.force === true || opts.force === 'true';

  if (!taskId) throw argError('task-status-close requires --task-id');
  if (!actorId) throw argError('task-status-close requires --actor-id');
  if (!TG_TOKEN) throw argError('OPENCLAW_TELEGRAM_BOT_TOKEN not set');

  const taskData = getTaskData(taskId);
  if (!taskData.message_id) {
    output({ ok: false, error: 'task_not_found', task_id: taskId });
    return;
  }

  // Strict ownership: only configured closers can close.
  // Legacy trackers without ownership stay backward-compatible.
  const allowed = new Set(
    [taskData.coordinator_id, taskData.owner_id, taskData.close_owner_id]
      .map(s => String(s || '').trim())
      .filter(Boolean)
  );
  const hasStrictOwnership = allowed.size > 0;
  const actorAllowed = allowed.has(String(actorId || '').trim());

  if (hasStrictOwnership && !actorAllowed) {
    output({ ok: false, error: 'not_closer', task_id: taskId, allowed: [...allowed] });
    process.exitCode = 1;
    return;
  }

  if (!hasStrictOwnership && force) {
    // Legacy fallback: accept --force but preserve original permissive behavior.
  }

  const agents = parseJson(taskData.agents, []);
  const agentStatuses = getAgentStatuses(agents);
  const closeResult = result === 'fail' ? 'fail' : 'success';
  const text = renderTaskStatus(taskData, agentStatuses, closeResult);

  const editBody = {
    chat_id: taskData.chat_id || DEFAULT_CHAT_ID,
    message_id: parseInt(taskData.message_id, 10),
    text,
    parse_mode: 'HTML',
  };

  const editResult = await tgApiSafe('editMessageText', editBody);

  persistTaskStatus(taskId, {
    ...taskData,
    status: closeResult === 'fail' ? 'failed' : 'completed',
    closed_at: new Date().toISOString(),
    closed_by: actorId,
    updated_at: new Date().toISOString(),
  });
  redis('EXPIRE', KEYS.taskStatus(taskId), '3600'); // short TTL on close (1h)

  try {
    redis('XADD', KEYS.eventsStream, '*',
      'type', 'task_status_closed',
      'timestamp', String(Math.floor(Date.now() / 1000)),
      'data', JSON.stringify({ task_id: taskId, run_id: taskData.run_id || taskId, result: closeResult }));
  } catch { /* non-critical */ }

  output({ ok: true, closed: true, result: closeResult, tg_ok: editResult.ok });
}
