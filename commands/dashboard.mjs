/**
 * commands/dashboard.mjs — Unified system status dashboard
 */
import { withRetry } from '../lib/retry.mjs';
import { redis, redisRaw, parseHgetall, parseXpending } from '../lib/redis.mjs';
import { KEYS, GROUPS, KNOWN_AGENTS } from '../lib/schema.mjs';
import { output } from '../lib/errors.mjs';

export async function cmdDashboard() {
  const timestamp = new Date().toISOString();

  // 1. Agent statuses + heartbeats
  const agents = await withRetry(() => {
    return KNOWN_AGENTS.map(id => {
      let status = {};
      try {
        const raw = redisRaw(['HGETALL', KEYS.agentStatus(id)]);
        status = parseHgetall(raw);
      } catch { /* best effort */ }

      let alive = false;
      try {
        const exists = redis('EXISTS', KEYS.heartbeat(id));
        alive = exists === '1' || exists === 1;
      } catch { /* best effort */ }

      return { id, status, alive };
    });
  });

  // 2. Pending tasks
  let pending_tasks = { count: 0, tasks: [] };
  try {
    const grp = GROUPS.workers;
    const raw = redisRaw(['XPENDING', KEYS.tasksStream, grp, '-', '+', '50']);
    const tasks = parseXpending(raw);
    pending_tasks = { count: tasks.length, tasks };
  } catch { /* best effort */ }

  // 3. Insights counts
  let insights = { pending: 0, promoted: 0 };
  try {
    const pending = redis('ZCARD', KEYS.INSIGHTS);
    const promoted = redis('ZCARD', KEYS.INSIGHTS_PROMOTED);
    insights = {
      pending: parseInt(pending, 10) || 0,
      promoted: parseInt(promoted, 10) || 0,
    };
  } catch { /* best effort */ }

  // 4. Restart messages count
  let restart_messages = 0;
  try {
    const count = redis('LLEN', KEYS.restartMessages);
    restart_messages = parseInt(count, 10) || 0;
  } catch { /* best effort */ }

  output({ ok: true, agents, pending_tasks, insights, restart_messages, timestamp });
}
