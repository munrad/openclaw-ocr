/**
 * roundtable-status.test.mjs — Tests for `ocr roundtable-status` command
 *
 * Covers:
 *   1. Status of an active roundtable with partial contributions
 *   2. Status after all contributions (auto-completed within TTL window)
 *   3. Status of nonexistent/expired roundtable
 *   4. Tally summary correctness (agree/disagree counts)
 *   5. No write side-effects (read-only)
 */
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
    if (!allowFailure) {
      throw new Error(`ocr ${args.join(' ')} failed code=${err.status}\nstdout=${out}\nstderr=${String(err.stderr || '')}`);
    }
    return { code: err.status || 1, json: out ? JSON.parse(out) : null, raw: out };
  }
}

function cleanupIfExists(rtId) {
  try { redisCli(['DEL', `openclaw:roundtable:${rtId}`]); } catch {}
  try { redisCli(['DEL', `openclaw:roundtable:${rtId}:rounds`]); } catch {}
}

async function main() {
  // ─── Test 1: Status of active roundtable with partial contributions ────────

  const created = ocr([
    'roundtable-create',
    '--topic', 'status test roundtable',
    '--participants', 'coder,tester,reviewer',
  ]);
  assert.equal(created.json.ok, true);
  const rtId = created.json.rt_id;

  try {
    // Contribute from coder only
    ocr([
      'roundtable-contribute', rtId,
      '--agent', 'coder',
      '--round', '1',
      '--summary', 'Coder analysis done',
      '--agrees_with', 'tester',
    ]);

    // Get status — should show active, 1 contribution, 2 pending
    const status1 = ocr(['roundtable-status', rtId]);
    assert.equal(status1.json.ok, true);
    assert.equal(status1.json.rt_id, rtId);
    assert.equal(status1.json.topic, 'status test roundtable');
    assert.equal(status1.json.status, 'active');
    assert.ok(status1.json.created_at);
    assert.equal(status1.json.completed_at, null);
    assert.equal(status1.json.current_round, 1);
    assert.deepEqual(status1.json.participants, ['coder', 'tester', 'reviewer']);
    assert.deepEqual(status1.json.contributed_agents, ['coder']);
    assert.ok(status1.json.pending_agents.includes('tester'));
    assert.ok(status1.json.pending_agents.includes('reviewer'));
    assert.equal(status1.json.contributions_count, 1);

    // Tally summary should show agrees
    assert.equal(status1.json.tally_summary.agree_count, 1);
    assert.equal(status1.json.tally_summary.disagree_count, 0);
    assert.deepEqual(status1.json.tally_summary.strongest_support, ['tester']);
    assert.deepEqual(status1.json.tally_summary.strongest_objections, []);

    // ─── Test 2: No write side-effects ───────────────────────────────────────

    // Read status twice — should be identical (no mutations)
    const snapshot1 = redisCli(['HGETALL', `openclaw:roundtable:${rtId}`]);
    ocr(['roundtable-status', rtId]);
    const snapshot2 = redisCli(['HGETALL', `openclaw:roundtable:${rtId}`]);
    assert.equal(snapshot1, snapshot2, 'roundtable-status must not mutate Redis state');

    // ─── Test 3: Status with disagreement tally ──────────────────────────────

    ocr([
      'roundtable-contribute', rtId,
      '--agent', 'tester',
      '--round', '1',
      '--summary', 'Tester disagrees with coder approach',
      '--disagrees_with', 'coder',
      '--agrees_with', 'reviewer',
    ]);

    const status2 = ocr(['roundtable-status', rtId]);
    assert.equal(status2.json.contributions_count, 2);
    assert.deepEqual(status2.json.contributed_agents.sort(), ['coder', 'tester']);
    assert.deepEqual(status2.json.pending_agents, ['reviewer']);
    assert.equal(status2.json.tally_summary.agree_count, 2); // coder->tester, tester->reviewer
    assert.equal(status2.json.tally_summary.disagree_count, 1); // tester->coder
    assert.ok(status2.json.tally_summary.unresolved_agents.includes('coder'));

    // ─── Test 4: After auto-complete (all contribute) — status still readable within TTL window

    ocr([
      'roundtable-contribute', rtId,
      '--agent', 'reviewer',
      '--round', '1',
      '--summary', 'Reviewer synthesis',
      '--agrees_with', 'coder,tester',
    ]);

    // After auto-complete, the key has 1h TTL but is still readable
    const statusAfterComplete = ocr(['roundtable-status', rtId]);
    assert.equal(statusAfterComplete.json.ok, true);
    assert.equal(statusAfterComplete.json.status, 'completed');
    assert.ok(statusAfterComplete.json.completed_at);
    assert.equal(statusAfterComplete.json.contributions_count, 3);
    assert.deepEqual(statusAfterComplete.json.pending_agents, []);
    assert.deepEqual(statusAfterComplete.json.contributed_agents.sort(), ['coder', 'reviewer', 'tester']);

    console.log(JSON.stringify({
      ok: true,
      test: 'roundtable-status',
      checks: [
        'active roundtable: metadata + contribution tracking',
        'pending/contributed agents computed correctly',
        'tally summary: agree/disagree counts',
        'no write side-effects',
        'completed roundtable still readable within TTL window',
        'disagree tracking and unresolved agents',
      ],
    }));
  } finally {
    cleanupIfExists(rtId);
  }

  // ─── Test 5: Nonexistent roundtable ────────────────────────────────────────

  const notFound = ocr(['roundtable-status', 'rt-nonexistent-999'], { allowFailure: true });
  assert.equal(notFound.json.ok, false);
  assert.equal(notFound.json.reason, 'not_found');
  assert.equal(notFound.json.rt_id, 'rt-nonexistent-999');

  console.log(JSON.stringify({
    ok: true,
    test: 'roundtable-status-not-found',
    checks: ['nonexistent roundtable returns not_found'],
  }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
