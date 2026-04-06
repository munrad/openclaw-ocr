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
    const out = execFileSync('node', [OCR_BIN.pathname, ...args], {
      encoding: 'utf8',
      env: process.env,
    }).trim();
    return { code: 0, json: JSON.parse(out), raw: out };
  } catch (err) {
    const out = String(err.stdout || '').trim();
    const parsed = out ? JSON.parse(out) : null;
    if (!allowFailure) {
      throw new Error(`ocr ${args.join(' ')} failed code=${err.status}\nstdout=${out}\nstderr=${String(err.stderr || '')}`);
    }
    return { code: err.status || 1, json: parsed, raw: out, stderr: String(err.stderr || '') };
  }
}

function hgetall(key) {
  const raw = redisCli(['--raw', 'HGETALL', key]);
  const lines = raw.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const obj = {};
  for (let i = 0; i < lines.length; i += 2) obj[lines[i]] = lines[i + 1] ?? '';
  return obj;
}

function del(...keys) {
  if (keys.length) redisCli(['DEL', ...keys]);
}

function writeHash(key, obj) {
  const args = ['HSET', key];
  for (const [k, v] of Object.entries(obj)) {
    args.push(k, String(v));
  }
  redisCli(args);
}

function snapshotHash(key) {
  const hash = hgetall(key);
  return Object.keys(hash).length ? hash : null;
}

function restoreHash(key, snapshot) {
  del(key);
  if (!snapshot) return;
  writeHash(key, snapshot);
}

const now = () => String(Math.floor(Date.now() / 1000));

const keys = {
  health: 'openclaw:agents:status:health',
  factChecker: 'openclaw:agents:status:fact-checker',
  frontend: 'openclaw:agents:status:frontend-developer',
  product: 'openclaw:agents:status:product-manager',
};

const snapshots = {
  [keys.health]: null,
  [keys.factChecker]: null,
  [keys.frontend]: null,
  [keys.product]: null,
};

try {
  ocr(['init']);

  for (const key of Object.keys(snapshots)) {
    snapshots[key] = snapshotHash(key);
  }

  // 1. Busy primary agent should route to deterministic fallback.
  writeHash(keys.health, {
    state: 'working',
    step: 'busy health worker',
    updated_at: now(),
  });
  writeHash(keys.factChecker, {
    state: 'idle',
    step: '',
    updated_at: now(),
  });

  const fallbackRoute = ocr([
    'route-task',
    JSON.stringify({
      text: 'съел курицу с рисом на обед, сколько калорий и КБЖУ',
      source: 'telegram',
    }),
  ]).json;
  assert.equal(fallbackRoute.ok, true);
  assert.equal(fallbackRoute.route.type, 'health');
  assert.equal(fallbackRoute.route.primary_agent, 'fact-checker');
  assert.equal(fallbackRoute.route.original_primary, 'health');
  assert.match(fallbackRoute.route.selection_reason, /fallback/i);

  // 2. Ambiguous architectural request should recommend roundtable.
  const roundtableRoute = ocr([
    'route-task',
    JSON.stringify({
      text: 'исследовать архитектуру и сравнить trade-off между feature и security',
      source: 'telegram',
    }),
  ]).json;
  assert.equal(roundtableRoute.ok, true);
  assert.equal(roundtableRoute.route.type, 'research');
  assert.equal(roundtableRoute.route.pipeline, 'research_to_build');
  assert.equal(roundtableRoute.route.needs_roundtable, true);
  assert.equal(roundtableRoute.route.complexity, 'high');

  // 3. Stale snapshot must reject resurrection without matching run_id.
  writeHash(keys.frontend, {
    state: 'stale',
    step: 'stale snapshot',
    run_id: 'run-stale-1',
    updated_at: now(),
  });

  const staleBlocked = ocr([
    'set-status',
    'frontend-developer',
    JSON.stringify({ state: 'working', step: 'resume without ownership proof' }),
  ], { allowFailure: true });
  assert.equal(staleBlocked.code, 1);
  assert.equal(staleBlocked.json.ok, false);
  assert.equal(staleBlocked.json.reason, 'stale_resurrection_guard');

  const staleAllowed = ocr([
    'set-status',
    'frontend-developer',
    JSON.stringify({ state: 'working', step: 'resume with matching run', run_id: 'run-stale-1' }),
  ]).json;
  assert.equal(staleAllowed.ok, true);

  // 4. After stale auto-idle, stale writers with old run_epoch must be fenced.
  writeHash(keys.product, {
    state: 'idle',
    step: '',
    last_incident_marker: 'stale_auto_idle',
    reconcile_epoch: '5000',
    updated_at: now(),
  });

  const epochBlocked = ocr([
    'set-status',
    'product-manager',
    JSON.stringify({ state: 'working', step: 'stale writer', run_epoch: '5000' }),
  ], { allowFailure: true });
  assert.equal(epochBlocked.code, 1);
  assert.equal(epochBlocked.json.ok, false);
  assert.equal(epochBlocked.json.reason, 'epoch_stale_resurrection');

  const epochAllowed = ocr([
    'set-status',
    'product-manager',
    JSON.stringify({ state: 'working', step: 'fresh writer', run_epoch: '5001' }),
  ]).json;
  assert.equal(epochAllowed.ok, true);

  // 5. Client-supplied updated_at must not overwrite the system timestamp.
  const beforeSetStatusTs = String(Math.floor(Date.now() / 1000));
  const ignoredUpdatedAt = '1-0';
  const updatedAtIgnored = ocr([
    'set-status',
    'product-manager',
    JSON.stringify({ state: 'working', step: 'ignore forged updated_at', run_epoch: '5002', updated_at: ignoredUpdatedAt }),
  ]).json;
  assert.equal(updatedAtIgnored.ok, true);
  const persistedProduct = hgetall(keys.product);
  assert.notEqual(persistedProduct.updated_at, ignoredUpdatedAt);
  assert.ok(Number.parseInt(persistedProduct.updated_at, 10) >= Number.parseInt(beforeSetStatusTs, 10));

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'route-task fallback from busy primary',
      'route-task roundtable recommendation for architectural ambiguity',
      'stale resurrection guard',
      'epoch stale writer fence',
      'set-status ignores client updated_at overrides',
    ],
  }));
} finally {
  for (const [key, snapshot] of Object.entries(snapshots)) {
    restoreHash(key, snapshot);
  }
}
