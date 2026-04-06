import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { CONFIG } from '../lib/config.mjs';

const OCR_BIN = new URL('../index.mjs', import.meta.url);

function redisCli(args) {
  const base = ['-h', CONFIG.host, '-p', String(CONFIG.port), '-n', String(CONFIG.db || 0), '--no-auth-warning'];
  let password = CONFIG.password || process.env.REDIS_PASSWORD || '';
  if (!password) {
    try { password = readFileSync('/run/secrets/redis_password', 'utf8').trim(); } catch {}
  }
  if (password) base.push('-a', password);
  return execFileSync('redis-cli', [...base, ...args], { encoding: 'utf8' }).trim();
}

function ocr(args, { allowFailure = false } = {}) {
  try {
    const out = execFileSync('node', [OCR_BIN.pathname, ...args], { encoding: 'utf8', env: process.env }).trim();
    return { code: 0, json: JSON.parse(out), raw: out };
  } catch (err) {
    const out = String(err.stdout || '').trim();
    const parsed = out ? JSON.parse(out) : null;
    if (!allowFailure) {
      throw new Error(`ocr ${args.join(' ')} failed code=${err.status}\nstdout=${out}\nstderr=${String(err.stderr || '')}`);
    }
    return { code: err.status || 1, json: parsed, raw: out };
  }
}

function del(...keys) {
  if (keys.length) redisCli(['DEL', ...keys]);
}

const qa = `qa-lock-${Date.now()}`;
const cleanup = { keys: [] };

try {
  ocr(['init']);

  // ── Resource Locks ──────────────────────────────────────────────────────────

  // 1. Lock + unlock happy path
  const lockRes = ocr(['lock', `res-${qa}`, 'coder', '30']).json;
  assert.equal(lockRes.ok, true);
  cleanup.keys.push(`openclaw:locks:res:res-${qa}`);

  // Verify lock exists in Redis with TTL
  const lockTtl = Number(redisCli(['TTL', `openclaw:locks:res:res-${qa}`]));
  assert.ok(lockTtl > 0 && lockTtl <= 30, `TTL should be 1-30, got ${lockTtl}`);

  // Lock by another agent must fail
  const lockConflict = ocr(['lock', `res-${qa}`, 'tester', '10'], { allowFailure: true });
  assert.equal(lockConflict.code, 1);
  assert.equal(lockConflict.json.ok, false);

  // Unlock by wrong owner must fail
  const unlockWrong = ocr(['unlock', `res-${qa}`, 'tester'], { allowFailure: true });
  assert.equal(unlockWrong.json.ok, false);

  // Unlock by correct owner
  const unlockOk = ocr(['unlock', `res-${qa}`, 'coder']).json;
  assert.equal(unlockOk.ok, true);
  assert.equal(redisCli(['EXISTS', `openclaw:locks:res:res-${qa}`]), '0');

  // ── Branch Locks ────────────────────────────────────────────────────────────

  // 2. Branch lock + unlock + renew
  const branchName = `feature/test-${qa}`;
  const branchLock = ocr(['lock-branch', branchName, 'coder', '60']).json;
  assert.equal(branchLock.ok, true);
  cleanup.keys.push(`openclaw:locks:res:branch:${branchName}`);

  // Branch lock conflict
  const branchConflict = ocr(['lock-branch', branchName, 'tester'], { allowFailure: true });
  assert.equal(branchConflict.code, 1);

  // Renew branch lock
  const renewResult = ocr(['renew-branch-lock', branchName, 'coder', '120']).json;
  assert.equal(renewResult.ok, true);
  const renewedTtl = Number(redisCli(['TTL', `openclaw:locks:res:branch:${branchName}`]));
  assert.ok(renewedTtl > 60, `Renewed TTL should be >60, got ${renewedTtl}`);

  // Renew by wrong owner
  const renewWrong = ocr(['renew-branch-lock', branchName, 'tester'], { allowFailure: true });
  assert.equal(renewWrong.json.ok, false);

  // list-locks
  const locksList = ocr(['list-locks']).json;
  assert.equal(locksList.ok, true);
  assert.ok(Array.isArray(locksList.locks));

  // list-locks --kind branch
  const branchLocks = ocr(['list-locks', '--kind', 'branch']).json;
  assert.equal(branchLocks.ok, true);
  assert.ok(branchLocks.locks.some(l => l.resource?.includes(branchName) || l.branch?.includes(branchName)));

  // locks-query
  const locksQuery = ocr(['locks-query']).json;
  assert.equal(locksQuery.ok, true);

  // Unlock branch
  const branchUnlock = ocr(['unlock-branch', branchName, 'coder']).json;
  assert.equal(branchUnlock.ok, true);

  // ── Events ──────────────────────────────────────────────────────────────────

  // 3. Emit + watch
  const eventData = JSON.stringify({ type: 'test_event', data: JSON.stringify({ qa, source: 'test' }) });
  const emitResult = ocr(['emit', 'test_event', JSON.stringify({ qa, source: 'test' })]).json;
  assert.equal(emitResult.ok, true);
  assert.ok(emitResult.event_id);

  // Watch should return events (non-blocking with short timeout)
  const watchResult = ocr(['watch', '0-0']).json;
  assert.equal(watchResult.ok, true);
  assert.ok(Array.isArray(watchResult.events));
  assert.ok(watchResult.events.length > 0, 'Should have at least one event');

  console.log(JSON.stringify({ ok: true, checks: [
    'lock/unlock happy path',
    'lock conflict detection',
    'unlock ownership check',
    'branch lock/unlock/renew',
    'branch lock conflict',
    'renew ownership check',
    'list-locks',
    'list-locks --kind branch',
    'locks-query',
    'emit event',
    'watch events',
  ]}));
} finally {
  for (const key of cleanup.keys) del(key);
  del(`openclaw:agents:status:coder`, `openclaw:agents:status:tester`);
}
