#!/usr/bin/env node
/**
 * ocr/index.mjs — openclaw-redis CLI entry point
 * Modular version. Zero npm dependencies.
 * JSON-in, JSON-out. Calls redis-cli via child_process.
 *
 * Usage: node ocr/index.mjs <command> [args...]
 * Or via symlink: ocr <command> [args...]
 *
 * Exit codes:
 *   0 — success
 *   1 — business error (Redis works, but logic failed: no_tasks, locked, etc.)
 *   2 — infrastructure error (connection refused, timeout, OOM)
 *   3 — argument error (wrong command / missing args)
 */

import { output } from './lib/errors.mjs';

import { cmdInit, cmdPushTask, cmdClaimTask, cmdCompleteTask, cmdFailTask, cmdListPending } from './commands/tasks.mjs';
import { cmdSetStatus, cmdGetStatus, cmdHeartbeat } from './commands/agents.mjs';
import { cmdLock, cmdUnlock, cmdLockBranch, cmdUnlockBranch, cmdRenewBranchLock, cmdListLocks } from './commands/locks.mjs';
import { cmdEmit, cmdWatch } from './commands/events.mjs';
import { cmdQueueMessage, cmdDrainMessages, cmdListMessages } from './commands/mailbox.mjs';
import { cmdQueueInsight, cmdListInsights, cmdPromoteInsight, cmdDismissInsight } from './commands/insights.mjs';
import { cmdRoundtableCreate, cmdRoundtableContribute, cmdRoundtableRead, cmdRoundtableSynthesize, cmdRoundtableTally, cmdRoundtableList, cmdRoundtableStatus } from './commands/roundtable.mjs';
import { cmdDashboard } from './commands/dashboard.mjs';
import { cmdStatusQuery, cmdLocksQuery } from './commands/status-query.mjs';
import { cmdReconcileStatuses } from './commands/reconcile-statuses.mjs';
import { cmdStartLoop, cmdLoopResult, cmdLoopStatus, cmdLoopList } from './commands/feedback-loop.mjs';
import { cmdRouteTask } from './commands/router.mjs';
import { cmdStartPipeline, cmdAdvancePipeline, cmdGetPipeline, cmdListPipelines } from './commands/pipelines.mjs';
import { cmdRecoverTasks } from './commands/recover-tasks.mjs';
import { cmdWatchdog } from './commands/watchdog.mjs';
import { cmdTaskStatusCreate, cmdTaskStatusJoin, cmdTaskStatusUpdate, cmdTaskStatusClose } from './commands/task-status.mjs';
import { cmdBugReport, cmdBugList, cmdBugFix, cmdBugWontfix, cmdBugAssign, cmdBugDetail } from './commands/bugs.mjs';
import { cmdGc } from './commands/gc.mjs';
import { cmdLifecycleRun, cmdLifecycleStart, cmdLifecycleStop, cmdLifecycleUpdate, cmdLifecycleBeat, cmdLifecycleList } from './commands/lifecycle.mjs';
import { cmdCostLog, cmdCostReport } from './commands/costs.mjs';

// ─── Command Registry ────────────────────────────────────────────────────────

const COMMANDS = {
  'init':            ()  => cmdInit(),
  'push-task':       (a) => cmdPushTask(a[0]),
  'claim-task':      (a) => cmdClaimTask(a[0], a[1]),
  'complete-task':   (a) => cmdCompleteTask(a[0], a[1]),
  'fail-task':       (a) => cmdFailTask(a[0], a[1]),
  'list-pending':    (a) => cmdListPending(a[0]),
  'set-status':      (a) => cmdSetStatus(a[0], a[1]),
  'get-status':      (a) => cmdGetStatus(a[0]),
  'heartbeat':       (a) => cmdHeartbeat(a[0]),
  'lock':              (a) => cmdLock(a[0], a[1], a[2]),
  'unlock':            (a) => cmdUnlock(a[0], a[1]),
  'lock-branch':       (a) => cmdLockBranch(a[0], a[1], a[2]),
  'unlock-branch':     (a) => cmdUnlockBranch(a[0], a[1]),
  'renew-branch-lock': (a) => cmdRenewBranchLock(a[0], a[1], a[2]),
  'list-locks':        (a) => cmdListLocks(a),
  'emit':            (a) => cmdEmit(a[0], a[1]),
  'watch':           (a) => cmdWatch(a[0]),
  'queue-message':   (a) => cmdQueueMessage(a[0]),
  'drain-messages':  ()  => cmdDrainMessages(),
  'list-messages':   ()  => cmdListMessages(),
  'queue-insight':   (a) => cmdQueueInsight(a[0]),
  'list-insights':   (a) => cmdListInsights(a),
  'promote-insight': (a) => cmdPromoteInsight(a[0]),
  'dismiss-insight': (a) => cmdDismissInsight(a[0]),
  'dashboard':       ()  => cmdDashboard(),
  'status-query':    (a) => cmdStatusQuery(a),
  'locks-query':     (a) => cmdLocksQuery(a),
  'reconcile-statuses': (a) => cmdReconcileStatuses(a),
  'roundtable-create':     (a) => cmdRoundtableCreate(a),
  'roundtable-contribute': (a) => cmdRoundtableContribute(a),
  'roundtable-read':       (a) => cmdRoundtableRead(a),
  'roundtable-synthesize': (a) => cmdRoundtableSynthesize(a),
  'roundtable-tally':      (a) => cmdRoundtableTally(a),
  'roundtable-list':       (a) => cmdRoundtableList(a),
  'roundtable-status':     (a) => cmdRoundtableStatus(a),
  'start-loop':            (a) => cmdStartLoop(a),
  'loop-result':           (a) => cmdLoopResult(a),
  'loop-status':           (a) => cmdLoopStatus(a),
  'loop-list':             (a) => cmdLoopList(a),
  'route-task':            (a) => cmdRouteTask(a),
  'recover-tasks':         (a) => cmdRecoverTasks(a),
  'watchdog':              (a) => cmdWatchdog(a),
  'start-pipeline':        (a) => cmdStartPipeline(a),
  'advance-pipeline':      (a) => cmdAdvancePipeline(a),
  'get-pipeline':          (a) => cmdGetPipeline(a),
  'list-pipelines':        (a) => cmdListPipelines(a),
  'task-status-create':    (a) => cmdTaskStatusCreate(a),
  'task-status-join':      (a) => cmdTaskStatusJoin(a),
  'task-status-update':    (a) => cmdTaskStatusUpdate(a),
  'task-status-close':     (a) => cmdTaskStatusClose(a),
  'bug-report':            (a) => cmdBugReport(a),
  'bug-list':              (a) => cmdBugList(a),
  'bug-fix':               (a) => cmdBugFix(a),
  'bug-wontfix':           (a) => cmdBugWontfix(a),
  'bug-assign':            (a) => cmdBugAssign(a),
  'bug-detail':            (a) => cmdBugDetail(a),
  'gc':                    (a) => cmdGc(a),

  // Cost tracking:
  'cost-log':              (a) => cmdCostLog(a),
  'cost-report':           (a) => cmdCostReport(a),

  // Agent Lifecycle (automated heartbeat + status management):
  'lifecycle': async (a) => {
    const sub = a[0];
    const rest = a.slice(1);
    const SUBCOMMANDS = {
      'run':    (r) => cmdLifecycleRun(r),
      'start':  (r) => cmdLifecycleStart(r),
      'stop':   (r) => cmdLifecycleStop(r),
      'update': (r) => cmdLifecycleUpdate(r),
      'beat':   (r) => cmdLifecycleBeat(r),
      'list':   ()  => cmdLifecycleList(),
    };
    if (!sub || !SUBCOMMANDS[sub]) {
      const available = Object.keys(SUBCOMMANDS).join(', ');
      output({ ok: false, error: 'arg_error', message: `Usage: ocr lifecycle <${available}>` });
      process.exitCode = 3;
      return;
    }
    await SUBCOMMANDS[sub](rest);
  },

  // Daemon launcher — run background services via `ocr daemon <name>`
  'daemon': async (a) => {
    const DAEMONS = {
      'status-watchdog': './status-watchdog.mjs',
      'task-status':     './task-status-watcher.mjs',
      'lifecycle':       './lifecycle-daemon.mjs',
    };
    const name = a[0];
    if (!name || !DAEMONS[name]) {
      const available = Object.keys(DAEMONS).join(', ');
      output({ ok: false, error: 'arg_error', message: `Usage: ocr daemon <${available}>` });
      process.exitCode = 3;
      return;
    }
    const daemonModule = await import(DAEMONS[name]);
    if (name === 'task-status' && typeof daemonModule.startTaskStatusWatcher === 'function') {
      await daemonModule.startTaskStatusWatcher();
      return;
    }
  },
};

// ─── Help ────────────────────────────────────────────────────────────────────

function printHelp() {
  const help = [
    'ocr — openclaw-redis CLI',
    '',
    'Usage: ocr <command> [args...]',
    '',
    'Task Lifecycle:',
    '  init                                — create consumer groups (idempotent)',
    '  push-task <json>                    — create a task',
    '  claim-task <agent-id> [group]       — atomically claim a task',
    '  complete-task <task-id> <json>      — mark task done with result',
    '  fail-task <task-id> <reason>        — mark task failed',
    '  list-pending [group]                — list pending tasks',
    '',
    'Agent State:',
    '  set-status <agent-id> <json>        — update agent status/progress',
    '  get-status <agent-id>               — get agent status',
    '  heartbeat <agent-id>                — update heartbeat (TTL 60s)',
    '',
    'Locks:',
    '  lock <resource> <agent-id> [ttl]    — acquire lock (default TTL 300s)',
    '  unlock <resource> <agent-id>        — release lock (safe: checks owner)',
    '',
    'Branch Locks:',
    '  lock-branch <branch> <agent-id> [ttl]       — lock branch (default TTL 1800s)',
    '  unlock-branch <branch> <agent-id>            — release branch lock',
    '  renew-branch-lock <branch> <agent-id> [ttl]  — extend branch lock TTL',
    '  list-locks [--kind branch]                    — list active locks',
    '',
    'Events:',
    '  emit <event-type> <json>            — write event to stream',
    '  watch [last-id]                     — read events (blocking, 10s timeout)',
    '',
    'Restart Mailbox:',
    '  queue-message <json>                — enqueue message before restart (text required)',
    '  drain-messages                      — read and delete all pending messages (atomic)',
    '  list-messages                       — read pending messages without deleting',
    '',
    'Insight Staging (mem0 pre-cache):',
    '  queue-insight <json>                — record insight/idea (text, source required; confidence, tags optional)',
    '  list-insights [--limit N] [--source S] [--confidence C] [--promoted]  — list insights (--promoted for promoted set)',
    '  promote-insight <insight-id>        — move insight to promoted set (ready for mem0)',
    '  dismiss-insight <insight-id>        — remove insight (noise)',
    '',
    'Task Recovery:',
    '  recover-tasks [--idle-ms 300000] [--agent cleanup]  — XCLAIM orphaned tasks idle > threshold',
    '  watchdog [--idle-ms 300000] [--group <name>] [--dry-run]  — requeue orphaned tasks safely (for cron)',
    '',
    'Queries (Telegram /status, /locks):',
    '  status-query [filter]               — agent status summary (filters: active, blocked, <agent>, branch <name>)',
    '  locks-query [--kind branch]         — list active locks',
    '  reconcile-statuses [--dry-run] [--agents a,b] [--auto-idle-ms N] [--active-stale-grace-ms N] [--stale-to-idle-ms N]',
    '                                      — one-shot lifecycle reconcile for agent statuses',
    '',
    'System:',
    '  dashboard                           — unified system status (agents, tasks, insights, messages)',
    '',
    'Roundtable (multi-agent deliberation):',
    '  roundtable-create --topic <text> {--participants <csv> | --template <name>} [--context <text>] [--constraints <text>]',
    '  roundtable-contribute <rt_id> --agent <id> --round <N> --summary <text> [--findings <text>] [--recommendations <text>] [--agrees_with <text>] [--disagrees_with <text>] [--questions <text>]',
    '  roundtable-read <rt_id> [--round <N>]',
    '  roundtable-synthesize <rt_id> --synthesis <text>',
    '  roundtable-tally <rt_id> [--round <N>]                 — count agree/disagree votes, show consensus',
    '  roundtable-status <rt_id>                               — read-only metadata + summary tally (no transcript)',
    '  roundtable-list [--status active|completed] [--limit N]',
    '',
    'Feedback Loops (autonomous agent iterations):',
    '  start-loop --type <code-test|code-review|test-devops> --task-id <id> --initiator <agent> --target <agent> [--context <json>]',
    '  loop-result --loop-id <id> --agent <agent> --verdict <pass|fail|fix> [--details <json>]',
    '  loop-status --loop-id <id>                  — detailed loop status',
    '  loop-status --active                        — list active loops',
    '  loop-list [--status active|completed|escalated] [--limit N]',
    '',
    'Task Routing (auto-routing engine):',
    '  route-task <json>                            — route task to agent+pipeline by keywords/type',
    '    Input: {"text":"...","source":"telegram","metadata":{"type":"feature"}}',
    '',
    'Pipelines (multi-step orchestration):',
    '  start-pipeline --task-id <id> --template <name> [--context <json>]',
    '  advance-pipeline --pipeline-id <id> --result <json>',
    '  get-pipeline --pipeline-id <id>',
    '  list-pipelines [--status active|completed|escalated] [--limit N]',
    '    Templates: feature_delivery, incident_response, security_fix, research_to_build,',
    '               documentation, digest, health_check, code_review',
    '',
    '',
    'Bug Tracker:',
    '  bug-report <severity> \'<desc>\' [--reporter <agent>]   — report a bug (P0/P1/P2/P3)',
    '  bug-list [--status open|fixed|wontfix|all] [--severity P0-P3] [--reporter <agent>]',
    '  bug-fix <bug-id> [--comment \'<text>\']                  — close as fixed',
    '  bug-wontfix <bug-id> [--comment \'<text>\']              — close as wontfix',
    '  bug-assign <bug-id> <agent>                            — assign bug to agent',
    '  bug-detail <bug-id>                                    — show bug details',
    '',
    'Task-Scoped Status (live status in topic):',
    '  task-status-create --task-id <id> --topic-id <id> --title "..." --agents coder,tester --coordinator-id <id> [--owner-id <id>] [--chat-id <id>]',
    '  task-status-join   --task-id <id> --agent-id <agent>       — join existing task (append-only)',
    '  task-status-update --task-id <id> [--force]                 — refresh status message',
    '  task-status-close  --task-id <id> --result success|fail --actor-id <id>  — finalize (coordinator/owner only)',
    '',
    'Garbage Collection:',
    '  gc [--dry-run]                                       — clean stale keys, trim streams',
    '',
    'Daemons (background services):',
    '  daemon status-watchdog                               — run agent status reconciler',
    '  daemon task-status                                   — run task-status watcher',
    '  daemon lifecycle                                      — run automated heartbeat keeper (subscribes to status events)',
    '',
    'Agent Lifecycle (automated heartbeat + status management):',
    '  lifecycle start <agent-id> [--run-id <id>] [--step <text>] [--heartbeat-ms <ms>]',
    '                                                             — start managed lifecycle with heartbeat loop',
    '  lifecycle run <agent-id> [--run-id <id>] [--step <text>] <shell-command...>',
    '                                                             — execute command with full lifecycle (start/heartbeat/complete/fail)',
    '  lifecycle update <agent-id> <json>                      — update status of active lifecycle run',
    '  lifecycle beat <agent-id>                               — send single heartbeat',
    '  lifecycle stop <agent-id> [--status completed|failed]    — stop lifecycle run',
    '  lifecycle list                                          — list active in-process lifecycle runs',
    '',
    'Exit codes: 0=ok, 1=business error, 2=infra error, 3=arg error',
    '',
    'Env: REDIS_HOST, REDIS_PORT, REDIS_PASSWORD',
    'Secret: /run/secrets/redis_password',
  ].join('\n');
  process.stdout.write(help + '\n');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const [, , command, ...args] = process.argv;

  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'unknown_command', command, message: `Unknown command: ${command}. Run ocr --help.` }) + '\n');
    process.exitCode = 3;
    return;
  }

  try {
    await handler(args);
  } catch (err) {
    if (err.isArgError) {
      process.stdout.write(JSON.stringify({ ok: false, error: 'arg_error', message: err.message }) + '\n');
      process.exitCode = 3;
      return;
    }
    if (err.infraCode) {
      const out = { ok: false, error: err.infraCode, message: err.message };
      if (err.oom) out.hint = 'Run: ocr emit alert \'{"type":"oom","message":"Redis OOM"}\'';
      process.stdout.write(JSON.stringify(out) + '\n');
      process.exitCode = 2;
      return;
    }
    // Unexpected error
    process.stdout.write(JSON.stringify({ ok: false, error: 'unexpected', message: String(err.message || err) }) + '\n');
    process.exitCode = 2;
  }
}

main();
