#!/usr/bin/env node
/**
 * task-status-watcher.mjs — Auto-updates task-scoped status messages.
 *
 * Contract (v3.1 — spawn bootstrap):
 *   - Watcher may bootstrap a task-status tracker only from explicit agent_spawned events
 *     that carry OCR/task-status context (run_id/task_id + delivery metadata).
 *   - Watcher NEVER invents a tracker from an unknown run_id during plain status replay.
 *   - Watcher NEVER closes tasks (coordinator/owner does via task-status-close)
 *   - Watcher updates TG messages + auto-joins agents by run_id match.
 *
 * Signal sources:
 *   Primary: Redis Pub/Sub notifications from agent status writes
 *   Fallback: Redis events stream (XREAD) + periodic refresh (30s)
 *
 * Usage: node task-status-watcher.mjs
 * Env: OPENCLAW_TELEGRAM_BOT_TOKEN, REDIS_HOST, REDIS_PORT, REDIS_PASSWORD
 */

import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { redis, redisRaw, parseHgetall, parseJson } from './lib/redis.mjs';
import { KEYS } from './lib/schema.mjs';
import { CONFIG } from './lib/config.mjs';
import {
  DEFAULT_CHAT_ID,
  ensureTaskStatusTracker,
  getAgentStatuses,
  getTaskData,
  persistTaskStatus,
  renderTaskStatus,
  tgApiSafe,
  topicParams,
} from './commands/task-status.mjs';
import { isPubSubEnabled, subscribeStatusNotify } from './lib/pubsub.mjs';
import { writeDaemonHeartbeat } from './lib/daemon-heartbeat.mjs';

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() == '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// ─── Config ──────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = envNumber('OCR_TASK_STATUS_WATCHER_DEBOUNCE_MS', 3000);
const PERIODIC_REFRESH_MS = envNumber('OCR_TASK_STATUS_WATCHER_PERIODIC_REFRESH_MS', 30_000);
const XREAD_BLOCK_MS = envNumber('OCR_TASK_STATUS_WATCHER_XREAD_BLOCK_MS', 5000);
const STREAM_SPAWN_BOOTSTRAP_MAX_AGE_MS = envNumber('OCR_TASK_STATUS_WATCHER_STREAM_SPAWN_BOOTSTRAP_MAX_AGE_MS', 120000);
const WATCHER_LAST_EVENT_ID_KEY = 'openclaw:task-status-watcher:last_event_id';
const IMMUTABLE_BINDING_FIELDS = ['coordinator_id', 'owner_id', 'close_owner_id', 'creator_id'];

// S2 fix: bootstrap_pending recovery — retry TG sendMessage for trackers
// stuck in bootstrap_pending after this many minutes.
const BOOTSTRAP_PENDING_STALE_MIN = envNumber('OCR_TASK_STATUS_BOOTSTRAP_PENDING_STALE_MIN', 3);
const BOOTSTRAP_PENDING_MAX_RETRIES = Math.max(0, Math.floor(envNumber('OCR_TASK_STATUS_BOOTSTRAP_PENDING_MAX_RETRIES', 2)));
// bootstrap_retry_count semantics: number of recovery attempts made by the watcher
// (increments on both success and failure).

// ─── State ───────────────────────────────────────────────────────────────────

let running = true;
let lastEventId = '0-0';
let debounceTimer = null;
let pubsubSubscription = null;
const pendingTaskIds = new Set();
let lastPeriodicRefresh = Date.now();

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  process.stderr.write(`[task-status-watcher ${ts}] ${msg}\n`);
}

// ─── Redis Helpers ───────────────────────────────────────────────────────────

function getActiveTaskIds() {
  try {
    const raw = redisRaw(['SMEMBERS', KEYS.taskStatusActive]);
    const ids = raw.split('\n').map(l => l.trim()).filter(Boolean);
    // Prune expired trackers: if hash was deleted by TTL, remove from active set
    const alive = [];
    for (const id of ids) {
      try {
        const exists = redisRaw(['EXISTS', KEYS.taskStatus(id)]);
        if (exists.trim() === '0') {
          redis('SREM', KEYS.taskStatusActive, id);
          log(`Pruned expired tracker from active set: ${id}`);
          continue;
        }
      } catch { /* keep it if check fails */ }
      alive.push(id);
    }
    return alive;
  } catch {
    return [];
  }
}

function getAgentStatus(agentId) {
  try {
    const raw = redisRaw(['HGETALL', KEYS.agentStatus(agentId)]);
    return parseHgetall(raw);
  } catch {
    return {};
  }
}

function buildAgentIndex() {
  const index = new Map(); // agentId -> Set<taskId>
  const taskIds = getActiveTaskIds();
  for (const taskId of taskIds) {
    const taskData = getTaskData(taskId);
    const agents = parseJson(taskData.agents, []);
    for (const agentId of agents) {
      if (!index.has(agentId)) index.set(agentId, new Set());
      index.get(agentId).add(taskId);
    }
  }
  return index;
}

function uniqueAgents(agents) {
  return [...new Set((agents || []).map(a => String(a || '').trim()).filter(Boolean))];
}

function preserveWatcherBindings(taskId, nextTaskData = {}) {
  const latestTaskData = getTaskData(taskId);
  const mergedTaskData = { ...nextTaskData };

  for (const field of IMMUTABLE_BINDING_FIELDS) {
    const latestValue = String(latestTaskData[field] || '').trim();
    if (latestValue) {
      mergedTaskData[field] = latestValue;
    }
  }

  return mergedTaskData;
}

export function parseEventTimestampMs(eventMeta = {}, eventData = {}) {
  const candidates = [eventMeta.id, eventMeta.timestamp, eventData.timestamp];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    const raw = String(candidate).trim();
    if (!raw) continue;

    if (/^\d+-\d+$/.test(raw)) {
      const [msPart] = raw.split('-');
      const ms = Number(msPart);
      if (Number.isFinite(ms)) return ms;
      continue;
    }

    if (/^\d+$/.test(raw)) {
      const numeric = Number(raw);
      if (!Number.isFinite(numeric)) continue;
      return raw.length <= 10 ? numeric * 1000 : numeric;
    }

    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function shouldBootstrapSpawnFromStream(eventData = {}, eventMeta = {}) {
  const eventTsMs = parseEventTimestampMs(eventMeta, eventData);
  if (!Number.isFinite(eventTsMs)) return false;
  return (Date.now() - eventTsMs) <= STREAM_SPAWN_BOOTSTRAP_MAX_AGE_MS;
}

// ─── XREAD Block ─────────────────────────────────────────────────────────────

function xreadBlock(streamKey, lastId, blockMs) {
  return new Promise((resolve) => {
    const args = [
      '-h', CONFIG.host,
      '-p', CONFIG.port,
      '--no-auth-warning',
    ];
    if (CONFIG.password) args.push('-a', CONFIG.password);
    args.push('XREAD', 'COUNT', '100', 'BLOCK', String(blockMs),
      'STREAMS', streamKey, lastId);

    const proc = spawn('redis-cli', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';

    proc.stdout.on('data', (d) => { stdout += d; });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve([]);
    }, blockMs + 10_000);

    proc.on('close', () => {
      clearTimeout(timer);
      const raw = stdout.trim();
      if (!raw || raw === '(nil)') { resolve([]); return; }
      try { resolve(parseXreadRaw(raw)); }
      catch { resolve([]); }
    });

    proc.on('error', () => {
      clearTimeout(timer);
      resolve([]);
    });
  });
}

function parseXreadRaw(raw) {
  const entries = [];
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].replace(/^\d+\)\s*/, '').replace(/^"(.*)"$/, '$1');
    if (/^\d+-\d+$/.test(line)) {
      const id = line;
      const fields = {};
      i++;
      const fieldLines = [];
      while (i < lines.length) {
        const next = lines[i].replace(/^\d+\)\s*/, '').replace(/^"(.*)"$/, '$1');
        if (/^\d+-\d+$/.test(next)) break;
        fieldLines.push(next);
        i++;
      }
      for (let j = 0; j < fieldLines.length - 1; j += 2) {
        fields[fieldLines[j]] = fieldLines[j + 1];
      }
      if (fields.data) fields.data = parseJson(fields.data, fields.data);
      entries.push({ id, ...fields });
    } else {
      i++;
    }
  }
  return entries;
}

// ─── Auto-Join: append agent to task if run_id matches ───────────────────────

function tryAutoJoin(agentId) {
  const status = getAgentStatus(agentId);
  if (!Object.keys(status).length) return [];

  const runId = String(status.run_id || '').trim();
  if (!runId) return [];

  const taskData = getTaskData(runId);
  if (!taskData.message_id) return [];
  if (taskData.status === 'completed' || taskData.status === 'failed') return [];

  // Append agent to agents[] if not already present
  const agents = uniqueAgents(parseJson(taskData.agents, []));
  if (!agents.includes(agentId)) {
    const updated = uniqueAgents([...agents, agentId]);
    persistTaskStatus(runId, preserveWatcherBindings(runId, {
      ...taskData,
      agents: JSON.stringify(updated),
      updated_at: new Date().toISOString(),
    }));
    log(`Auto-joined ${agentId} to task ${runId}`);
  }

  return [runId];
}

// ─── Bootstrap Pending Recovery (S2) ─────────────────────────────────────────

async function recoverStaleBootstrapPending() {
  const taskIds = getActiveTaskIds();
  for (const taskId of taskIds) {
    const taskData = getTaskData(taskId);
    if (taskData.bootstrap_pending !== '1' && taskData.bootstrap_pending !== 1) continue;
    if (taskData.message_id) continue; // already recovered
    if (taskData.status === 'completed' || taskData.status === 'failed') continue;

    const createdAt = taskData.created_at ? new Date(taskData.created_at) : null;
    if (!createdAt || isNaN(createdAt.getTime())) {
      log(`bootstrap_pending recovery: ${taskId} has no valid created_at, skipping`);
      continue;
    }
    const ageMin = (Date.now() - createdAt.getTime()) / 60_000;
    if (ageMin < BOOTSTRAP_PENDING_STALE_MIN) continue;

    const retryCount = parseInt(taskData.bootstrap_retry_count || '0', 10);
    if (retryCount >= BOOTSTRAP_PENDING_MAX_RETRIES) {
      log(`bootstrap_pending recovery: ${taskId} exhausted ${BOOTSTRAP_PENDING_MAX_RETRIES} retries, giving up`);
      continue;
    }

    log(`bootstrap_pending recovery: retrying TG sendMessage for ${taskId} (attempt ${retryCount + 1}/${BOOTSTRAP_PENDING_MAX_RETRIES}, age ${ageMin.toFixed(1)}min)`);

    const agents = parseJson(taskData.agents, []);
    const agentStatuses = getAgentStatuses(agents);
    const text = renderTaskStatus(taskData, agentStatuses);

    const sendBody = {
      chat_id: taskData.chat_id || DEFAULT_CHAT_ID,
      text,
      parse_mode: 'HTML',
      ...topicParams(taskData.topic_id),
      disable_notification: true,
    };

    const sendResult = await tgApiSafe('sendMessage', sendBody);
    if (sendResult.ok) {
      const messageId = String(sendResult.result.message_id);
      // bootstrap_retry_count counts recovery *attempts* (success increments too).
      persistTaskStatus(taskId, preserveWatcherBindings(taskId, {
        ...taskData,
        message_id: messageId,
        bootstrap_pending: '0',
        bootstrap_retry_count: String(retryCount + 1),
        updated_at: new Date().toISOString(),
      }));
      log(`bootstrap_pending recovery: ${taskId} recovered, message_id=${messageId}`);
    } else {
      persistTaskStatus(taskId, preserveWatcherBindings(taskId, {
        ...taskData,
        bootstrap_retry_count: String(retryCount + 1),
        updated_at: new Date().toISOString(),
      }));
      log(`bootstrap_pending recovery: ${taskId} TG sendMessage failed (attempt ${retryCount + 1}): ${sendResult.description || 'unknown'}`);
    }
  }
}

// ─── Update TG Message ───────────────────────────────────────────────────────

async function updateTask(taskId) {
  const taskData = getTaskData(taskId);
  if (!taskData.message_id) return;
  if (taskData.status === 'completed' || taskData.status === 'failed') return;
  // TODO: phantom detection (delivery_unconfirmed) deferred to a future phase.
  // The delivery_status field is never set today; when implemented, sendMessage
  // results should be verified and delivery_unconfirmed set on ambiguous outcomes.

  const agents = parseJson(taskData.agents, []);
  const agentStatuses = getAgentStatuses(agents);
  const text = renderTaskStatus(taskData, agentStatuses);

  const editBody = {
    chat_id: taskData.chat_id || DEFAULT_CHAT_ID,
    message_id: parseInt(taskData.message_id, 10),
    text,
    parse_mode: 'HTML',
  };

  const tgResult = await tgApiSafe('editMessageText', editBody);

  if (tgResult.ok) {
    log(`Updated task ${taskId}`);
  } else if (tgResult.description?.includes('message is not modified')) {
    log(`Skipped no-op task refresh ${taskId}`);
  } else {
    log(`TG edit failed for ${taskId}: ${tgResult.description || 'unknown error'}`);
  }
}

// ─── Signal Handling ─────────────────────────────────────────────────────────

function scheduleDebouncedUpdate() {
  if (debounceTimer) return;
  debounceTimer = setTimeout(async () => {
    debounceTimer = null;
    const ids = [...pendingTaskIds];
    pendingTaskIds.clear();
    for (const taskId of ids) {
      try { await updateTask(taskId); }
      catch (err) { log(`Error updating task ${taskId}: ${err.message}`); }
    }
  }, DEBOUNCE_MS);
}

async function handleStatusSignal(agentId, eventData = {}, source = 'unknown', eventType = 'agent_status_changed', eventMeta = {}) {
  if (!agentId) return;

  const normalizedRunId = String(eventData.run_id || eventData.task_id || '').trim();
  if (eventType === 'agent_spawned' && normalizedRunId) {
    const allowBootstrap = source !== 'stream' || shouldBootstrapSpawnFromStream(eventData, eventMeta);
    if (allowBootstrap) {
      const bootstrapped = await ensureTaskStatusTracker(normalizedRunId, {
        ...eventData,
        agent_id: agentId,
      });
      if (bootstrapped?.ok) {
        pendingTaskIds.add(normalizedRunId);
        log(`Bootstrap ${normalizedRunId} via ${source}:${eventType} (created=${bootstrapped.created ? 'yes' : 'no'})`);
      }
    } else {
      log(`Skip historical bootstrap ${normalizedRunId} via ${source}:${eventType}`);
    }
    // Track parent-child relationship if parent_run_id present
    const parentRunId = eventData.parent_run_id;
    if (parentRunId) {
      try {
        redis('SADD', KEYS.agentChildren(parentRunId), agentId);
      } catch { /* best effort */ }
    }
  }

  // Auto-join: if agent's run_id matches an active task, append agent
  const joined = tryAutoJoin(agentId);
  for (const taskId of joined) pendingTaskIds.add(taskId);

  // Also schedule updates for tasks this agent is already a member of
  const agentIndex = buildAgentIndex();
  if (agentIndex.has(agentId)) {
    for (const taskId of agentIndex.get(agentId)) {
      pendingTaskIds.add(taskId);
    }
  }

  if (pendingTaskIds.size > 0) {
    scheduleDebouncedUpdate();
  }
}

// ─── Pub/Sub ─────────────────────────────────────────────────────────────────

function initPubSub() {
  if (!isPubSubEnabled()) {
    log('Pub/Sub: disabled, relying on XREAD fallback');
    return;
  }

  log('Pub/Sub: enabled — subscribing as primary signal');
  pubsubSubscription = subscribeStatusNotify((payload) => {
    const agentId = payload.agent || payload.agent_id;
    handleStatusSignal(agentId, payload, 'pubsub').catch((err) => {
      log(`Pub/Sub handler error for ${agentId || '?'}: ${err.message}`);
    });
  }, log);
  log(`Pub/Sub: subscriber started (pid=${pubsubSubscription.pid})`);
}

// ─── Main Loop ───────────────────────────────────────────────────────────────

async function mainLoop() {
  log('Starting task-status-watcher (v3 strict-only, append+update only)...');

  if (!process.env.OPENCLAW_TELEGRAM_BOT_TOKEN) {
    log('ERROR: OPENCLAW_TELEGRAM_BOT_TOKEN not set');
    process.exit(1);
  }

  try {
    const savedId = redis('GET', WATCHER_LAST_EVENT_ID_KEY);
    if (savedId && /^\d+-\d+$/.test(savedId)) {
      lastEventId = savedId;
      log(`Restored last event ID: ${lastEventId}`);
    }
  } catch { /* start from beginning */ }

  initPubSub();

  // S2: recover stale bootstrap_pending trackers on startup as well.
  // This makes watcher restarts converge quickly without waiting for the
  // periodic refresh timer.
  try { await recoverStaleBootstrapPending(); }
  catch (err) { log(`bootstrap_pending recovery error (startup): ${err.message}`); }

  while (running) {
    try {
      const entries = await xreadBlock(KEYS.eventsStream, lastEventId, XREAD_BLOCK_MS);
      writeDaemonHeartbeat('task-status-watcher');

      for (const entry of entries) {
        lastEventId = entry.id;
        if (!['agent_spawned', 'agent_status_changed', 'agent_status_degraded', 'agent_auto_idled', 'agent_ended'].includes(entry.type)) {
          continue;
        }
        const data = typeof entry.data === 'string' ? parseJson(entry.data, {}) : (entry.data || {});
        const agentId = data.agent_id || entry.agent;
        await handleStatusSignal(agentId, data, 'stream', entry.type, {
          id: entry.id,
          timestamp: entry.timestamp,
        });
      }

      if (entries.length > 0) {
        try {
          redis('SET', WATCHER_LAST_EVENT_ID_KEY, lastEventId);
        } catch { /* non-critical */ }
      }

      if (Date.now() - lastPeriodicRefresh > PERIODIC_REFRESH_MS) {
        lastPeriodicRefresh = Date.now();
        for (const taskId of getActiveTaskIds()) {
          pendingTaskIds.add(taskId);
        }
        if (pendingTaskIds.size > 0) {
          log('Periodic refresh: scheduling safety-net update');
          scheduleDebouncedUpdate();
        }
        // S2: recover stale bootstrap_pending trackers
        try { await recoverStaleBootstrapPending(); }
        catch (err) { log(`bootstrap_pending recovery error: ${err.message}`); }
      }
    } catch (err) {
      log(`Loop error: ${err.message}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

function installSignalHandlers() {
  process.on('SIGINT', () => {
    running = false;
    try { pubsubSubscription?.close(); } catch { /* ignore */ }
    log('SIGINT received');
  });
  process.on('SIGTERM', () => {
    running = false;
    try { pubsubSubscription?.close(); } catch { /* ignore */ }
    log('SIGTERM received');
  });
}

let watcherStartPromise = null;

export function startTaskStatusWatcher({ installSignals = true } = {}) {
  if (!watcherStartPromise) {
    if (installSignals) installSignalHandlers();
    watcherStartPromise = mainLoop().catch((err) => {
      watcherStartPromise = null;
      throw err;
    });
  }
  return watcherStartPromise;
}

const isMainModule = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMainModule) {
  startTaskStatusWatcher().catch(err => {
    log(`Fatal: ${err.message}`);
    process.exit(1);
  });
}
