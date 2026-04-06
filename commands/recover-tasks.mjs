/**
 * commands/recover-tasks.mjs — Orphaned task recovery via XCLAIM
 *
 * Scans XPENDING for tasks idle longer than threshold and XCLAIMs them
 * to a cleanup agent so they can be reprocessed.
 */
import { withRetry } from '../lib/retry.mjs';
import { redis, redisRaw, parseXpending } from '../lib/redis.mjs';
import { KEYS, GROUPS } from '../lib/schema.mjs';
import { output, argError } from '../lib/errors.mjs';

const DEFAULT_IDLE_MS = 300000; // 5 minutes
const DEFAULT_AGENT = 'cleanup';

/**
 * ocr recover-tasks [--idle-ms 300000] [--agent cleanup]
 */
export async function cmdRecoverTasks(args) {
  let idleMs = DEFAULT_IDLE_MS;
  let agent = DEFAULT_AGENT;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--idle-ms' && args[i + 1]) {
      const val = parseInt(args[i + 1], 10);
      if (isNaN(val) || val < 0) throw argError('--idle-ms must be a non-negative integer');
      idleMs = val;
      i++;
    } else if (args[i] === '--agent' && args[i + 1]) {
      agent = args[i + 1];
      i++;
    }
  }

  const group = GROUPS.workers;

  const recovered = await withRetry(() => {
    // Get pending entries with details
    const raw = redisRaw(['XPENDING', KEYS.tasksStream, group, '-', '+', '100']);
    const pending = parseXpending(raw);

    if (!pending.length) return [];

    // Filter by idle time
    const orphaned = pending.filter(p => p.idle_ms > idleMs);
    if (!orphaned.length) return [];

    const results = [];
    for (const entry of orphaned) {
      try {
        // XCLAIM the message to the cleanup agent
        const claimResult = redis(
          'XCLAIM', KEYS.tasksStream, group, agent,
          String(idleMs), entry.msg_id
        );
        results.push({
          msg_id: entry.msg_id,
          previous_consumer: entry.consumer,
          idle_ms: entry.idle_ms,
          delivery_count: entry.delivery_count,
          claimed_by: agent,
        });
      } catch (err) {
        // Best effort — skip entries that fail to claim
        results.push({
          msg_id: entry.msg_id,
          error: String(err.message || err),
        });
      }
    }
    return results;
  });

  output({
    ok: true,
    recovered_count: recovered.filter(r => !r.error).length,
    total_scanned: recovered.length,
    idle_threshold_ms: idleMs,
    claim_agent: agent,
    recovered,
  });
}
