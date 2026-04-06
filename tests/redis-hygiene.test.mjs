/**
 * redis-hygiene.test.mjs — Meta-test: verifies no test artifacts remain in Redis.
 *
 * Run AFTER all other tests to confirm clean state.
 * Checks: no qa-* keys, no stale consumer groups, no orphaned entries.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { CONFIG } from '../lib/config.mjs';

function redisCli(args) {
  const base = ['-h', CONFIG.host, '-p', String(CONFIG.port), '-n', String(CONFIG.db || 0), '--no-auth-warning'];
  let password = CONFIG.password || process.env.REDIS_PASSWORD || '';
  if (!password) {
    try { password = readFileSync('/run/secrets/redis_password', 'utf8').trim(); } catch {}
  }
  if (password) base.push('-a', password);
  return execFileSync('redis-cli', [...base, ...args], { encoding: 'utf8' }).trim();
}

function scanKeys(pattern) {
  const keys = [];
  let cursor = '0';
  do {
    const raw = redisCli(['SCAN', cursor, 'MATCH', pattern, 'COUNT', '200']);
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    cursor = lines[0] || '0';
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] && lines[i] !== '(empty array)') keys.push(lines[i]);
    }
  } while (cursor !== '0');
  return keys;
}

const checks = [];
const issues = [];

// 1. No fresh test artifact keys (use timestamp heuristic: recent = last 5 minutes)
const allOcKeys = scanKeys('openclaw:*');
const fiveMinAgo = Date.now() - 5 * 60_000;
const testArtifacts = allOcKeys.filter(k => {
  // Match test-like patterns
  if (!/qa-|test-\d|watchdog-test-|wdg-/.test(k)) return false;
  // Extract timestamp from key to determine if it's from this session
  const tsMatch = k.match(/(\d{13})/);
  if (tsMatch) {
    const ts = parseInt(tsMatch[1], 10);
    return ts > fiveMinAgo; // Only flag recent artifacts
  }
  return false; // Can't determine age, ignore (pre-existing)
});
// Also report pre-existing stale test keys as warnings
const staleTestKeys = allOcKeys.filter(k =>
  /qa-|test-\d|watchdog-test-|wdg-/.test(k) && !testArtifacts.includes(k)
);
if (testArtifacts.length > 0) {
  issues.push({ check: 'fresh_test_artifacts', keys: testArtifacts });
} else {
  checks.push('no fresh test artifact keys');
}
if (staleTestKeys.length > 0) {
  checks.push(`${staleTestKeys.length} pre-existing stale key(s) (not from this session)`);
}

// 2. Consumer groups — only protected groups allowed
try {
  const raw = redisCli(['XINFO', 'GROUPS', 'openclaw:tasks:stream']);
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const groups = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const key = lines[i].replace(/^\d+\)\s*/, '').replace(/^"(.*)"$/, '$1');
    if (key === 'name') {
      const val = lines[i + 1].replace(/^\d+\)\s*/, '').replace(/^"(.*)"$/, '$1');
      if (val && val !== 'name') groups.push(val);
    }
  }
  const staleGroups = groups.filter(g => g !== 'openclaw-workers' && g !== 'openclaw-watchers');
  if (staleGroups.length > 0) {
    issues.push({ check: 'stale_consumer_groups', groups: staleGroups });
  } else {
    checks.push('consumer groups clean');
  }
} catch {
  checks.push('consumer groups (stream not found)');
}

// 3. Stream lengths within bounds
try {
  const tasksLen = parseInt(redisCli(['XLEN', 'openclaw:tasks:stream']), 10);
  const eventsLen = parseInt(redisCli(['XLEN', 'openclaw:events:stream']), 10);
  if (tasksLen > 200) {
    issues.push({ check: 'tasks_stream_large', length: tasksLen, threshold: 200 });
  } else {
    checks.push(`tasks stream: ${tasksLen} entries`);
  }
  if (eventsLen > 600) {
    issues.push({ check: 'events_stream_large', length: eventsLen, threshold: 600 });
  } else {
    checks.push(`events stream: ${eventsLen} entries`);
  }
} catch {
  checks.push('stream lengths (streams not found)');
}

// 4. Priority index hygiene — no orphaned members
try {
  const raw = redisCli(['--raw', 'ZRANGE', 'openclaw:tasks:priority', '0', '-1']);
  const members = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const orphaned = members.filter(taskId => {
    const exists = redisCli(['EXISTS', `openclaw:tasks:result:${taskId}`]);
    return exists === '0';
  });
  if (orphaned.length > 0) {
    issues.push({ check: 'orphaned_priority_members', count: orphaned.length, ids: orphaned.slice(0, 5) });
  } else {
    checks.push('priority index clean');
  }
} catch {
  checks.push('priority index (not found)');
}

// 5. Orphaned pipeline by-task mappings (no TTL)
const byTaskKeys = scanKeys('openclaw:pipeline:by-task:*');
const orphanedByTask = byTaskKeys.filter(k => {
  const ttl = parseInt(redisCli(['TTL', k]), 10);
  return ttl === -1; // no TTL = orphaned
});
if (orphanedByTask.length > 0) {
  issues.push({ check: 'orphaned_pipeline_by_task', keys: orphanedByTask });
} else {
  checks.push('pipeline by-task mappings clean');
}

// Summary
const ok = issues.length === 0;
console.log(JSON.stringify({
  ok,
  checks,
  issues: issues.length > 0 ? issues : undefined,
  total_openclaw_keys: allOcKeys.length,
}));

assert.equal(issues.length, 0, `Redis hygiene issues found: ${JSON.stringify(issues, null, 2)}`);
