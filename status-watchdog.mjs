#!/usr/bin/env node
/**
 * status-watchdog.mjs — dedicated lifecycle reconcile runtime
 *
 * Keeps technical agent lifecycle transitions isolated from Telegram delivery concerns.
 * Safe default: standalone polling daemon.
 */
import { reconcileAllStatuses, DEFAULT_RECONCILE_THRESHOLDS } from './lib/status-reconcile.mjs';

const RECONCILE_INTERVAL_MS = parseInt(process.env.OPENCLAW_STATUS_RECONCILE_INTERVAL_MS || '120000', 10);
const THRESHOLDS = {
  ...DEFAULT_RECONCILE_THRESHOLDS,
  autoIdleMs: parseInt(process.env.OPENCLAW_STATUS_AUTO_IDLE_MS || String(DEFAULT_RECONCILE_THRESHOLDS.autoIdleMs), 10),
  activeStaleGraceMs: parseInt(process.env.OPENCLAW_STATUS_ACTIVE_STALE_GRACE_MS || String(DEFAULT_RECONCILE_THRESHOLDS.activeStaleGraceMs), 10),
  staleToIdleMs: parseInt(process.env.OPENCLAW_STATUS_STALE_TO_IDLE_MS || String(DEFAULT_RECONCILE_THRESHOLDS.staleToIdleMs), 10),
};

let running = true;

function log(message) {
  const ts = new Date().toISOString();
  console.error(`[status-watchdog ${ts}] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shutdown(signal) {
  log(`Received ${signal}, shutting down...`);
  running = false;
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function main() {
  log('Status Watchdog starting...');
  log(`Thresholds: autoIdle=${THRESHOLDS.autoIdleMs}ms activeStaleGrace=${THRESHOLDS.activeStaleGraceMs}ms staleToIdle=${THRESHOLDS.staleToIdleMs}ms interval=${RECONCILE_INTERVAL_MS}ms`);

  while (running) {
    try {
      const result = reconcileAllStatuses({
        thresholds: THRESHOLDS,
        logger: (msg) => log(msg),
      });

      if (result.changed > 0) {
        log(`Applied ${result.changed} lifecycle transition(s)`);
      }
    } catch (err) {
      log(`Reconcile tick failed: ${err.message}`);
    }

    if (!running) break;
    await sleep(RECONCILE_INTERVAL_MS);
  }

  log('Status Watchdog stopped.');
}

main().catch((err) => {
  log(`Fatal error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
