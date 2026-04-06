/**
 * commands/lifecycle.mjs — Lifecycle CLI commands for OCR
 *
 * Provides:
 *   ocr lifecycle start <agent-id> [--run-id <id>] [--step <text>] [--heartbeat-ms <ms>]
 *   ocr lifecycle stop <agent-id> [--run-id <id>]
 *   ocr lifecycle update <agent-id> <json>
 *   ocr lifecycle beat <agent-id>
 *   ocr lifecycle list
 *   ocr lifecycle run <agent-id> [--run-id <id>] [--step <text>] <shell-command...>
 */
import { output, argError } from '../lib/errors.mjs';
import { LifecycleManager, withLifecycle, listActiveRuns, stopAllRuns } from '../lib/lifecycle.mjs';

/**
 * One-shot lifecycle: start, execute a shell command, mark completed/failed.
 * Useful for cron jobs and script wrappers.
 */
export async function cmdLifecycleRun(args) {
  let agentId = null;
  let runId = null;
  let step = '';
  let heartbeatMs = null;
  let parentRunId = null;
  const commandParts = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--run-id' && args[i + 1]) { runId = args[++i]; }
    else if (arg === '--step' && args[i + 1]) { step = args[++i]; }
    else if (arg === '--heartbeat-ms' && args[i + 1]) { heartbeatMs = parseInt(args[++i], 10); }
    else if (arg === '--parent-run-id' && args[i + 1]) { parentRunId = args[++i]; }
    else if (!agentId) { agentId = arg; }
    else { commandParts.push(arg); }
  }

  if (!agentId) throw argError('lifecycle run requires <agent-id>');
  if (!commandParts.length) throw argError('lifecycle run requires a <shell-command> to execute');

  const cmd = commandParts.join(' ');

  const opts = { agentId, runId, step: step || `run: ${cmd.slice(0, 80)}` };
  if (heartbeatMs) opts.heartbeatMs = heartbeatMs;
  if (parentRunId) opts.parentRunId = parentRunId;

  const { execSync } = await import('node:child_process');

  await withLifecycle(opts, async (life) => {
    life.working(`exec: ${cmd.slice(0, 80)}`, 10);

    try {
      const result = execSync(cmd, {
        encoding: 'utf8',
        timeout: 600_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      life.working(`exec done`, 90);

      // Truncate output for status step
      const outputPreview = result.slice(0, 200).replace(/\n/g, ' ').trim();
      await life.complete(outputPreview || 'выполнено');

      output({
        ok: true,
        agent_id: agentId,
        run_id: life.runId,
        exit_code: 0,
        output_length: result.length,
      });
    } catch (err) {
      const stderr = (err.stderr || '').slice(0, 200).replace(/\n/g, ' ').trim();
      await life.fail(stderr || err.message);
      output({
        ok: false,
        agent_id: agentId,
        run_id: life.runId,
        exit_code: err.status || 1,
        error: stderr || err.message,
      });
    }
  });
}

/**
 * Start a managed lifecycle run (returns run handle, keeps heartbeat alive).
 * For interactive/scripted use where caller manages the lifecycle.
 */
export async function cmdLifecycleStart(args) {
  let agentId = null;
  let runId = null;
  let step = '';
  let heartbeatMs = null;
  let parentRunId = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--run-id' && args[i + 1]) { runId = args[++i]; }
    else if (args[i] === '--step' && args[i + 1]) { step = args[++i]; }
    else if (args[i] === '--heartbeat-ms' && args[i + 1]) { heartbeatMs = parseInt(args[++i], 10); }
    else if (args[i] === '--parent-run-id' && args[i + 1]) { parentRunId = args[++i]; }
    else if (!agentId) { agentId = args[i]; }
  }

  if (!agentId) throw argError('lifecycle start requires <agent-id>');

  const lifeOpts = { agentId, runId, step, heartbeatMs };
  if (parentRunId) lifeOpts.parentRunId = parentRunId;
  const life = new LifecycleManager(lifeOpts);
  await life.start(step);

  output({
    ok: true,
    agent_id: agentId,
    run_id: life.runId,
    run_epoch: life.runEpoch,
    handle: life.handle,
    heartbeat_ms: life.heartbeatMs,
    message: 'Lifecycle started. Heartbeat is running. Use "ocr lifecycle update" to change status, "ocr lifecycle stop" to finish.',
  });

  // Keep process alive for heartbeat. Exit on SIGINT/SIGTERM.
  const keepAlive = () => {
    life.stop();
    process.exit(0);
  };
  process.on('SIGINT', keepAlive);
  process.on('SIGTERM', keepAlive);

  // Block forever (timer.unref means process will still exit cleanly)
  await new Promise(() => {});
}

/**
 * Stop a lifecycle run with a terminal status.
 */
export async function cmdLifecycleStop(args) {
  let agentId = null;
  let status = 'completed';
  let step = '';
  let error = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--status' && args[i + 1]) { status = args[++i]; }
    else if (args[i] === '--step' && args[i + 1]) { step = args[++i]; }
    else if (args[i] === '--error' && args[i + 1]) { error = args[++i]; }
    else if (!agentId) { agentId = args[i]; }
  }

  if (!agentId) throw argError('lifecycle stop requires <agent-id>');

  // List active runs and stop matching ones
  const active = listActiveRuns();
  const matching = active.filter(r => r.agentId === agentId);

  if (!matching.length) {
    // No in-process run found — do a direct status write as fallback
    const { writeStatus } = await import('../lib/lifecycle.mjs');
    // Use a direct Redis write since LifecycleManager instance is not available
    output({
      ok: true,
      agent_id: agentId,
      message: 'No active in-process lifecycle found. Use "ocr set-status" to set terminal status directly.',
      hint: `ocr set-status ${agentId} '{"state":"${status}","step":"${step || status}"}'`,
    });
    return;
  }

  for (const run of matching) {
    // We can't call complete/fail without the LifecycleManager instance,
    // but we can stop the timer
    stopAllRuns();
  }

  output({
    ok: true,
    agent_id: agentId,
    stopped: matching.length,
  });
}

/**
 * Update status of a running lifecycle (or just set-status directly).
 */
export async function cmdLifecycleUpdate(args) {
  const agentId = args[0];
  const jsonArg = args[1];

  if (!agentId) throw argError('lifecycle update requires <agent-id> <json>');
  if (!jsonArg) throw argError('lifecycle update requires <json>');

  // Direct status update (works with or without active lifecycle)
  const { LifecycleManager } = await import('../lib/lifecycle.mjs');
  const temp = new LifecycleManager({ agentId, validateAgent: true });

  // Use the internal update which writes + publishes
  const patch = JSON.parse(jsonArg);
  patch.run_id = patch.run_id || temp.runId;
  patch.run_epoch = patch.run_epoch || temp.runEpoch;
  temp.update(patch);

  output({
    ok: true,
    agent_id: agentId,
    patch,
  });
}

/**
 * Send a single heartbeat.
 */
export async function cmdLifecycleBeat(args) {
  const agentId = args[0];
  if (!agentId) throw argError('lifecycle beat requires <agent-id>');

  const { sendHeartbeat } = await import('../lib/lifecycle.mjs');
  sendHeartbeat(agentId);

  output({ ok: true, agent_id: agentId });
}

/**
 * List active in-process lifecycle runs.
 */
export async function cmdLifecycleList() {
  // NOTE: listActiveRuns() returns only in-process lifecycles.
  // `lifecycle start` runs in a child process, so its lifecycle
  // won't appear here. Use `lifecycle run` for same-process lifecycle.
  const active = listActiveRuns();
  output({
    ok: true,
    count: active.length,
    runs: active,
    note: active.length === 0 ? 'Shows in-process lifecycles only. Use `lifecycle run` for integrated lifecycle.' : undefined,
  });
}
