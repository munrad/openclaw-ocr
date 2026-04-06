/**
 * commands/tasks.mjs — Task lifecycle commands
 */
import { withRetry } from '../lib/retry.mjs';
import { redis, redisRaw, parseJson, parseHgetall, parseXread, parseXpending } from '../lib/redis.mjs';
import { KEYS, GROUPS, genTaskId, now } from '../lib/schema.mjs';
import { output, argError } from '../lib/errors.mjs';
import { validateAgentId } from '../lib/known-agents.mjs';

export function ensureGroups() {
  // XGROUP CREATE ... MKSTREAM — idempotent (error if already exists, we ignore it)
  try { redis('XGROUP', 'CREATE', KEYS.tasksStream, GROUPS.workers, '0', 'MKSTREAM'); } catch { /* already exists */ }
  try { redis('XGROUP', 'CREATE', KEYS.eventsStream, GROUPS.watchers, '0', 'MKSTREAM'); } catch { /* already exists */ }
}

export async function cmdInit() {
  await withRetry(() => {
    ensureGroups();
    return true;
  });
  output({ ok: true, message: 'Consumer groups initialized', groups: Object.values(GROUPS) });
}

export async function cmdPushTask(jsonArg) {
  if (!jsonArg) throw argError('push-task requires <json>');
  const payload = parseJson(jsonArg);
  if (!payload) throw argError('push-task: invalid JSON');
  if (!payload.type) payload.type = 'general';

  const taskId = genTaskId();
  const priority = payload.priority ?? 50;

  await withRetry(() => {
    // Build XADD fields
    const fields = [
      'task_id', taskId,
      'type', payload.type,
      'priority', String(priority),
      'created_at', now(),
      'status', 'pending',
    ];
    if (payload.target_agent) fields.push('target_agent', payload.target_agent);
    if (payload.repo) fields.push('repo', payload.repo);
    if (payload.payload) fields.push('payload', JSON.stringify(payload.payload));

    const streamMsgId = redis('XADD', KEYS.tasksStream, 'MAXLEN', '~', '5000', '*', ...fields);

    // Save task_id → stream_msg_id mapping so complete-task works without claim
    redis('HSET', KEYS.taskResult(taskId),
      'stream_msg_id', streamMsgId,
      'stream_group', GROUPS.workers,
      'status', 'pending',
      'created_at', now(),
    );
    redis('EXPIRE', KEYS.taskResult(taskId), '86400');

    // Priority sorted set (optional routing)
    if (payload.priority !== undefined) {
      redis('ZADD', KEYS.tasksPriority, String(priority), taskId);
    }
    return true;
  });

  output({ ok: true, task_id: taskId });
}

export async function cmdClaimTask(agentId, group) {
  if (!agentId) throw argError('claim-task requires <agent-id>');
  validateAgentId(agentId, 'claim-task');
  const grp = group || GROUPS.workers;

  /**
   * target_agent filtering strategy:
   * 1. First check our own pending entries (XREADGROUP with '0') — these are
   *    messages previously delivered to us but not ACK'd.
   * 2. Then read new entries from stream (XREADGROUP with '>').
   * 3. For each entry: if target_agent is set and doesn't match agentId,
   *    XCLAIM it to the target consumer so the right agent can pick it up.
   * 4. Take the first matching entry (no target_agent, or target_agent === agentId).
   */
  const matched = await withRetry(() => {
    // Ensure group exists first
    try { redis('XGROUP', 'CREATE', KEYS.tasksStream, grp, '0', 'MKSTREAM'); } catch { /* exists */ }

    // Phase 1: check our own pending entries first
    const pendingRaw = redisRaw([
      'XREADGROUP', 'GROUP', grp, agentId,
      'COUNT', '10',
      'STREAMS', KEYS.tasksStream, '0',
    ]);

    let found = null;
    if (pendingRaw && pendingRaw.trim() && pendingRaw.trim() !== '(nil)' && pendingRaw.trim() !== 'nil') {
      const pendingEntries = parseXread(pendingRaw);
      found = _filterAndReassign(pendingEntries, agentId, grp);
    }

    if (found) return found;

    // Phase 2: read new entries from stream
    const raw = redisRaw([
      'XREADGROUP', 'GROUP', grp, agentId,
      'COUNT', '10',
      'BLOCK', '5000',
      'STREAMS', KEYS.tasksStream, '>',
    ]);

    if (!raw || raw.trim() === '' || raw.trim() === '(nil)' || raw.trim() === 'nil') {
      return null;
    }

    const entries = parseXread(raw);
    if (!entries.length) return null;

    return _filterAndReassign(entries, agentId, grp);
  });

  if (!matched) {
    output({ ok: false, reason: 'no_tasks' }, 1);
    return;
  }

  const taskId = matched.task_id || matched.id;
  const lockKey = KEYS.lockTask(taskId);

  // Try to acquire lock
  const locked = await withRetry(() => redis('SET', lockKey, agentId, 'NX', 'EX', '3600'));
  if (locked !== 'OK') {
    // Another agent got the lock — ACK and skip
    try { redis('XACK', KEYS.tasksStream, grp, matched.id); } catch { /* best effort */ }
    output({ ok: false, reason: 'no_tasks' }, 1);
    return;
  }

  // Keep the claimed entry pending until complete-task/fail-task/watchdog.
  // This preserves recoverability via XPENDING/XCLAIM if the worker crashes.
  const msgId = matched.id;
  // Save msg_id into result hash for complete/fail to use
  try {
    redis('HSET', KEYS.taskResult(taskId), 'stream_msg_id', msgId, 'stream_group', grp);
  } catch { /* best effort */ }

  const payload = matched.payload ? parseJson(matched.payload, matched.payload) : undefined;
  output({
    ok: true,
    task_id: taskId,
    stream_msg_id: msgId,
    type: matched.type,
    target_agent: matched.target_agent,
    priority: matched.priority,
    payload,
  });
}

/**
 * Filter entries by target_agent. Reassign mismatched entries via XCLAIM
 * to the target consumer so the correct agent can pick them up.
 * Returns the first matching entry or null.
 */
function _filterAndReassign(entries, agentId, grp) {
  let found = null;
  for (const entry of entries) {
    const target = entry.target_agent;
    if (!target || target === agentId) {
      if (!found) found = entry;
      // Don't break — continue to reassign remaining mismatched entries
      continue;
    }
    // Mismatch: XCLAIM to target consumer so the right agent sees it in pending
    try {
      redis('XCLAIM', KEYS.tasksStream, grp, target, '0', entry.id);
    } catch { /* best effort — entry stays in our PEL, target agent can still XCLAIM later */ }
  }
  return found;
}

export async function cmdCompleteTask(taskId, jsonArg) {
  if (!taskId) throw argError('complete-task requires <task-id>');
  if (!jsonArg) throw argError('complete-task requires <json>');
  const result = parseJson(jsonArg);
  if (!result) throw argError('complete-task: invalid JSON');

  await withRetry(() => {
    const resultKey = KEYS.taskResult(taskId);

    // Get stream msg id and group from result hash (set during claim)
    const stored = parseHgetall(redisRaw(['HGETALL', resultKey]));

    // Check if task exists (was previously claimed — has stream_msg_id or status)
    if (!stored.stream_msg_id && !stored.status) {
      output({ ok: false, error: 'task not found' }, 1);
      return true;
    }

    // Write result
    const fields = [
      'status', 'done',
      'completed_at', now(),
      'summary', result.summary || '',
    ];
    if (result.artifacts) fields.push('artifacts', JSON.stringify(result.artifacts));
    redis('HSET', resultKey, ...fields);
    redis('EXPIRE', resultKey, '3600'); // short TTL on close (1h)

    // ACK in stream
    if (stored.stream_msg_id && stored.stream_group) {
      try { redis('XACK', KEYS.tasksStream, stored.stream_group, stored.stream_msg_id); } catch { /* best effort */ }
    }

    // Release task lock
    try { redis('DEL', KEYS.lockTask(taskId)); } catch { /* best effort */ }

    // Remove from optional priority index to avoid stale task IDs lingering forever
    try { redis('ZREM', KEYS.tasksPriority, taskId); } catch { /* best effort */ }

    // Emit event
    try {
      redis('XADD', KEYS.eventsStream, 'MAXLEN', '~', '10000', '*',
        'type', 'task_completed',
        'task_id', taskId,
        'agent', result.agent || 'unknown',
        'timestamp', now(),
        'data', JSON.stringify({ summary: result.summary, artifacts: result.artifacts }),
      );
    } catch { /* best effort */ }

    return true;
  });

  output({ ok: true });
}

export async function cmdFailTask(taskId, reason) {
  if (!taskId) throw argError('fail-task requires <task-id>');
  if (!reason) throw argError('fail-task requires <reason>');

  await withRetry(() => {
    const resultKey = KEYS.taskResult(taskId);
    const stored = parseHgetall(redisRaw(['HGETALL', resultKey]));

    // Check if task exists (was previously created/claimed — has stream_msg_id or status)
    if (!stored.stream_msg_id && !stored.status) {
      output({ ok: false, error: 'task not found' }, 1);
      return true;
    }

    redis('HSET', resultKey,
      'status', 'failed',
      'failed_at', now(),
      'reason', reason,
    );
    redis('EXPIRE', resultKey, '3600'); // short TTL on close (1h)

    if (stored.stream_msg_id && stored.stream_group) {
      try { redis('XACK', KEYS.tasksStream, stored.stream_group, stored.stream_msg_id); } catch { /* best effort */ }
    }

    try { redis('DEL', KEYS.lockTask(taskId)); } catch { /* best effort */ }
    try { redis('ZREM', KEYS.tasksPriority, taskId); } catch { /* best effort */ }

    try {
      redis('XADD', KEYS.eventsStream, 'MAXLEN', '~', '10000', '*',
        'type', 'task_failed',
        'task_id', taskId,
        'timestamp', now(),
        'data', JSON.stringify({ reason }),
      );
    } catch { /* best effort */ }

    return true;
  });

  output({ ok: true });
}

export async function cmdListPending(group) {
  const grp = group || GROUPS.workers;

  const result = await withRetry(() => {
    const raw = redisRaw(['XPENDING', KEYS.tasksStream, grp, '-', '+', '50']);
    return raw;
  });

  const pending = parseXpending(result);
  output({ ok: true, group: grp, count: pending.length, pending });
}
