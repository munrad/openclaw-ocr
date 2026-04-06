/**
 * commands/reconcile-statuses.mjs — one-shot agent status lifecycle reconcile
 */
import { output, argError } from '../lib/errors.mjs';
import { KNOWN_AGENTS } from '../lib/schema.mjs';
import { reconcileAllStatuses, DEFAULT_RECONCILE_THRESHOLDS } from '../lib/status-reconcile.mjs';

function parseThresholdArg(flag, rawValue) {
  const value = parseInt(rawValue, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw argError(`${flag} must be a non-negative integer`);
  }
  return value;
}

export async function cmdReconcileStatuses(args = []) {
  let dryRun = false;
  let agentIds = null;
  const thresholds = { ...DEFAULT_RECONCILE_THRESHOLDS };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--agents' && args[i + 1]) {
      agentIds = args[i + 1].split(',').map((s) => s.trim()).filter(Boolean);
      i++;
    } else if (arg === '--auto-idle-ms' && args[i + 1]) {
      thresholds.autoIdleMs = parseThresholdArg('--auto-idle-ms', args[i + 1]);
      i++;
    } else if (arg === '--active-stale-grace-ms' && args[i + 1]) {
      thresholds.activeStaleGraceMs = parseThresholdArg('--active-stale-grace-ms', args[i + 1]);
      i++;
    } else if (arg === '--stale-to-idle-ms' && args[i + 1]) {
      thresholds.staleToIdleMs = parseThresholdArg('--stale-to-idle-ms', args[i + 1]);
      i++;
    }
  }

  const result = reconcileAllStatuses({
    dryRun,
    thresholds,
    agentIds: agentIds || KNOWN_AGENTS,
  });

  output(result);
}
