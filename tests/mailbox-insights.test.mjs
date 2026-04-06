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

const qa = `qa-mail-${Date.now()}`;
const cleanup = { insightIds: [] };

try {
  // ── Mailbox ─────────────────────────────────────────────────────────────────

  // 1. Queue messages
  const msg1 = ocr(['queue-message', JSON.stringify({ text: `msg1 ${qa}`, from: 'tester' })]).json;
  assert.equal(msg1.ok, true);
  const msg2 = ocr(['queue-message', JSON.stringify({ text: `msg2 ${qa}`, from: 'coder' })]).json;
  assert.equal(msg2.ok, true);

  // 2. List messages (non-destructive read)
  const listed = ocr(['list-messages']).json;
  assert.equal(listed.ok, true);
  assert.ok(listed.messages.length >= 2, 'Should have at least 2 messages');
  assert.ok(listed.messages.some(m => m.text?.includes(`msg1 ${qa}`)));

  // 3. Drain messages (atomic: read + delete)
  const drained = ocr(['drain-messages']).json;
  assert.equal(drained.ok, true);
  assert.ok(drained.messages.length >= 2, 'Drain should return at least 2 messages');

  // 4. After drain, list should be empty
  const afterDrain = ocr(['list-messages']).json;
  assert.equal(afterDrain.ok, true);
  assert.equal(afterDrain.messages.length, 0, 'No messages after drain');

  // ── Insights ────────────────────────────────────────────────────────────────

  // 5. Queue insights
  const ins1 = ocr(['queue-insight', JSON.stringify({ text: `insight1 ${qa}`, source: 'tester', confidence: 'high', tags: ['test'] })]).json;
  assert.equal(ins1.ok, true);
  assert.ok(ins1.insight_id);
  cleanup.insightIds.push(ins1.insight_id);

  const ins2 = ocr(['queue-insight', JSON.stringify({ text: `insight2 ${qa}`, source: 'coder', confidence: 'low' })]).json;
  assert.equal(ins2.ok, true);
  cleanup.insightIds.push(ins2.insight_id);

  // 6. List insights
  const allInsights = ocr(['list-insights', '--limit', '50']).json;
  assert.equal(allInsights.ok, true);
  assert.ok(allInsights.insights.some(i => i.text?.includes(`insight1 ${qa}`)));

  // 7. Filter by source
  const filtered = ocr(['list-insights', '--source', 'tester', '--limit', '50']).json;
  assert.equal(filtered.ok, true);
  assert.ok(filtered.insights.every(i => i.source === 'tester'));

  // 8. Promote insight
  const promoted = ocr(['promote-insight', ins1.insight_id]).json;
  assert.equal(promoted.ok, true);

  // 9. List promoted insights
  const promotedList = ocr(['list-insights', '--promoted', '--limit', '50']).json;
  assert.equal(promotedList.ok, true);
  assert.ok(promotedList.insights.some(i => i.id === ins1.insight_id));

  // 10. Dismiss insight
  const dismissed = ocr(['dismiss-insight', ins2.insight_id]).json;
  assert.equal(dismissed.ok, true);

  // Verify dismissed insight is gone from main set
  const afterDismiss = ocr(['list-insights', '--limit', '50']).json;
  assert.ok(!afterDismiss.insights.some(i => i.id === ins2.insight_id), 'Dismissed insight should be gone');

  console.log(JSON.stringify({ ok: true, checks: [
    'queue-message x2',
    'list-messages (non-destructive)',
    'drain-messages (atomic)',
    'drain empties mailbox',
    'queue-insight x2',
    'list-insights',
    'list-insights --source filter',
    'promote-insight',
    'list-insights --promoted',
    'dismiss-insight',
  ]}));
} finally {
  // Clean up insights by scanning sorted sets for members containing our IDs
  for (const setKey of ['openclaw:insights', 'openclaw:insights:promoted']) {
    try {
      const raw = redisCli(['--raw', 'ZRANGEBYSCORE', setKey, '-inf', '+inf']);
      const members = raw.split('\n').filter(Boolean);
      for (const member of members) {
        if (cleanup.insightIds.some(id => member.includes(id))) {
          try { redisCli(['ZREM', setKey, member]); } catch {}
        }
      }
    } catch {}
  }
  // Clean restart messages (should already be drained)
  try { redisCli(['DEL', 'openclaw:restart:messages']); } catch {}
}
