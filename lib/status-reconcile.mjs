/**
 * lib/status-reconcile.mjs — shared agent status lifecycle reconcile logic
 *
 * Single owner for technical lifecycle transitions:
 * - completed/failed -> idle
 * - active-like + missing heartbeat -> stale
 * - stale + missing heartbeat -> idle
 */
import { redis, redisRaw, parseHgetall } from './redis.mjs';
import { KEYS, KNOWN_AGENTS, now } from './schema.mjs';
import { publishStatusNotify } from './pubsub.mjs';

export const DEFAULT_RECONCILE_THRESHOLDS = {
  autoIdleMs: 30_000,
  activeStaleGraceMs: 120_000,
  staleToIdleMs: 10 * 60_000,
};

export const ACTIVE_LIKE_STATES = new Set(['queued', 'spawned', 'starting', 'working', 'blocked', 'waiting', 'reviewing', 'testing']);

export function isActiveLike(state) {
  return ACTIVE_LIKE_STATES.has(state);
}

export function toTimestamp(updatedAt) {
  if (!updatedAt) return null;
  const raw = String(updatedAt).trim();
  if (!raw) return null;
  const ts = parseInt(raw.split('-')[0], 10);
  return Number.isFinite(ts) && ts > 0 ? ts : null;
}

export function ageMs(updatedAt, nowMs = Date.now()) {
  const ts = toTimestamp(updatedAt);
  return ts !== null ? Math.max(0, nowMs - (ts * 1000)) : null;
}

export function heartbeatTtl(agentId) {
  try {
    const ttl = parseInt(redis('TTL', KEYS.heartbeat(agentId)), 10);
    return Number.isFinite(ttl) ? ttl : -2;
  } catch {
    return -2;
  }
}

export function hasLiveHeartbeat(agentId) {
  return heartbeatTtl(agentId) > 0;
}

export function getAllAgentStatuses(agentIds = KNOWN_AGENTS) {
  const statuses = new Map();
  for (const agentId of agentIds) {
    try {
      const raw = redisRaw(['HGETALL', KEYS.agentStatus(agentId)]);
      const status = parseHgetall(raw);
      if (Object.keys(status).length > 0) {
        statuses.set(agentId, status);
      }
    } catch {
      // skip best-effort reads
    }
  }
  return statuses;
}

function buildIncidentMetadata(decision) {
  const base = {
    type: decision.eventType,
    timestamp: now(),
    agent: decision.agentId,
    data: JSON.stringify({
      agent_id: decision.agentId,
      previous_state: decision.previousState,
      next_state: decision.nextState,
      reason: decision.reason,
      last_update_age_ms: decision.lastUpdateAgeMs,
      heartbeat_alive: decision.heartbeatAlive,
      marker: decision.markerName,
    }),
  };

  return base;
}

export function reconcileAgentStatus(agentId, status, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const heartbeatAlive = options.heartbeatAlive ?? hasLiveHeartbeat(agentId);
  const thresholds = {
    ...DEFAULT_RECONCILE_THRESHOLDS,
    ...(options.thresholds || {}),
  };

  const state = status.state || 'idle';
  const lastUpdateAgeMs = ageMs(status.updated_at, nowMs);

  // Phase 7: epoch fencing — if run_epoch is newer than what we saw at read time,
  // a live writer is actively updating; skip reconcile to avoid overwriting.
  const readRunEpoch = parseInt(status.run_epoch || '0', 10);
  if (readRunEpoch > 0 && options._readRunEpoch !== undefined) {
    // _readRunEpoch is set by reconcileAllStatuses to detect concurrent writes
    if (readRunEpoch > options._readRunEpoch) {
      return {
        changed: false,
        agentId,
        previousState: state,
        nextState: state,
        heartbeatAlive,
        lastUpdateAgeMs,
        reason: 'epoch_fence_skip',
        message: `${agentId} run_epoch ${readRunEpoch} > read snapshot ${options._readRunEpoch}, live writer detected — skipping`,
      };
    }
  }

  if (lastUpdateAgeMs === null) {
    return {
      changed: false,
      agentId,
      previousState: state,
      nextState: state,
      heartbeatAlive,
      lastUpdateAgeMs: null,
      reason: 'skip_invalid_updated_at',
      message: `${agentId} state=${state} has invalid updated_at, skipping time-based reconcile`,
    };
  }

  if ((state === 'completed' || state === 'failed') && lastUpdateAgeMs > thresholds.autoIdleMs) {
    const patch = { state: 'idle', step: '' };
    const failedCleanupMarker = 'failed_idle_cleanup';
    const shouldMarkFailedCleanup = state === 'failed';

    if (shouldMarkFailedCleanup) {
      patch.last_incident_marker = failedCleanupMarker;
    }

    return {
      changed: true,
      agentId,
      previousState: state,
      nextState: 'idle',
      reason: state === 'failed' ? 'failed_cleanup_to_idle' : 'auto_idle_terminal',
      heartbeatAlive,
      lastUpdateAgeMs,
      patch,
      eventType: shouldMarkFailedCleanup ? 'agent_failed_cleaned_up' : null,
      markerName: shouldMarkFailedCleanup ? failedCleanupMarker : null,
      message: `${agentId} was ${state} for ${Math.round(lastUpdateAgeMs / 1000)}s, resetting to idle`,
    };
  }

  if (isActiveLike(state) && !heartbeatAlive && lastUpdateAgeMs > thresholds.activeStaleGraceMs) {
    const degradedReason = 'missing_heartbeat_active_to_stale';
    const degradedMarker = 'degraded_missing_heartbeat';
    return {
      changed: true,
      agentId,
      previousState: state,
      nextState: 'stale',
      reason: degradedReason,
      heartbeatAlive,
      lastUpdateAgeMs,
      patch: {
        state: 'stale',
        last_degraded_at: now(),
        last_degraded_reason: degradedReason,
        last_incident_marker: degradedMarker,
      },
      eventType: 'agent_status_degraded',
      markerName: degradedMarker,
      message: `${agentId} state=${state} age=${Math.round(lastUpdateAgeMs / 1000)}s heartbeat=missing, marking stale`,
    };
  }

  if (state === 'stale' && !heartbeatAlive && lastUpdateAgeMs > thresholds.staleToIdleMs) {
    const staleAutoIdleMarker = 'stale_auto_idle';
    return {
      changed: true,
      agentId,
      previousState: state,
      nextState: 'idle',
      reason: 'stale_cleanup_to_idle',
      heartbeatAlive,
      lastUpdateAgeMs,
      patch: {
        state: 'idle',
        step: '',
        last_auto_idle_at: now(),
        last_incident_marker: staleAutoIdleMarker,
      },
      eventType: 'agent_auto_idled',
      markerName: staleAutoIdleMarker,
      message: `${agentId} remained stale for ${Math.round(lastUpdateAgeMs / 1000)}s, resetting to idle`,
    };
  }

  return {
    changed: false,
    agentId,
    previousState: state,
    nextState: state,
    heartbeatAlive,
    lastUpdateAgeMs,
  };
}

export function writeAgentStatus(agentId, patch, options = {}) {
  const ts = now();
  const sanitizedPatch = { ...patch };
  delete sanitizedPatch.updated_at;

  // Phase 7: stamp reconcile_epoch so set-status can detect stale writers
  const reconcileEpoch = String(Date.now());
  const fields = ['updated_at', ts, 'reconcile_epoch', reconcileEpoch];
  for (const [key, value] of Object.entries(sanitizedPatch)) {
    fields.push(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }

  redis('HSET', KEYS.agentStatus(agentId), ...fields);

  const extraEvents = Array.isArray(options.extraEvents) ? options.extraEvents : [];
  for (const event of extraEvents) {
    if (!event?.type) continue;
    redis('XADD', KEYS.eventsStream, 'MAXLEN', '~', '10000', '*',
      'type', event.type,
      'timestamp', event.timestamp || ts,
      'agent', agentId,
      'data', event.data || JSON.stringify({ agent_id: agentId })
    );
  }

  redis('XADD', KEYS.eventsStream, 'MAXLEN', '~', '10000', '*',
    'type', 'agent_status_changed',
    'timestamp', ts,
    'agent', agentId,
    'data', JSON.stringify({ ...sanitizedPatch, agent_id: agentId })
  );

  // Phase 8: Pub/Sub fast-path notify (fire-and-forget, after hash + stream write)
  publishStatusNotify({
    agent: agentId,
    state: sanitizedPatch.state || '',
    step: sanitizedPatch.step || '',
    run_epoch: sanitizedPatch.run_epoch || reconcileEpoch,
    updated_at: ts,
  });

  return ts;
}

export function reconcileAllStatuses(options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const thresholds = {
    ...DEFAULT_RECONCILE_THRESHOLDS,
    ...(options.thresholds || {}),
  };
  const agentIds = options.agentIds || KNOWN_AGENTS;
  const dryRun = Boolean(options.dryRun);
  const logger = typeof options.logger === 'function' ? options.logger : null;
  const statuses = options.statuses || getAllAgentStatuses(agentIds);

  const actions = [];

  for (const agentId of agentIds) {
    const status = statuses.get(agentId);
    if (!status) continue;

    // Phase 7: pass the run_epoch we read at snapshot time for fencing
    const readRunEpoch = parseInt(status.run_epoch || '0', 10);
    const decision = reconcileAgentStatus(agentId, status, { nowMs, thresholds, _readRunEpoch: readRunEpoch });
    if (!decision.changed) continue;

    // Phase 7: re-check run_epoch before write to detect concurrent writer
    if (readRunEpoch > 0 && !dryRun) {
      try {
        const freshEpochRaw = redisRaw(['HGET', KEYS.agentStatus(agentId), 'run_epoch']);
        const freshEpoch = parseInt((freshEpochRaw || '').replace(/"/g, '').trim() || '0', 10);
        if (freshEpoch > readRunEpoch) {
          if (logger) logger(`${agentId}: epoch fence — run_epoch changed ${readRunEpoch}→${freshEpoch}, skipping write`);
          continue;
        }
      } catch {
        // best-effort fence check, proceed if redis fails
      }
    }

    if (logger) logger(decision.message);

    let updatedAt = null;
    if (!dryRun) {
      const extraEvents = decision.eventType ? [buildIncidentMetadata(decision)] : [];
      updatedAt = writeAgentStatus(agentId, decision.patch, { extraEvents });
    }

    actions.push({
      ...decision,
      updatedAt,
      resultingStatus: {
        ...status,
        ...decision.patch,
        updated_at: updatedAt || String(Math.floor(nowMs / 1000)),
      },
    });
  }

  return {
    ok: true,
    dryRun,
    checkedAgents: agentIds.length,
    changed: actions.length,
    actions,
    thresholds,
  };
}
