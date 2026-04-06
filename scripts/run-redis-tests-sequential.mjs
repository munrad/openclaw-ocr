#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG } from '../lib/config.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HYGIENE_TEST = 'tests/redis-hygiene.test.mjs';
const DEFAULT_TEST_FILES = [
  'tests/locks-events.test.mjs',
  'tests/roundtable-status.test.mjs',
  'tests/roundtable-auto-cleanup.test.mjs',
  'tests/mailbox-insights.test.mjs',
  'tests/multiagent-spawn-heartbeat.test.mjs',
  'tests/routing-dashboard.test.mjs',
  'tests/routing-status-guards.test.mjs',
  'tests/lifecycle-hygiene.test.mjs',
  'tests/lifecycle-remote-stop.test.mjs',
  'tests/integration-smoke.test.mjs',
  'tests/task-status-bootstrap-pending.test.mjs',
  'tests/task-status-noop-refresh.test.mjs',
  'tests/task-status-timeout-idempotency.test.mjs',
  'tests/task-status-phantom-create.test.mjs',
  'tests/task-status-topic1-hardening.test.mjs',
  'tests/task-status-watcher-bootstrap-pending-recovery.test.mjs',
  'tests/task-status-watcher-fallback-resume.test.mjs',
  'tests/task-status-watcher-spawn-bootstrap.test.mjs',
  'tests/teamlead-fanout-e2e.test.mjs',
];

function loadRedisPassword() {
  if (CONFIG.password) return CONFIG.password;
  try {
    return readFileSync('/run/secrets/redis_password', 'utf8').trim();
  } catch {
    return '';
  }
}

function redisCli(db, args) {
  const base = [
    '-h', CONFIG.host,
    '-p', String(CONFIG.port),
    '-n', String(db),
    '--no-auth-warning',
  ];
  const password = loadRedisPassword();
  if (password) base.push('-a', password);
  return execFileSync('redis-cli', [...base, ...args], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function ensureRedisCliAvailable() {
  try {
    execFileSync('redis-cli', ['--version'], { stdio: 'ignore' });
  } catch {
    throw new Error('redis-cli is required for scripts/run-redis-tests-sequential.mjs');
  }
}

function flushDb(db) {
  redisCli(db, ['FLUSHDB']);
}

function readDatabaseCount() {
  try {
    const raw = redisCli(0, ['CONFIG', 'GET', 'databases']);
    const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
    const index = lines.findIndex((line) => line === 'databases');
    const value = index >= 0 ? lines[index + 1] : lines[lines.length - 1];
    const count = Number(value);
    return Number.isInteger(count) && count > 0 ? count : 16;
  } catch {
    return 16;
  }
}

function usesNodeTestRunner(absPath) {
  const source = readFileSync(absPath, 'utf8');
  return source.includes("from 'node:test'") || source.includes('from "node:test"');
}

function runNodeFile(file, env) {
  const absPath = path.resolve(ROOT_DIR, file);
  if (!existsSync(absPath)) {
    throw new Error(`Test file not found: ${file}`);
  }

  const nodeArgs = usesNodeTestRunner(absPath)
    ? ['--test', absPath]
    : [absPath];

  const result = spawnSync('node', nodeArgs, {
    cwd: ROOT_DIR,
    env,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    throw new Error(`Test failed: ${file} (exit=${result.status ?? 'null'})`);
  }
}

function parseBaseDb() {
  const raw = String(process.env.OCR_TEST_REDIS_DB_BASE || '10').trim();
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`OCR_TEST_REDIS_DB_BASE must be a non-negative integer, got: ${raw}`);
  }
  return parsed;
}

function log(message) {
  process.stderr.write(`[redis-seq] ${message}\n`);
}

async function main() {
  ensureRedisCliAvailable();

  const requestedFiles = process.argv.slice(2);
  const testFiles = requestedFiles.length > 0 ? requestedFiles : DEFAULT_TEST_FILES;
  const baseDb = parseBaseDb();
  const dbCount = readDatabaseCount();
  const runHygiene = process.env.OCR_RUN_REDIS_HYGIENE !== '0';

  for (const [index, file] of testFiles.entries()) {
    const db = (baseDb + index) % dbCount;
    const env = {
      ...process.env,
      REDIS_DB: String(db),
      OCR_INTEGRATION_SKIP_TELEGRAM:
        process.env.OCR_INTEGRATION_SKIP_TELEGRAM
        || (process.env.OPENCLAW_TELEGRAM_BOT_TOKEN === '1:fake' ? '1' : '0'),
    };

    log(`starting ${file} on REDIS_DB=${db}`);
    flushDb(db);
    try {
      runNodeFile(file, env);
      if (runHygiene && file !== HYGIENE_TEST) {
        runNodeFile(HYGIENE_TEST, env);
      }
      log(`passed ${file} on REDIS_DB=${db}`);
    } finally {
      flushDb(db);
    }
  }

  log(`completed ${testFiles.length} sequential Redis-backed test file(s) across ${dbCount} Redis DB(s)`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
