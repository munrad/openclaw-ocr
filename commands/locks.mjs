/**
 * commands/locks.mjs — Distributed lock commands + branch locking
 */
import { withRetry } from '../lib/retry.mjs';
import { redis, redisRaw, redisLines } from '../lib/redis.mjs';
import { KEYS, now } from '../lib/schema.mjs';
import { output, argError, infraError } from '../lib/errors.mjs';

/**
 * Lua script for safe unlock (atomic check-and-delete).
 */
const UNLOCK_SCRIPT = `
if redis.call("get",KEYS[1]) == ARGV[1] then
  return redis.call("del",KEYS[1])
else
  return 0
end
`.trim();

/**
 * Lua script for lock renewal (atomic check-owner-and-pexpire).
 */
const RENEW_SCRIPT = `
if redis.call("get",KEYS[1]) == ARGV[1] then
  return redis.call("pexpire",KEYS[1], ARGV[2])
else
  return 0
end
`.trim();

// ─── Generic locks ───────────────────────────────────────────────────────────

export async function cmdLock(resource, agentId, ttlArg) {
  if (!resource) throw argError('lock requires <resource>');
  if (!agentId)  throw argError('lock requires <agent-id>');
  const ttl = ttlArg ? parseInt(ttlArg, 10) : 300;
  if (isNaN(ttl) || ttl <= 0) throw argError('lock: ttl must be a positive integer');
  const MAX_TTL = 3600;
  if (ttl > MAX_TTL) throw argError(`lock: ttl must be <= ${MAX_TTL} seconds (1 hour)`);

  const key = KEYS.lockRes(resource);

  const result = await withRetry(() => {
    const res = redis('SET', key, agentId, 'NX', 'EX', String(ttl));
    if (res === 'OK') return { acquired: true };

    // Lock exists — get owner and TTL
    const owner = redis('GET', key);
    const remaining = redis('TTL', key);
    return { acquired: false, owner, ttl: parseInt(remaining, 10) };
  });

  if (result.acquired) {
    output({ ok: true, resource, agent_id: agentId, ttl });
  } else {
    output({ ok: false, reason: 'locked', resource, owner: result.owner, ttl: result.ttl }, 1);
  }
}

export async function cmdUnlock(resource, agentId) {
  if (!resource) throw argError('unlock requires <resource>');
  if (!agentId)  throw argError('unlock requires <agent-id>');

  const key = KEYS.lockRes(resource);

  const result = await withRetry(() => {
    const res = redis('EVAL', UNLOCK_SCRIPT, '1', key, agentId);
    return res;
  });

  if (result === '1' || result === 1) {
    output({ ok: true, resource, agent_id: agentId });
  } else {
    // Lock not owned by this agent
    const owner = (() => { try { return redis('GET', key); } catch { return 'unknown'; } })();
    output({ ok: false, reason: 'not_owner', resource, owner }, 1);
  }
}

// ─── Branch locks ────────────────────────────────────────────────────────────

/**
 * Helper: emit event to stream
 */
function emitEvent(eventType, agentId, data) {
  redis('XADD', KEYS.eventsStream, 'MAXLEN', '~', '10000', '*',
    'type', eventType,
    'timestamp', now(),
    'agent', agentId,
    'data', JSON.stringify(data)
  );
}

/**
 * Helper: update agent status hash with branch metadata only (no lifecycle refresh)
 */
function updateStatusFields(agentId, fields) {
  const args = ['branch_updated_at', now()];
  for (const [k, v] of Object.entries(fields)) {
    args.push(k, String(v));
  }
  redis('HSET', KEYS.agentStatus(agentId), ...args);
}

export async function cmdLockBranch(branch, agentId, ttlArg) {
  if (!branch)  throw argError('lock-branch requires <branch>');
  if (!agentId) throw argError('lock-branch requires <agent-id>');
  const ttl = ttlArg ? parseInt(ttlArg, 10) : 1800;
  if (isNaN(ttl) || ttl <= 0) throw argError('lock-branch: ttl must be a positive integer');
  const MAX_TTL = 7200;
  if (ttl > MAX_TTL) throw argError(`lock-branch: ttl must be <= ${MAX_TTL} seconds (2 hours)`);

  const key = KEYS.lockBranch(branch);

  const result = await withRetry(() => {
    const res = redis('SET', key, agentId, 'NX', 'EX', String(ttl));
    if (res === 'OK') return { acquired: true };

    const owner = redis('GET', key);
    const remaining = redis('TTL', key);
    return { acquired: false, owner, ttl: parseInt(remaining, 10) };
  });

  if (result.acquired) {
    // Update agent status with branch info
    await withRetry(() => {
      updateStatusFields(agentId, { branch, branch_lock: 'true' });
      return true;
    });

    // Emit branch_locked event
    await withRetry(() => {
      emitEvent('branch_locked', agentId, { branch, agent_id: agentId, ttl });
      return true;
    });

    output({ ok: true, branch, agent_id: agentId, ttl });
  } else {
    // Emit conflict event
    await withRetry(() => {
      emitEvent('branch_lock_conflict', agentId, {
        branch,
        requester: agentId,
        owner: result.owner,
        ttl: result.ttl,
      });
      return true;
    });

    output({ ok: false, reason: 'locked', branch, owner: result.owner, ttl: result.ttl }, 1);
  }
}

export async function cmdUnlockBranch(branch, agentId) {
  if (!branch)  throw argError('unlock-branch requires <branch>');
  if (!agentId) throw argError('unlock-branch requires <agent-id>');

  const key = KEYS.lockBranch(branch);

  const result = await withRetry(() => {
    const res = redis('EVAL', UNLOCK_SCRIPT, '1', key, agentId);
    return res;
  });

  if (result === '1' || result === 1) {
    // Clear branch info from agent status
    await withRetry(() => {
      updateStatusFields(agentId, { branch: '', branch_lock: 'false' });
      return true;
    });

    // Emit branch_unlocked event
    await withRetry(() => {
      emitEvent('branch_unlocked', agentId, { branch, agent_id: agentId });
      return true;
    });

    output({ ok: true, branch, agent_id: agentId });
  } else {
    const owner = (() => { try { return redis('GET', key); } catch { return 'unknown'; } })();
    output({ ok: false, reason: 'not_owner', branch, owner }, 1);
  }
}

export async function cmdRenewBranchLock(branch, agentId, ttlArg) {
  if (!branch)  throw argError('renew-branch-lock requires <branch>');
  if (!agentId) throw argError('renew-branch-lock requires <agent-id>');
  const ttl = ttlArg ? parseInt(ttlArg, 10) : 1800;
  if (isNaN(ttl) || ttl <= 0) throw argError('renew-branch-lock: ttl must be a positive integer');
  const MAX_TTL = 7200;
  if (ttl > MAX_TTL) throw argError(`renew-branch-lock: ttl must be <= ${MAX_TTL} seconds (2 hours)`);

  const key = KEYS.lockBranch(branch);
  const ttlMs = String(ttl * 1000);

  const result = await withRetry(() => {
    const res = redis('EVAL', RENEW_SCRIPT, '1', key, agentId, ttlMs);
    return res;
  });

  if (result === '1' || result === 1) {
    output({ ok: true, branch, agent_id: agentId, ttl });
  } else {
    const owner = (() => { try { return redis('GET', key); } catch { return 'unknown'; } })();
    output({ ok: false, reason: 'not_owner', branch, owner }, 1);
  }
}

export async function cmdListLocks(args) {
  const parsedArgs = args || [];
  let kind = null;

  // Parse --kind flag
  for (let i = 0; i < parsedArgs.length; i++) {
    if (parsedArgs[i] === '--kind' && parsedArgs[i + 1]) {
      kind = parsedArgs[i + 1];
      i++;
    }
  }

  // Default to ALL locks if no --kind specified
  const pattern = !kind
    ? 'openclaw:locks:res:*'
    : `openclaw:locks:res:${kind}:*`;

  const locks = [];

  // Use SCAN to find matching lock keys
  let cursor = '0';
  do {
    const raw = await withRetry(() => redisRaw(['SCAN', cursor, 'MATCH', pattern, 'COUNT', '100']));
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    // First line is next cursor, rest are keys
    const clean = lines.map(l => l.replace(/^\d+\)\s*/, '').replace(/^"(.*)"$/, '$1'));
    cursor = clean[0] || '0';

    for (let i = 1; i < clean.length; i++) {
      const key = clean[i];
      if (!key || key === '(empty list or set)' || key === '(empty array)') continue;

      try {
        const owner = await withRetry(() => redis('GET', key));
        const ttlRaw = await withRetry(() => redis('TTL', key));
        const ttlVal = parseInt(ttlRaw, 10);

        // Extract branch name from key
        // Key format: openclaw:locks:res:branch:<branch-name>
        const branchMatch = key.match(/^openclaw:locks:res:branch:(.+)$/);
        const branchName = branchMatch ? branchMatch[1] : key.replace('openclaw:locks:res:', '');

        if (owner && owner !== '(nil)' && owner !== 'nil') {
          locks.push({
            branch: branchName,
            owner,
            ttl: ttlVal > 0 ? ttlVal : 0,
          });
        }
      } catch {
        // Skip keys that error out
      }
    }
  } while (cursor !== '0');

  output({ ok: true, locks, count: locks.length });
}
