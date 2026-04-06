/**
 * lib/daemon-heartbeat.mjs — Daemon-level heartbeat helpers
 *
 * Writes/reads per-daemon heartbeat keys so status-query can show
 * whether background services are alive.
 */
import { redis } from './redis.mjs';
import { KEYS } from './schema.mjs';

const DAEMON_HEARTBEAT_TTL = 60;

export function writeDaemonHeartbeat(daemonName) {
  try {
    redis('SET', KEYS.daemonHeartbeat(daemonName), String(Math.floor(Date.now() / 1000)), 'EX', String(DAEMON_HEARTBEAT_TTL));
  } catch { /* best effort, never crash daemon */ }
}

export function readDaemonHeartbeat(daemonName) {
  try {
    const val = redis('GET', KEYS.daemonHeartbeat(daemonName));
    if (!val || val === '(nil)') return null;
    return parseInt(val, 10);
  } catch { return null; }
}
