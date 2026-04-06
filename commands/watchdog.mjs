/**
 * commands/watchdog.mjs — Orphaned task watchdog
 * Runs as a one-shot check: finds idle tasks and requeues them safely.
 * Designed to be called from cron every 30-60 seconds.
 */
import { withRetry } from '../lib/retry.mjs';
import { redis, redisRaw, parseHgetall, parseXpending, parseXread } from '../lib/redis.mjs';
import { KEYS, GROUPS, now } from '../lib/schema.mjs';
import { output } from '../lib/errors.mjs';
import { writeDaemonHeartbeat } from '../lib/daemon-heartbeat.mjs';

const DEFAULT_IDLE_MS = 300000; // 5 minutes
const MAX_RECOVER = 50;

function readTaskStreamEntry(msgId) {
  const raw = redisRaw(['XRANGE', KEYS.tasksStream, msgId, msgId]);
  const entries = parseXread(raw);
  return entries[0] || null;
}

function buildRequeuedTaskFields(entry) {
  const fields = [];
  for (const [key, value] of Object.entries(entry || {})) {
    if (key === 'id' || value === undefined || value === null) continue;
    fields.push(key, String(value));
  }

  const hasStatus = fields.some((_, index) => index % 2 === 0 && fields[index] === 'status');
  const hasCreatedAt = fields.some((_, index) => index % 2 === 0 && fields[index] === 'created_at');

  if (!hasStatus) fields.push('status', 'pending');
  if (!hasCreatedAt) fields.push('created_at', now());
  return fields;
}

export async function cmdWatchdog(args) {
  writeDaemonHeartbeat('status-watchdog');
  let idleMs = DEFAULT_IDLE_MS;
  let dryRun = false;
  let group = GROUPS.workers;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--idle-ms' && args[i + 1]) {
      const parsed = parseInt(args[i + 1], 10);
      idleMs = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_IDLE_MS;
      i++;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (args[i] === '--group' && args[i + 1]) {
      group = args[i + 1];
      i++;
    }
  }

  const result = await withRetry(() => {
    const raw = redisRaw(['XPENDING', KEYS.tasksStream, group, '-', '+', String(MAX_RECOVER)]);
    const pending = parseXpending(raw);

    if (!pending.length) return { orphaned: 0, recovered: 0, actions: [] };

    const orphaned = pending.filter(p => p.idle_ms > idleMs);
    if (!orphaned.length) return { orphaned: 0, recovered: 0, actions: [] };

    if (dryRun) {
      return {
        orphaned: orphaned.length,
        recovered: 0,
        dry_run: true,
        actions: orphaned.map(p => ({
          msg_id: p.msg_id,
          consumer: p.consumer,
          idle_ms: p.idle_ms,
          action: 'would_requeue',
        })),
      };
    }

    const actions = [];
    for (const entry of orphaned) {
      try {
        const streamEntry = readTaskStreamEntry(entry.msg_id);
        if (!streamEntry?.task_id) {
          actions.push({
            msg_id: entry.msg_id,
            previous_consumer: entry.consumer,
            idle_ms: entry.idle_ms,
            error: 'task_stream_entry_not_found',
          });
          continue;
        }

        const taskId = streamEntry.task_id;
        const resultKey = KEYS.taskResult(taskId);
        const taskResult = parseHgetall(redisRaw(['HGETALL', resultKey]));
        if (taskResult.status === 'done' || taskResult.status === 'failed') {
          try { redis('XACK', KEYS.tasksStream, group, entry.msg_id); } catch { /* best effort */ }
          try { redis('DEL', KEYS.lockTask(taskId)); } catch { /* best effort */ }
          try { redis('ZREM', KEYS.tasksPriority, taskId); } catch { /* best effort */ }
          actions.push({
            msg_id: entry.msg_id,
            task_id: taskId,
            previous_consumer: entry.consumer,
            idle_ms: entry.idle_ms,
            action: 'acked_terminal_task',
            terminal_status: taskResult.status,
          });
          continue;
        }

        const requeuedMsgId = redis('XADD', KEYS.tasksStream, 'MAXLEN', '~', '5000', '*', ...buildRequeuedTaskFields(streamEntry));
        redis('HSET', resultKey,
          'stream_msg_id', requeuedMsgId,
          'stream_group', group,
          'status', 'pending',
          'updated_at', now(),
          'watchdog_requeued_from', entry.msg_id,
        );
        redis('EXPIRE', resultKey, '86400');
        try { redis('XACK', KEYS.tasksStream, group, entry.msg_id); } catch { /* best effort */ }
        try { redis('DEL', KEYS.lockTask(taskId)); } catch { /* best effort */ }

        actions.push({
          msg_id: entry.msg_id,
          task_id: taskId,
          previous_consumer: entry.consumer,
          idle_ms: entry.idle_ms,
          action: 'requeued',
          requeued_msg_id: requeuedMsgId,
          target_agent: streamEntry.target_agent || null,
        });
      } catch (err) {
        actions.push({
          msg_id: entry.msg_id,
          error: String(err.message || err),
        });
      }
    }

    try {
      redis('XADD', KEYS.eventsStream, 'MAXLEN', '~', '10000', '*',
        'type', 'watchdog_cleanup',
        'timestamp', now(),
        'agent', 'watchdog',
        'data', JSON.stringify({ orphaned: orphaned.length, recovered: actions.filter(a => a.action === 'requeued').length }),
      );
    } catch { /* best effort */ }

    return {
      orphaned: orphaned.length,
      recovered: actions.filter(a => a.action === 'requeued').length,
      actions,
    };
  });

  output({ ok: true, group, ...result });
}
