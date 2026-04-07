import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { CONFIG } from '../lib/config.mjs';

const OCR_BIN = new URL('../index.mjs', import.meta.url);

const password = CONFIG.password || process.env.REDIS_PASSWORD || (() => {
  try { return readFileSync('/run/secrets/redis_password', 'utf8').trim(); } catch { return ''; }
})();
const baseRedisArgs = ['-h', CONFIG.host, '-p', String(CONFIG.port), '-n', String(CONFIG.db || 0), '--no-auth-warning'];
if (password) baseRedisArgs.push('-a', password);

function redisCli(args) {
  return execFileSync('redis-cli', [...baseRedisArgs, ...args], { encoding: 'utf8' }).trim();
}

function hgetall(key) {
  const raw = redisCli(['--raw', 'HGETALL', key]);
  const lines = raw.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const obj = {};
  for (let i = 0; i < lines.length; i += 2) obj[lines[i]] = lines[i + 1] ?? '';
  return obj;
}

function ocr(args) {
  const out = execFileSync('node', [OCR_BIN.pathname, ...args], { encoding: 'utf8', env: process.env }).trim();
  return JSON.parse(out);
}

test('status-hygiene reports and removes suspicious legacy mirrored fields from agent status hashes', () => {
  const agentId = `hygiene-agent-${Date.now()}`;
  const key = `openclaw:agents:status:${agentId}`;

  try {
    redisCli(['HSET', key,
      'state', 'working',
      'step', 'healthy canonical step',
      'run_id', 'run-hygiene',
      'progress', '55',
      'updated_at', '1775505000',
      'last_incident_marker', 'stale_auto_idle',
      '1775417033200', 'last_degraded_at',
      '1775416432', 'last_degraded_reason',
      'missing_heartbeat_active_to_stale', 'last_incident_marker',
      'custom_note', 'keep-me',
    ]);

    const dryRun = ocr(['status-hygiene', '--agent', agentId]);
    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.dry_run, true);
    assert.equal(dryRun.affected_agents, 1);
    assert.equal(dryRun.suspicious_fields_total, 3);
    assert.equal(dryRun.agents[0].agent_id, agentId);

    const beforeApply = hgetall(key);
    assert.equal(beforeApply['1775417033200'], 'last_degraded_at');
    assert.equal(beforeApply['1775416432'], 'last_degraded_reason');
    assert.equal(beforeApply.missing_heartbeat_active_to_stale, 'last_incident_marker');
    assert.equal(beforeApply.custom_note, 'keep-me');

    const applied = ocr(['status-hygiene', '--agent', agentId, '--apply', 'true']);
    assert.equal(applied.ok, true);
    assert.equal(applied.dry_run, false);
    assert.equal(applied.removed_fields_total, 3);

    const afterApply = hgetall(key);
    assert.equal(afterApply.state, 'working');
    assert.equal(afterApply.step, 'healthy canonical step');
    assert.equal(afterApply.run_id, 'run-hygiene');
    assert.equal(afterApply.custom_note, 'keep-me');
    assert.equal(Object.prototype.hasOwnProperty.call(afterApply, '1775417033200'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(afterApply, '1775416432'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(afterApply, 'missing_heartbeat_active_to_stale'), false);
  } finally {
    try { redisCli(['DEL', key]); } catch {}
  }
});
