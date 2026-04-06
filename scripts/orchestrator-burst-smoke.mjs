#!/usr/bin/env node
/**
 * scripts/orchestrator-burst-smoke.mjs
 *
 * Small operator helper for staging/load validation of root orchestration fan-out.
 * It creates multiple orchestration roots, captures accepts/rejections, optionally
 * snapshots the active-root list, and can force-close the created roots for cleanup.
 */
import { execFileSync } from 'node:child_process';

const OCR_BIN = new URL('../index.mjs', import.meta.url);

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-/g, '_');
    const next = argv[index + 1];
    if (next !== undefined && !String(next).startsWith('--')) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true || value === 'true' || value === '1' || value === 1) return true;
  if (value === false || value === 'false' || value === '0' || value === 0) return false;
  return fallback;
}

function parsePositiveInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.floor(numeric);
}

function sleep(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runOcr(args, { allowFailure = false } = {}) {
  try {
    const raw = execFileSync(process.execPath, [OCR_BIN.pathname, ...args], {
      encoding: 'utf8',
      env: process.env,
    }).trim();
    return { ok: true, raw, json: JSON.parse(raw) };
  } catch (error) {
    const raw = String(error.stdout || '').trim();
    if (!allowFailure || !raw) throw error;
    return { ok: false, raw, json: JSON.parse(raw), exitCode: error.status || error.code || 1 };
  }
}

function printHelp() {
  const help = [
    'orchestrator-burst-smoke.mjs',
    '',
    'Usage:',
    '  node scripts/orchestrator-burst-smoke.mjs [options]',
    '',
    'Options:',
    '  --roots <N>                 Number of roots to create (default: 5)',
    '  --agents <csv>              Child agents per root (default: coder,tester)',
    '  --coordinator-id <id>       Coordinator/owner/creator binding (default: OPENCLAW_COORDINATOR_ID or teamlead)',
    '  --goal-prefix <text>        Goal prefix (default: "Burst smoke")',
    '  --title-prefix <text>       Title prefix (default: "Burst smoke")',
    '  --create-tracker true|false Create tracker for each root (default: false)',
    '  --chat-id <id>              Explicit tracker chat_id when create-tracker=true',
    '  --topic-id <id>             Explicit tracker topic_id when create-tracker=true',
    '  --delay-ms <N>              Delay between root creations (default: 0)',
    '  --status <name>             Snapshot list-orchestrations status (default: active)',
    '  --cleanup true|false        Force-close created roots at the end (default: false)',
    '  --help                      Show this help',
  ];
  process.stdout.write(`${help.join('\n')}\n`);
}

function buildCreateArgs(config, taskId, index) {
  const args = [
    'orchestrate-fanout',
    '--task-id', taskId,
    '--goal', `${config.goalPrefix} ${index + 1}`,
    '--title', `${config.titlePrefix} ${index + 1}`,
    '--agents', config.agents,
    '--coordinator-id', config.coordinatorId,
    '--owner-id', config.coordinatorId,
    '--close-owner-id', config.coordinatorId,
    '--creator-id', config.coordinatorId,
    '--create-tracker', String(config.createTracker),
  ];
  if (config.chatId) args.push('--chat-id', config.chatId);
  if (config.topicId) args.push('--topic-id', config.topicId);
  return args;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const roots = parsePositiveInteger(options.roots, 5);
  const delayMs = parsePositiveInteger(options.delay_ms, 0);
  const config = {
    roots,
    agents: String(options.agents || 'coder,tester').trim(),
    coordinatorId: String(options.coordinator_id || process.env.OPENCLAW_COORDINATOR_ID || 'teamlead').trim(),
    goalPrefix: String(options.goal_prefix || 'Burst smoke').trim() || 'Burst smoke',
    titlePrefix: String(options.title_prefix || 'Burst smoke').trim() || 'Burst smoke',
    createTracker: parseBoolean(options.create_tracker, false),
    chatId: String(options.chat_id || '').trim(),
    topicId: String(options.topic_id || '').trim(),
    status: String(options.status || 'active').trim() || 'active',
    cleanup: parseBoolean(options.cleanup, false),
  };

  const stamp = Date.now();
  const created = [];
  const rejected = [];

  for (let index = 0; index < config.roots; index += 1) {
    const taskId = `burst-${stamp}-${index + 1}`;
    const result = runOcr(buildCreateArgs(config, taskId, index), { allowFailure: true });
    if (result.json.ok) {
      created.push(result.json);
    } else {
      rejected.push({ task_id: taskId, ...result.json });
    }
    sleep(delayMs);
  }

  const activeSnapshot = runOcr(['list-orchestrations', '--status', config.status, '--limit', String(Math.max(roots * 2, 20))]).json;

  const cleanup = [];
  if (config.cleanup) {
    for (const orchestration of created) {
      const closed = runOcr([
        'close-orchestration',
        '--task-id', orchestration.task_id,
        '--actor-id', config.coordinatorId,
        '--result', 'fail',
        '--summary', 'burst smoke cleanup',
        '--force', 'true',
      ], { allowFailure: true }).json;
      cleanup.push(closed);
    }
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    config,
    created_count: created.length,
    rejected_count: rejected.length,
    created: created.map((entry) => ({
      task_id: entry.task_id,
      run_id: entry.run_id,
      child_count: entry.child_count,
      tracker: entry.tracker,
    })),
    rejected,
    active_snapshot,
    cleanup,
  }, null, 2)}\n`);
}

main();
