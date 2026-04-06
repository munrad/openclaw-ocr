/**
 * commands/agents.mjs — Agent state commands
 */
import { withRetry } from '../lib/retry.mjs';
import { redis, redisRaw, parseJson, parseHgetall } from '../lib/redis.mjs';
import { KEYS, now } from '../lib/schema.mjs';
import { output, argError } from '../lib/errors.mjs';
import { validateAgentId } from '../lib/known-agents.mjs';
import { isActiveLike } from '../lib/status-reconcile.mjs';
import { publishStatusNotify } from '../lib/pubsub.mjs';

const VALID_STATES = ['idle', 'queued', 'spawned', 'starting', 'working', 'blocked', 'waiting', 'reviewing', 'testing', 'completed', 'failed', 'stale'];

function normalizeRunId(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function getNextState(currentStatus, nextStatus) {
  return nextStatus.state || currentStatus.state || 'idle';
}

function getStaleResurrectionBlock(agentId, currentStatus, nextStatus) {
  const currentState = currentStatus.state || 'idle';
  const nextState = getNextState(currentStatus, nextStatus);

  if (currentState !== 'stale') return null;
  if (nextState === 'stale' || nextState === 'idle') return null;
  if (!isActiveLike(nextState) && nextState !== 'completed' && nextState !== 'failed' && nextState !== 'blocked') {
    return null;
  }

  const currentRunId = normalizeRunId(currentStatus.run_id);
  const incomingRunId = normalizeRunId(nextStatus.run_id);

  if (currentRunId && incomingRunId === currentRunId) return null;

  return {
    ok: false,
    reason: 'stale_resurrection_guard',
    message: currentRunId
      ? `refusing to overwrite stale snapshot for ${agentId} without matching run_id`
      : `refusing to overwrite stale snapshot for ${agentId} without ownership proof; reset to idle first`,
    agent_id: agentId,
    current_state: currentState,
    requested_state: nextState,
    required_run_id: currentRunId || null,
    provided_run_id: incomingRunId || null,
  };
}

export async function cmdSetStatus(agentId, jsonArg) {
  if (!agentId) throw argError('set-status requires <agent-id>');
  validateAgentId(agentId, 'set-status');
  if (!jsonArg) throw argError('set-status requires <json>');
  const status = parseJson(jsonArg);
  if (!status) throw argError('set-status: invalid JSON');

  // Validate state enum if present (strict reject)
  if (status.state && !VALID_STATES.includes(status.state)) {
    throw argError(`invalid state '${status.state}', valid: ${VALID_STATES.join(', ')}`);
  }

  const currentRaw = await withRetry(() => redisRaw(['HGETALL', KEYS.agentStatus(agentId)]));
  const currentStatus = parseHgetall(currentRaw);
  const blocked = getStaleResurrectionBlock(agentId, currentStatus, status);
  if (blocked) {
    output(blocked, 1);
    return;
  }

  // Phase 7: run_epoch — auto-generate if not provided
  if (!status.run_epoch) {
    status.run_epoch = String(Date.now());
  }

  // Phase 7: stale resurrection epoch guard
  // If agent was auto-idled (last_incident_marker=stale_auto_idle) and writer tries
  // to go active with run_epoch <= reconcile_epoch, reject (stale writer resurrection).
  const currentReconcileEpoch = parseInt(currentStatus.reconcile_epoch || '0', 10);
  const incomingRunEpoch = parseInt(status.run_epoch || '0', 10);
  if (
    currentStatus.state === 'idle' &&
    currentStatus.last_incident_marker === 'stale_auto_idle' &&
    isActiveLike(status.state) &&
    currentReconcileEpoch > 0 &&
    incomingRunEpoch > 0 &&
    incomingRunEpoch <= currentReconcileEpoch
  ) {
    output({
      ok: false,
      reason: 'epoch_stale_resurrection',
      message: `run_epoch ${incomingRunEpoch} <= reconcile_epoch ${currentReconcileEpoch}: stale writer resurrection blocked for ${agentId}`,
      agent_id: agentId,
      run_epoch: incomingRunEpoch,
      reconcile_epoch: currentReconcileEpoch,
    }, 1);
    return;
  }

  const ts = now();
  const statusPatch = { ...status };
  delete statusPatch.updated_at;

  await withRetry(() => {
    const fields = ['updated_at', ts];
    for (const [k, v] of Object.entries(statusPatch)) {
      fields.push(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    redis('HSET', KEYS.agentStatus(agentId), ...fields);
    return true;
  });

  // Emit agent_status_changed event
  await withRetry(() => {
    redis('XADD', KEYS.eventsStream, 'MAXLEN', '~', '10000', '*',
      'type', 'agent_status_changed',
      'timestamp', ts,
      'agent', agentId,
      'data', JSON.stringify({ ...statusPatch, agent_id: agentId })
    );
    return true;
  });

  // Phase 8: Pub/Sub fast-path notify (fire-and-forget, after hash + stream write)
  publishStatusNotify({
    agent: agentId,
    state: statusPatch.state || '',
    step: statusPatch.step || '',
    run_epoch: statusPatch.run_epoch || '',
    updated_at: ts,
  });

  output({ ok: true });
}

export async function cmdGetStatus(agentId) {
  if (!agentId) throw argError('get-status requires <agent-id>');
  validateAgentId(agentId, 'get-status');

  const raw = await withRetry(() => redisRaw(['HGETALL', KEYS.agentStatus(agentId)]));
  const status = parseHgetall(raw);

  if (!Object.keys(status).length) {
    output({ ok: false, reason: 'not_found' }, 1);
    return;
  }

  output({ ok: true, agent_id: agentId, status });
}

export async function cmdHeartbeat(agentId) {
  if (!agentId) throw argError('heartbeat requires <agent-id>');
  validateAgentId(agentId, 'heartbeat');

  await withRetry(() => {
    redis('SET', KEYS.heartbeat(agentId), 'alive', 'EX', '60');
    return true;
  });

  output({ ok: true, agent_id: agentId, ttl: 60 });
}
