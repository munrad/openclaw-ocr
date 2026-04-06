import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { CONFIG } from '../lib/config.mjs';

const OCR_BIN = new URL('../index.mjs', import.meta.url);

function redisCli(args) {
  const base = ['-h', CONFIG.host, '-p', String(CONFIG.port), '--no-auth-warning'];
  let password = CONFIG.password || process.env.REDIS_PASSWORD || '';
  if (!password) {
    try { password = readFileSync('/run/secrets/redis_password', 'utf8').trim(); } catch {}
  }
  if (password) base.push('-a', password);
  return execFileSync('redis-cli', [...base, ...args], { encoding: 'utf8' }).trim();
}

function ocr(args) {
  const out = execFileSync('node', [OCR_BIN.pathname, ...args], {
    encoding: 'utf8',
    env: process.env,
  }).trim();
  return JSON.parse(out);
}

function cleanupIfExists(rtId) {
  try { redisCli(['DEL', `openclaw:roundtable:${rtId}`]); } catch {}
  try { redisCli(['DEL', `openclaw:roundtable:${rtId}:rounds`]); } catch {}
}

const created = ocr([
  'roundtable-create',
  '--topic', 'auto cleanup test',
  '--participants', 'coder,tester',
]);

assert.equal(created.ok, true);
assert.match(created.rt_id, /^rt-/);

const rtId = created.rt_id;
const rtKey = `openclaw:roundtable:${rtId}`;
const streamKey = `${rtKey}:rounds`;

try {
  const first = ocr([
    'roundtable-contribute', rtId,
    '--agent', 'coder',
    '--round', '1',
    '--summary', 'first contribution',
  ]);
  assert.equal(first.ok, true);
  assert.ok(first.entry_id);
  assert.equal(redisCli(['EXISTS', rtKey]), '1');
  assert.equal(redisCli(['EXISTS', streamKey]), '1');

  const second = ocr([
    'roundtable-contribute', rtId,
    '--agent', 'tester',
    '--round', '1',
    '--summary', 'last contribution triggers cleanup',
  ]);
  assert.equal(second.ok, true);
  assert.ok(second.entry_id);

  assert.equal(redisCli(['EXISTS', rtKey]), '0');
  assert.equal(redisCli(['EXISTS', streamKey]), '0');

  console.log(JSON.stringify({ ok: true, rt_id: rtId, auto_cleanup: true }));
} finally {
  cleanupIfExists(rtId);
}
