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
 *   - Uses existing set-status/heartbeat/reconcile infrastructure (no new Redis keys)
 *
 * Zero npm dependencies. Zero new Redis keys.
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
};

// ─── Active runs registry (in-process) ────────────────────────────────────────

/** @type {Map<string, { timer: NodeJS.Timeout, agentId: string, runId: string }>} */
const activeRuns = new Map();

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
    this.parentRunId = parentRunId || null;
    this._timer = null;
    this._stopped = false;
    this._lastStatusPatch = null;
    this._lastStatusTime = 0;
    this._handleKey = `${agentId}:${this.runId}`;
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
    this._stopped = true;
    this._clearTimer();
    activeRuns.delete(this._handleKey);
  }

  async fail(error) {
    const msg = error instanceof Error ? error.message : String(error || 'неизвестная ошибка');
    // Write status BEFORE stopping (update checks _stopped)
    await this.update({
      state: 'failed',
      step: msg.slice(0, 500),
    });
    this._stopped = true;
    this._clearTimer();
    activeRuns.delete(this._handleKey);
  }

  // ─── Manual stop (without terminal status) ───────────────────────────

  async stop() {
    this._stopped = true;
    this._clearTimer();
    activeRuns.delete(this._handleKey);
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
