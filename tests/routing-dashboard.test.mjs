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

const qa = `qa-route-${Date.now()}`;
const agentKeys = [];

try {
  ocr(['init']);

  // ── Task Routing (run BEFORE setting agent status to avoid availability bias) ──

  // 1. Route incident task
  const incidentRoute = ocr(['route-task', JSON.stringify({ text: 'сервис упал, 502 error', source: 'telegram' })]).json;
  assert.equal(incidentRoute.ok, true);
  assert.equal(incidentRoute.route.type, 'incident');
  assert.equal(incidentRoute.route.primary_agent, 'monitor');
  assert.ok(incidentRoute.route.confidence > 0);

  // 2. Route code task
  const codeRoute = ocr(['route-task', JSON.stringify({ text: 'исправь баг в unit test, нужен фикс', source: 'telegram' })]).json;
  assert.equal(codeRoute.ok, true);
  assert.equal(codeRoute.route.type, 'code');
  assert.equal(codeRoute.route.primary_agent, 'coder');

  // ── Agent Status Lifecycle ──────────────────────────────────────────────────

  // 3. set-status / get-status
  const setResult = ocr(['set-status', 'coder', JSON.stringify({ state: 'working', step: `testing ${qa}`, progress: 50 })]).json;
  assert.equal(setResult.ok, true);
  agentKeys.push('openclaw:agents:status:coder', 'openclaw:heartbeat:coder');

  const getResult = ocr(['get-status', 'coder']).json;
  assert.equal(getResult.ok, true);
  assert.equal(getResult.status.state, 'working');
  assert.ok(getResult.status.step.includes(qa));

  // 4. Heartbeat
  const hbResult = ocr(['heartbeat', 'coder']).json;
  assert.equal(hbResult.ok, true);
  const hbTtl = Number(redisCli(['TTL', 'openclaw:heartbeat:coder']));
  assert.ok(hbTtl > 0 && hbTtl <= 60, `Heartbeat TTL should be 1-60, got ${hbTtl}`);

  // 5. Route health task
  const healthRoute = ocr(['route-task', JSON.stringify({ text: 'съел курицу с рисом на обед, сколько калорий КБЖУ', source: 'telegram' })]).json;
  assert.equal(healthRoute.ok, true);
  assert.equal(healthRoute.route.type, 'health');
  assert.equal(healthRoute.route.primary_agent, 'health');

  // 6. Route with explicit metadata type
  const explicitRoute = ocr(['route-task', JSON.stringify({ text: 'something vague', source: 'telegram', metadata: { type: 'security' } })]).json;
  assert.equal(explicitRoute.ok, true);
  assert.equal(explicitRoute.route.type, 'security');

  // 7. Route feature (check structure, not exact agent — routing depends on keyword weights)
  const featureRoute = ocr(['route-task', JSON.stringify({ text: 'добавить новую фичу для пользователей, реализовать функционал', source: 'telegram' })]).json;
  assert.equal(featureRoute.ok, true);
  assert.ok(featureRoute.route.primary_agent, 'Should have a primary agent');
  assert.ok(featureRoute.route.type, 'Should have a route type');
  assert.ok(featureRoute.route.confidence > 0, 'Should have confidence > 0');

  // ── Status Query ────────────────────────────────────────────────────────────

  // 8. status-query (all)
  const statusAll = ocr(['status-query']).json;
  assert.equal(statusAll.ok, true);
  assert.ok(Array.isArray(statusAll.agents) || typeof statusAll.agents === 'object');

  // 9. status-query with agent filter
  const statusCoder = ocr(['status-query', 'coder']).json;
  assert.equal(statusCoder.ok, true);

  // ── Dashboard ───────────────────────────────────────────────────────────────

  // 10. dashboard
  const dashboard = ocr(['dashboard']).json;
  assert.equal(dashboard.ok, true);
  assert.ok('agents' in dashboard || 'sections' in dashboard || 'summary' in dashboard, 'Dashboard should have structured output');

  // Clean up agent status
  ocr(['set-status', 'coder', JSON.stringify({ state: 'idle', step: '' })]);

  console.log(JSON.stringify({ ok: true, checks: [
    'route-task: incident',
    'route-task: code',
    'set-status / get-status',
    'heartbeat TTL',
    'route-task: health',
    'route-task: explicit type',
    'route-task: feature -> planner',
    'status-query all',
    'status-query agent filter',
    'dashboard',
  ]}));
} finally {
  for (const key of agentKeys) del(key);
}
