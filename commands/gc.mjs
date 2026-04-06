/**
 * commands/gc.mjs — Garbage collection for stale Redis keys
 *
 * Fallback cleanup for keys that survived past their normal lifecycle
 * (e.g., process crashed between creation and cleanup).
 *
 * Cleans:
 *   - openclaw:pipeline:*          — older than 24h, not in active set
 *   - openclaw:pipeline:by-task:*  — older than 7d (orphaned mappings)
 *   - openclaw:feedback-loop:*     — older than 12h, not in active set
 *   - openclaw:tasks:result:*      — older than 24h
 *   - openclaw:roundtable:*        — older than 48h
 *   - openclaw:task-status:*       — older than 24h, not in active set
 *   - openclaw:bugs:*              — fixed/wontfix older than 30d
 *   - stale consumer groups        — test-pattern groups (qa-*, watchdog-test-*, test-*)
 *   - openclaw:events:stream       — trimmed to 500 entries
 *   - openclaw:tasks:stream        — trimmed to 100 entries
 *
 * Usage: ocr gc [--dry-run]
 */
import { redis, redisRaw, parseHgetall } from '../lib/redis.mjs';
import { KEYS } from '../lib/schema.mjs';
import { output } from '../lib/errors.mjs';

// ─── Thresholds (seconds) ────────────────────────────────────────────────────

const PIPELINE_MAX_AGE     = 24 * 3600;   // 24h
const FEEDBACK_LOOP_MAX_AGE = 12 * 3600;  // 12h
const TASK_RESULT_MAX_AGE  = 24 * 3600;   // 24h
const ROUNDTABLE_MAX_AGE   = 48 * 3600;   // 48h
const TASK_STATUS_MAX_AGE  = 24 * 3600;   // 24h
const BY_TASK_MAX_AGE      = 7 * 24 * 3600; // 7d
const BUG_MAX_AGE          = 30 * 24 * 3600; // 30d (only fixed/wontfix)

const EVENTS_STREAM_MAX    = 500;
const TASKS_STREAM_MAX     = 100;

// Consumer groups that are safe to keep (never delete)
const PROTECTED_GROUPS = new Set(['openclaw-workers', 'openclaw-watchers']);

// ─── Helpers ─────────────────────────────────────────────────────────────────

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * SCAN for keys matching pattern, return array of key strings.
 */
function scanKeys(pattern) {
  const keys = [];
  let cursor = '0';
  do {
    const raw = redisRaw(['SCAN', cursor, 'MATCH', pattern, 'COUNT', '200']);
    const lines = raw.trim().split('\n').map(l => l.trim()).filter(Boolean);
    const cleaned = lines.map(l => l.replace(/^\d+\)\s*/, '').replace(/^"(.*)"$/, '$1'));
    cursor = cleaned[0] || '0';
    for (let i = 1; i < cleaned.length; i++) {
      if (cleaned[i] && cleaned[i] !== '(empty array)' && cleaned[i] !== '(nil)') {
        keys.push(cleaned[i]);
      }
    }
  } while (cursor !== '0');
  return keys;
}

/**
 * Get members of a SET as array.
 */
function setMembers(key) {
  const raw = redisRaw(['SMEMBERS', key]).trim();
  if (!raw || raw === '(empty array)' || raw === '(nil)') return [];
  return raw.split('\n')
    .map(l => l.trim().replace(/^\d+\)\s*/, '').replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
}

/**
 * Try to extract a creation timestamp from a hash key.
 * Looks for created_at field (ISO or unix). Falls back to key ID timestamp.
 */
function getKeyAge(key) {
  try {
    const createdAt = redis('HGET', key, 'created_at');
    if (createdAt && createdAt !== '(nil)') {
      // Try ISO parse
      const d = new Date(createdAt);
      if (!isNaN(d.getTime())) return nowSec() - Math.floor(d.getTime() / 1000);
      // Try unix seconds
      const n = parseInt(createdAt, 10);
      if (n > 1000000000) return nowSec() - n;
    }
  } catch { /* ignore */ }

  // Fallback: extract timestamp from ID (e.g., p-1711234567890-abcd)
  try {
    const parts = key.split(':');
    const id = parts[parts.length - 1];
    const match = id.match(/\w+-(\d{13})-/);
    if (match) return nowSec() - Math.floor(parseInt(match[1], 10) / 1000);
  } catch { /* ignore */ }

  return -1; // unknown age
}

/**
 * Get age of a simple key (STRING type, e.g., pipeline:by-task).
 * Uses TTL as proxy — if TTL is set, we can infer creation time.
 * Falls back to just checking if key exists and is old by TTL remaining.
 */
function getStringKeyAge(key, originalTtl) {
  try {
    const ttl = parseInt(redis('TTL', key), 10);
    if (ttl < 0) return -1; // no TTL or key doesn't exist
    // age = originalTtl - remaining TTL
    return originalTtl - ttl;
  } catch { return -1; }
}

// ─── GC Logic ────────────────────────────────────────────────────────────────

export async function cmdGc(args) {
  const dryRun = args.includes('--dry-run');
  const summary = {
    pipelines: 0,
    pipeline_by_task: 0,
    feedback_loops: 0,
    task_results: 0,
    task_priority_members: 0,
    roundtables: 0,
    roundtable_rounds: 0,
    task_statuses: 0,
    bugs: 0,
    consumer_groups: 0,
    events_trimmed: 0,
    tasks_trimmed: 0,
  };

  // ── 1. Pipelines ──
  const activePipelines = new Set(setMembers(KEYS.pipelinesActive));
  const pipelineKeys = scanKeys('openclaw:pipeline:p-*');
  for (const key of pipelineKeys) {
    const id = key.replace('openclaw:pipeline:', '');
    if (activePipelines.has(id)) continue;
    const age = getKeyAge(key);
    if (age < 0 || age < PIPELINE_MAX_AGE) continue;
    if (!dryRun) redis('DEL', key);
    summary.pipelines++;
  }

  // ── 2. Pipeline by-task mappings ──
  const byTaskKeys = scanKeys('openclaw:pipeline:by-task:*');
  for (const key of byTaskKeys) {
    const age = getStringKeyAge(key, 604800); // original TTL was 7d
    // If TTL is gone or age > threshold, clean up
    // Also clean keys with no TTL (orphaned)
    const ttl = parseInt(redis('TTL', key), 10);
    if (ttl === -1) {
      // No TTL set — orphaned, delete
      if (!dryRun) redis('DEL', key);
      summary.pipeline_by_task++;
    } else if (ttl === -2) {
      // Key doesn't exist, skip
    }
    // Keys with TTL will expire on their own — skip
  }

  // ── 3. Feedback loops ──
  const activeLoops = new Set(setMembers(KEYS.feedbackLoopsActive));
  const loopKeys = scanKeys('openclaw:feedback-loop:fl-*');
  for (const key of loopKeys) {
    const id = key.replace('openclaw:feedback-loop:', '');
    if (activeLoops.has(id)) continue;
    const age = getKeyAge(key);
    if (age < 0 || age < FEEDBACK_LOOP_MAX_AGE) continue;
    if (!dryRun) redis('DEL', key);
    summary.feedback_loops++;
  }

  // ── 4. Task results ──
  const resultKeys = scanKeys('openclaw:tasks:result:*');
  for (const key of resultKeys) {
    const age = getKeyAge(key);
    if (age < 0 || age < TASK_RESULT_MAX_AGE) continue;
    // Also check: if it already has a TTL, Redis will handle it — but if TTL
    // is missing (orphaned), we clean it up
    const ttl = parseInt(redis('TTL', key), 10);
    if (ttl > 0) continue; // has active TTL, will self-expire
    if (!dryRun) redis('DEL', key);
    summary.task_results++;
  }

  // ── 4b. Task priority index hygiene ──
  try {
    const raw = redisRaw(['ZRANGE', KEYS.tasksPriority, '0', '-1']).trim();
    const members = !raw || raw === '(empty array)' || raw === '(nil)'
      ? []
      : raw.split('\n').map(l => l.trim().replace(/^\d+\)\s*/, '').replace(/^"(.*)"$/, '$1')).filter(Boolean);

    for (const taskId of members) {
      const result = parseHgetall(redisRaw(['HGETALL', KEYS.taskResult(taskId)]));
      if (!result.status || result.status === 'done' || result.status === 'failed') {
        if (!dryRun) redis('ZREM', KEYS.tasksPriority, taskId);
        summary.task_priority_members++;
      }
    }
  } catch { /* best effort */ }

  // ── 5. Roundtables ──
  const rtKeys = scanKeys('openclaw:roundtable:rt-*');
  for (const key of rtKeys) {
    if (key.endsWith(':rounds')) continue; // handle separately
    const id = key.replace('openclaw:roundtable:', '');
    const age = getKeyAge(key);
    if (age < 0 || age < ROUNDTABLE_MAX_AGE) continue;
    if (!dryRun) {
      redis('DEL', key);
      // Also delete associated :rounds stream
      try { redis('DEL', `${key}:rounds`); } catch { /* best effort */ }
    }
    summary.roundtables++;
  }

  // Orphaned :rounds keys (roundtable hash already deleted)
  const roundsKeys = scanKeys('openclaw:roundtable:*:rounds');
  for (const key of roundsKeys) {
    const hashKey = key.replace(':rounds', '');
    const exists = redis('EXISTS', hashKey);
    if (exists === '1' || exists === 1) continue; // parent exists, skip
    if (!dryRun) redis('DEL', key);
    summary.roundtable_rounds++;
  }

  // ── 6. Task statuses ──
  const activeStatuses = new Set(setMembers(KEYS.taskStatusActive));
  const tsKeys = scanKeys('openclaw:task-status:*');
  for (const key of tsKeys) {
    if (key === KEYS.taskStatusActive) continue; // skip the active set itself
    const id = key.replace('openclaw:task-status:', '');
    if (activeStatuses.has(id)) continue;
    const age = getKeyAge(key);
    if (age < 0 || age < TASK_STATUS_MAX_AGE) continue;
    if (!dryRun) redis('DEL', key);
    summary.task_statuses++;
  }

  // ── 7. Closed bugs (fixed/wontfix older than 30d) ──
  for (const setKey of ['openclaw:bugs:fixed', 'openclaw:bugs:wontfix']) {
    try {
      const raw = redisRaw(['ZRANGE', setKey, '0', '-1']).trim();
      const members = !raw || raw === '(empty array)' || raw === '(nil)'
        ? []
        : raw.split('\n').map(l => l.trim().replace(/^\d+\)\s*/, '').replace(/^"(.*)"$/, '$1')).filter(Boolean);
      for (const bugId of members) {
        const bugKey = `openclaw:bugs:${bugId}`;
        const age = getKeyAge(bugKey);
        if (age < 0 || age < BUG_MAX_AGE) continue;
        if (!dryRun) {
          redis('DEL', bugKey);
          redis('ZREM', setKey, bugId);
        }
        summary.bugs++;
      }
    } catch { /* best effort */ }
  }

  // ── 8. Stale test consumer groups ──
  try {
    const raw = redisRaw(['XINFO', 'GROUPS', KEYS.tasksStream]);
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    // XINFO GROUPS returns repeating blocks of key-value pairs.
    // Format: "name\n<group-name>\nconsumers\n<N>\n..." (plain) or numbered.
    // Extract group names by finding "name" key followed by its value.
    const groups = [];
    for (let i = 0; i < lines.length - 1; i++) {
      const key = lines[i].replace(/^\d+\)\s*/, '').replace(/^"(.*)"$/, '$1');
      if (key === 'name') {
        const val = lines[i + 1].replace(/^\d+\)\s*/, '').replace(/^"(.*)"$/, '$1');
        if (val && val !== 'name') groups.push(val);
      }
    }
    for (const name of groups) {
      if (PROTECTED_GROUPS.has(name)) continue;
      // Only destroy groups matching test patterns
      if (/^(qa-|wdg-|watchdog-test-|test-)/.test(name)) {
        if (!dryRun) {
          try { redis('XGROUP', 'DESTROY', KEYS.tasksStream, name); } catch { /* best effort */ }
        }
        summary.consumer_groups++;
      }
    }
  } catch { /* stream may not exist or no groups */ }

  // ── 9. Trim streams ──
  try {
    const evtsBefore = redis('XLEN', KEYS.eventsStream);
    if (!dryRun) redis('XTRIM', KEYS.eventsStream, 'MAXLEN', '~', String(EVENTS_STREAM_MAX));
    const evtsAfter = dryRun ? evtsBefore : redis('XLEN', KEYS.eventsStream);
    summary.events_trimmed = Math.max(0, parseInt(evtsBefore, 10) - parseInt(evtsAfter, 10));
  } catch { /* stream may not exist */ }

  try {
    const tasksBefore = redis('XLEN', KEYS.tasksStream);
    if (!dryRun) redis('XTRIM', KEYS.tasksStream, 'MAXLEN', '~', String(TASKS_STREAM_MAX));
    const tasksAfter = dryRun ? tasksBefore : redis('XLEN', KEYS.tasksStream);
    summary.tasks_trimmed = Math.max(0, parseInt(tasksBefore, 10) - parseInt(tasksAfter, 10));
  } catch { /* stream may not exist */ }

  // ── Summary ──
  const total = Object.values(summary).reduce((a, b) => a + b, 0);

  output({
    ok: true,
    dry_run: dryRun,
    deleted: summary,
    total_cleaned: total,
    message: dryRun
      ? `[dry-run] Would clean ${total} keys/entries`
      : `Cleaned ${total} keys/entries`,
  });
}
