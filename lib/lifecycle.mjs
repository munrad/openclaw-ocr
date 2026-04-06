/**
 * lib/lifecycle.mjs — Agent run lifecycle runtime
 *
 * Provides automated heartbeat keepalive and status lifecycle management
 * for agent runs. Eliminates dependency on prompt-layer discipline by
 * offering programmatic lifecycle wrappers.
 *
 * Architecture:
 *   - LifecycleManager: per-run heartbeat loop + status updates
 *   - withLifecycle(): async wrapper that auto-manages start/heartbeat/finish
 *   - Uses existing set-status/heartbeat/reconcile infrastructure plus
 *     Redis-backed run registration for cross-process stop requests
 *
 * Zero npm dependencies.
 */

import { withRetry } from './retry.mjs';
import { redis, redisRaw, parseHgetall, parseJson } from './redis.mjs';
import { KEYS, now } from './schema.mjs';
import { validateAgentId } from './known-agents.mjs';
import { publishStatusNotify } from './pubsub.mjs';

// ─── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULTS = {
  heartbeatMs: 25000,
  heartbeatTtl: 60,
  statusDebounceMs: 2000,
  controlPollMs: 1000,
  registrationTtlSec: 600,
  stopRequestTtlSec: 300,
};

// ─── Active runs registry (in-process) ────────────────────────────────────────

/** @type {Map<string, { timer: NodeJS.Timeout, agentId: string, runId: string }>} */
const activeRuns = new Map();

function lifecycleRegistration(agentId, runId) {
  return KEYS.lifecycleRun(agentId, runId);
}

function lifecycleAgentRuns(agentId) {
  return KEYS.lifecycleRunsByAgent(agentId);
}

function lifecycleStopKey(agentId, runId) {
  return KEYS.lifecycleStopRequest(agentId, runId);
}

function readHash(key) {
  try {
    return parseHgetall(redisRaw(['HGETALL', key]));
  } catch {
    return {};
  }
}

function deleteLifecycleRegistration(agentId, runId) {
  try { redis('DEL', lifecycleRegistration(agentId, runId)); } catch {}
  try { redis('DEL', lifecycleStopKey(agentId, runId)); } catch {}
  try { redis('SREM', lifecycleAgentRuns(agentId), runId); } catch {}
}

function writeLifecycleRegistration({
  agentId,
  runId,
  runEpoch,
  state,
  step = '',
  ownerPid = process.pid,
}) {
  const ts = now();
  const key = lifecycleRegistration(agentId, runId);
  const fields = [
    'agent_id', agentId,
    'run_id', runId,
    'run_epoch', runEpoch,
    'state', state,
    'step', step,
    'owner_pid', String(ownerPid),
    'updated_at', ts,
  ];

  try {
    redis('HSET', key, ...fields);
    redis('EXPIRE', key, String(DEFAULTS.registrationTtlSec));
    redis('SADD', lifecycleAgentRuns(agentId), runId);
  } catch { /* best effort */ }
}

function touchLifecycleRegistration({
  agentId,
  runId,
  runEpoch,
  state,
  step = '',
}) {
  writeLifecycleRegistration({ agentId, runId, runEpoch, state, step });
}

// ─── Heartbeat ───────────────────────────────────────────────────────────────

/**
 * Send a single heartbeat for the agent.
 * Fire-and-forget — errors are logged but never thrown.
 */
export function sendHeartbeat(agentId) {
  try {
    withRetry(() => {
      redis('SET', KEYS.heartbeat(agentId), 'alive', 'EX', String(DEFAULTS.heartbeatTtl));
      return true;
    }).catch(() => { /* best effort */ });
  } catch { /* guard against sync throws in withRetry */ }
}

// ─── Status write (internal, low-level) ──────────────────────────────────────

/**
 * Write agent status hash + event + pubsub notify.
 * Reuses the same pattern as commands/agents.mjs cmdSetStatus but without
 * stale resurrection guards (lifecycle owner always has valid run_epoch).
 */
async function writeStatus(agentId, patch) {
  const ts = now();
  const sanitizedPatch = { ...patch };
  delete sanitizedPatch.updated_at;

  await withRetry(() => {
    const fields = ['updated_at', ts];
    for (const [k, v] of Object.entries(sanitizedPatch)) {
      fields.push(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    redis('HSET', KEYS.agentStatus(agentId), ...fields);
    return true;
  });

  // Event stream
  try {
    await withRetry(() => {
      redis('XADD', KEYS.eventsStream, 'MAXLEN', '~', '10000', '*',
        'type', 'agent_status_changed',
        'timestamp', ts,
        'agent', agentId,
        'data', JSON.stringify({ ...sanitizedPatch, agent_id: agentId })
      );
      return true;
    });
  } catch { /* best effort */ }

  // Pub/Sub fast-path
  publishStatusNotify({
    agent: agentId,
    state: sanitizedPatch.state || '',
    step: sanitizedPatch.step || '',
    run_epoch: sanitizedPatch.run_epoch || '',
    updated_at: ts,
  });
}

// ─── LifecycleManager (per-run) ─────────────────────────────────────────────

export class LifecycleManager {
  /**
   * @param {object} opts
   * @param {string} opts.agentId
   * @param {string} [opts.runId]
   * @param {string} [opts.step]
   * @param {number} [opts.heartbeatMs]
   * @param {boolean} [opts.validateAgent]
   */
  constructor({ agentId, runId, step, heartbeatMs, validateAgent = true, parentRunId } = {}) {
    if (!agentId) throw new Error('LifecycleManager requires agentId');
    if (validateAgent) validateAgentId(agentId, 'lifecycle');

    this.agentId = agentId;
    this.runId = runId || `lifecycle-${Date.now()}`;
    this.runEpoch = String(Date.now());
    this.heartbeatMs = heartbeatMs || DEFAULTS.heartbeatMs;
    this.controlPollMs = Math.max(250, Math.min(DEFAULTS.controlPollMs, Math.floor(this.heartbeatMs / 4) || DEFAULTS.controlPollMs));
    this.parentRunId = parentRunId || null;
    this._timer = null;
    this._controlTimer = null;
    this._stopped = false;
    this._remoteStopInFlight = false;
    this._registrationEnabled = false;
    this._lastStatusPatch = null;
    this._lastStatusTime = 0;
    this._handleKey = `${agentId}:${this.runId}`;
    this._shutdownInfo = null;
    this._shutdownPromise = new Promise((resolve) => {
      this._resolveShutdown = resolve;
    });
  }

  /** Unique handle for this lifecycle run */
  get handle() {
    return this._handleKey;
  }

  // ─── Start ────────────────────────────────────────────────────────────

  /**
   * Start the lifecycle: set initial status + begin heartbeat loop.
   */
  async start(initialStep) {
    if (this._stopped) return;

    const patch = {
      state: 'starting',
      step: initialStep || 'инициализация',
      run_id: this.runId,
      run_epoch: this.runEpoch,
    };

    await writeStatus(this.agentId, patch);
    try { redis('DEL', lifecycleStopKey(this.agentId, this.runId)); } catch {}
    this._registrationEnabled = true;
    touchLifecycleRegistration({
      agentId: this.agentId,
      runId: this.runId,
      runEpoch: this.runEpoch,
      state: patch.state,
      step: patch.step,
    });

    // Parent-child tracking
    if (this.parentRunId) {
      try {
        redis('HSET', KEYS.agentStatus(this.agentId), 'parent_run_id', this.parentRunId);
        redis('SADD', KEYS.agentChildren(this.parentRunId), this.agentId);
        redis('SET', KEYS.agentParent(this.agentId), this.parentRunId, 'EX', '86400');
      } catch { /* best effort */ }
    }

    this._lastStatusPatch = patch;
    this._lastStatusTime = Date.now();

    sendHeartbeat(this.agentId);

    // Register in active runs
    activeRuns.set(this._handleKey, {
      timer: null, // set below
      agentId: this.agentId,
      runId: this.runId,
    });

    // Start heartbeat loop
    this._timer = setInterval(() => {
      if (!this._stopped) {
        sendHeartbeat(this.agentId);
      }
    }, this.heartbeatMs);

    // Allow process to exit even if timer is running
    if (this._timer.unref) this._timer.unref();

    const entry = activeRuns.get(this._handleKey);
    if (entry) entry.timer = this._timer;

    this._controlTimer = setInterval(() => {
      if (this._stopped) return;
      touchLifecycleRegistration({
        agentId: this.agentId,
        runId: this.runId,
        runEpoch: this.runEpoch,
        state: this._lastStatusPatch?.state || patch.state,
        step: this._lastStatusPatch?.step || patch.step,
      });
      this._pollRemoteStop().catch(() => { /* best effort */ });
    }, this.controlPollMs);
    if (this._controlTimer.unref) this._controlTimer.unref();
  }

  // ─── Status updates ──────────────────────────────────────────────────

  /**
   * Update status. Debounced — identical patches within statusDebounceMs are skipped.
   * @param {object} patch - { state, step, progress, blocked_by }
   */
  async update(patch) {
    if (this._stopped) return;

    const fullPatch = {
      ...patch,
      run_id: this.runId,
      run_epoch: this.runEpoch,
    };

    // Dedup: skip if patch is identical to last and within debounce window
    const now = Date.now();
    const patchKey = JSON.stringify(fullPatch);
    if (patchKey === JSON.stringify(this._lastStatusPatch) && now - this._lastStatusTime < DEFAULTS.statusDebounceMs) {
      return;
    }

    await writeStatus(this.agentId, fullPatch);
    this._lastStatusPatch = fullPatch;
    this._lastStatusTime = now;
    if (this._registrationEnabled) {
      touchLifecycleRegistration({
        agentId: this.agentId,
        runId: this.runId,
        runEpoch: this.runEpoch,
        state: fullPatch.state || this._lastStatusPatch?.state || '',
        step: fullPatch.step || '',
      });
    }
  }

  // ─── Convenience methods ─────────────────────────────────────────────

  async working(step, progress) {
    const patch = { state: 'working', step: step || '' };
    if (progress !== undefined) patch.progress = progress;
    return this.update(patch);
  }

  async waiting(step) {
    return this.update({ state: 'waiting', step: step || 'ожидание' });
  }

  async blocked(step, blockedBy) {
    const patch = { state: 'blocked', step: step || 'блокировка' };
    if (blockedBy) patch.blocked_by = blockedBy;
    return this.update(patch);
  }

  async reviewing(step) {
    return this.update({ state: 'reviewing', step: step || 'ревью' });
  }

  async testing(step) {
    return this.update({ state: 'testing', step: step || 'тестирование' });
  }

  // ─── Finish ──────────────────────────────────────────────────────────

  async complete(step) {
    await this.update({
      state: 'completed',
      step: step || 'завершено',
      progress: 100,
    });
    this._markShutdown({ source: 'complete', state: 'completed' });
    this._stopped = true;
    this._clearTimer();
    activeRuns.delete(this._handleKey);
    if (this._registrationEnabled) deleteLifecycleRegistration(this.agentId, this.runId);
  }

  async fail(error) {
    const msg = error instanceof Error ? error.message : String(error || 'неизвестная ошибка');
    // Write status BEFORE stopping (update checks _stopped)
    await this.update({
      state: 'failed',
      step: msg.slice(0, 500),
    });
    this._markShutdown({ source: 'fail', state: 'failed', error: msg });
    this._stopped = true;
    this._clearTimer();
    activeRuns.delete(this._handleKey);
    if (this._registrationEnabled) deleteLifecycleRegistration(this.agentId, this.runId);
  }

  // ─── Manual stop (without terminal status) ───────────────────────────

  async stop() {
    this._markShutdown({ source: 'stop', state: 'stopped' });
    this._stopped = true;
    this._clearTimer();
    activeRuns.delete(this._handleKey);
    if (this._registrationEnabled) deleteLifecycleRegistration(this.agentId, this.runId);
  }

  waitForShutdown() {
    return this._shutdownPromise;
  }

  // ─── Heartbeat on demand ────────────────────────────────────────────

  beat() {
    if (!this._stopped) sendHeartbeat(this.agentId);
  }

  // ─── Internal ────────────────────────────────────────────────────────

  _clearTimer() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._controlTimer) {
      clearInterval(this._controlTimer);
      this._controlTimer = null;
    }
  }

  _markShutdown(info) {
    if (this._shutdownInfo) return;
    this._shutdownInfo = info;
    this._resolveShutdown?.(info);
  }

  async _pollRemoteStop() {
    if (this._remoteStopInFlight || this._stopped) return;

    const request = readHash(lifecycleStopKey(this.agentId, this.runId));
    if (!Object.keys(request).length) return;

    this._remoteStopInFlight = true;
    try {
      const requestedStatus = String(request.status || 'completed').trim().toLowerCase();
      const requestedStep = String(request.step || '').trim();
      const requestedError = String(request.error || '').trim();

      if (requestedStatus === 'failed') {
        await this.fail(requestedError || requestedStep || 'remote lifecycle stop');
      } else if (requestedStatus === 'stopped') {
        await this.stop();
      } else {
        await this.complete(requestedStep || 'remote lifecycle stop');
      }
      this._markShutdown({
        source: 'remote_stop',
        state: requestedStatus || 'completed',
        request_id: request.request_id || '',
      });
    } finally {
      this._remoteStopInFlight = false;
    }
  }
}

// ─── withLifecycle (wrapper) ─────────────────────────────────────────────────

/**
 * Async wrapper that manages full agent lifecycle automatically.
 *
 * Usage:
 *   const result = await withLifecycle(
 *     { agentId: 'devops', runId: 'task-123', step: 'старт' },
 *     async (life) => {
 *       await life.working('читаю конфиг', 10);
 *       await life.waiting('жду ответ от API');
 *       await life.working('обрабатываю', 50);
 *       return 'done';
 *     }
 *   );
 *
 * Guarantees:
 *   - heartbeat loop runs during execution
 *   - final status is always written (completed/failed)
 *   - timer is always cleaned up (even on throw)
 *
 * @param {object} opts - { agentId, runId?, step?, heartbeatMs? }
 * @param {function(LifecycleManager): Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withLifecycle(opts, fn) {
  const life = new LifecycleManager(opts);
  await life.start(opts.step);

  try {
    const result = await fn(life);
    if (resolveLifecycleFinalAction({ stopped: life._stopped, error: null }) === 'complete') {
      await life.complete(opts.completeStep || 'completed');
    }
    return result;
  } catch (err) {
    if (resolveLifecycleFinalAction({ stopped: life._stopped, error: err }) === 'fail') {
      await life.fail(err);
    }
    throw err;
  } finally {
    // Ensure cleanup even if complete()/fail() threw
    if (!life._stopped) {
      await life.fail('lifecycle cleanup: unexpected exit');
    }
  }
}

export function resolveLifecycleFinalAction({ stopped, error }) {
  if (stopped) return 'noop';
  return error ? 'fail' : 'complete';
}

// ─── Global active runs query ────────────────────────────────────────────────

/**
 * List all currently active lifecycle runs in this process.
 * Useful for monitoring/debugging.
 */
export function listActiveRuns() {
  return [...activeRuns.entries()].map(([key, val]) => ({
    handle: key,
    agentId: val.agentId,
    runId: val.runId,
    hasTimer: !!val.timer,
  }));
}

/**
 * Stop all active lifecycle runs. Useful for graceful shutdown.
 */
export function stopAllRuns() {
  for (const [key, val] of activeRuns) {
    if (val.timer) clearInterval(val.timer);
    activeRuns.delete(key);
  }
}

export function listRegisteredRuns(agentId) {
  const agentIds = agentId
    ? [agentId]
    : [];

  if (!agentIds.length) return [];

  const runs = [];
  for (const currentAgentId of agentIds) {
    let runIds = [];
    try {
      runIds = redisRaw(['SMEMBERS', lifecycleAgentRuns(currentAgentId)])
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      runIds = [];
    }

    for (const runId of runIds) {
      const data = readHash(lifecycleRegistration(currentAgentId, runId));
      if (!Object.keys(data).length) {
        try { redis('SREM', lifecycleAgentRuns(currentAgentId), runId); } catch {}
        continue;
      }
      runs.push({
        agentId: currentAgentId,
        runId,
        state: data.state || '',
        step: data.step || '',
        runEpoch: data.run_epoch || '',
        ownerPid: data.owner_pid || '',
        updatedAt: data.updated_at || '',
      });
    }
  }

  return runs;
}

export function requestLifecycleStop({ agentId, runId, status = 'completed', step = '', error = '' }) {
  if (!agentId) throw new Error('requestLifecycleStop requires agentId');
  if (!runId) throw new Error('requestLifecycleStop requires runId');

  const requestId = `${Date.now()}-${process.pid}`;
  const fields = [
    'agent_id', agentId,
    'run_id', runId,
    'status', String(status || 'completed'),
    'step', String(step || ''),
    'error', String(error || ''),
    'request_id', requestId,
    'requested_at', now(),
  ];

  redis('HSET', lifecycleStopKey(agentId, runId), ...fields);
  redis('EXPIRE', lifecycleStopKey(agentId, runId), String(DEFAULTS.stopRequestTtlSec));

  return { requestId };
}

export async function writeTerminalStatusDirect({ agentId, runId, status = 'completed', step = '', error = '' }) {
  const current = readHash(KEYS.agentStatus(agentId));
  const targetRunId = String(runId || current.run_id || '').trim() || `lifecycle-stop-${Date.now()}`;
  const targetRunEpoch = String(current.run_epoch || Date.now());

  const patch = {
    state: status === 'failed' ? 'failed' : status,
    step: status === 'failed'
      ? String(error || step || 'remote lifecycle stop failed')
      : String(step || 'remote lifecycle stop'),
    run_id: targetRunId,
    run_epoch: targetRunEpoch,
  };

  if (status !== 'failed') patch.progress = 100;

  await writeStatus(agentId, patch);
  deleteLifecycleRegistration(agentId, targetRunId);

  return {
    agentId,
    runId: targetRunId,
    runEpoch: targetRunEpoch,
    status: patch.state,
    direct: true,
  };
}
