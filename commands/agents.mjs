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
const STATUS_HYGIENE_CANONICAL_FIELDS = new Set([
  'state',
  'step',
  'status',
  'progress',
  'updated_at',
  'run_id',
  'run_epoch',
  'reconcile_epoch',
  'parent_run_id',
  'bootstrapped_by',
  'last_degraded_at',
  'last_degraded_reason',
  'last_incident_marker',
  'last_auto_idle_at',
]);

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

function scanAgentStatusIds() {
  const raw = redisRaw(['--scan', '--pattern', 'openclaw:agents:status:*']).trim();
  if (!raw) return [];
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((key) => key.replace(/^openclaw:agents:status:/, ''));
}

function analyzeAgentStatusHygiene(agentId, status = {}) {
  const suspiciousFields = [];
  for (const [field, value] of Object.entries(status)) {
    const normalizedField = String(field || '').trim();
    const normalizedValue = String(value || '').trim();
    if (!normalizedField || STATUS_HYGIENE_CANONICAL_FIELDS.has(normalizedField)) continue;

    if (/^\d{10,}$/.test(normalizedField) && (!normalizedValue || STATUS_HYGIENE_CANONICAL_FIELDS.has(normalizedValue))) {
      suspiciousFields.push({
        field: normalizedField,
        value: normalizedValue,
        reason: 'numeric_legacy_artifact',
      });
      continue;
    }

    if (
      STATUS_HYGIENE_CANONICAL_FIELDS.has(normalizedValue)
      && Object.prototype.hasOwnProperty.call(status, normalizedValue)
    ) {
      suspiciousFields.push({
        field: normalizedField,
        value: normalizedValue,
        reason: 'mirrored_legacy_artifact',
      });
    }
  }

  return {
    agent_id: agentId,
    suspicious_fields: suspiciousFields,
    suspicious_field_count: suspiciousFields.length,
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

export async function cmdStatusHygiene(args) {
  const opts = parseArgs(args);
  const apply = opts.apply === true || opts.apply === 'true';
  const requestedAgents = [
    ...String(opts.agent || '').split(','),
    ...String(opts.agents || '').split(','),
  ].map((agentId) => String(agentId || '').trim()).filter(Boolean);

  const agentIds = requestedAgents.length > 0
    ? [...new Set(requestedAgents)]
    : scanAgentStatusIds();

  const findings = [];
  let suspiciousFieldsTotal = 0;
  let removedFieldsTotal = 0;

  for (const agentId of agentIds) {
    const status = parseHgetall(redisRaw(['HGETALL', KEYS.agentStatus(agentId)]));
    if (!Object.keys(status).length) continue;

    const report = analyzeAgentStatusHygiene(agentId, status);
    if (report.suspicious_field_count === 0) continue;

    suspiciousFieldsTotal += report.suspicious_field_count;
    if (apply) {
      const fieldsToRemove = report.suspicious_fields.map((entry) => entry.field);
      if (fieldsToRemove.length > 0) {
        redis('HDEL', KEYS.agentStatus(agentId), ...fieldsToRemove);
        removedFieldsTotal += fieldsToRemove.length;
      }
    }

    findings.push(report);
  }

  output({
    ok: true,
    dry_run: !apply,
    scanned_agents: agentIds.length,
    affected_agents: findings.length,
    suspicious_fields_total: suspiciousFieldsTotal,
    removed_fields_total: removedFieldsTotal,
    agents: findings,
  });
}
