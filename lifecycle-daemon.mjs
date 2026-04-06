#!/usr/bin/env node
/**
 * lifecycle-daemon.mjs — Background lifecycle heartbeat keeper
 *
 * Subscribes to agent_status_changed events via Redis Pub/Sub.
 * When an agent transitions to an active-like state (working, starting,
 * testing, reviewing, waiting), automatically starts a heartbeat loop.
 * When agent reaches terminal state (completed, failed, idle), stops the loop.
 *
 * This daemon ensures agents stay alive=True without requiring them to
 * manually call ocr heartbeat on every step.
 *
 * Usage: node lifecycle-daemon.mjs
 * Env: REDIS_HOST, REDIS_PORT, REDIS_PASSWORD
 */
import { subscribeStatusNotify } from './lib/pubsub.mjs';
import { withRetry, sleep } from './lib/retry.mjs';
import { redis, redisRaw, parseHgetall, parseJson } from './lib/redis.mjs';
import { KEYS, KNOWN_AGENTS } from './lib/schema.mjs';
import { writeDaemonHeartbeat } from './lib/daemon-heartbeat.mjs';

const HEARTBEAT_MS = parseInt(process.env.LIFECYCLE_HEARTBEAT_MS || '25000', 10);
const HEARTBEAT_TTL = 60;

/** @type {Map<string, { timer: NodeJS.Timeout, state: string, lastBeat: number }>} */
const trackedAgents = new Map();

const ACTIVE_STATES = new Set(['working', 'starting', 'testing', 'reviewing', 'waiting', 'blocked']);
const TERMINAL_STATES = new Set(['completed', 'failed', 'idle', 'stale']);

function log(msg) {
  const ts = new Date().toISOString();
  process.stderr.write(`[lifecycle-daemon ${ts}] ${msg}\n`);
}

function sendHeartbeat(agentId) {
  try {
    withRetry(() => {
      redis('SET', KEYS.heartbeat(agentId), 'alive', 'EX', String(HEARTBEAT_TTL));
      return true;
    }).catch(() => {});
  } catch {}
}

function startHeartbeatLoop(agentId) {
  if (trackedAgents.has(agentId)) return;

  log(`🔄 Starting heartbeat for ${agentId} (every ${HEARTBEAT_MS}ms)`);
  sendHeartbeat(agentId);

  const timer = setInterval(() => {
    sendHeartbeat(agentId);
    const entry = trackedAgents.get(agentId);
    if (entry) entry.lastBeat = Date.now();
  }, HEARTBEAT_MS);

  if (timer.unref) timer.unref();

  trackedAgents.set(agentId, {
    timer,
    state: 'unknown',
    lastBeat: Date.now(),
  });
}

function stopHeartbeatLoop(agentId) {
  const entry = trackedAgents.get(agentId);
  if (!entry) return;

  log(`⏹️ Stopping heartbeat for ${agentId} (was in ${entry.state})`);
  clearInterval(entry.timer);
  trackedAgents.delete(agentId);
}

function handleStatusNotify(payload) {
  const agentId = payload.agent;
  const state = payload.state;

  if (!agentId || !state) return;

  if (ACTIVE_STATES.has(state)) {
    startHeartbeatLoop(agentId);
    const entry = trackedAgents.get(agentId);
    if (entry) entry.state = state;
  } else if (TERMINAL_STATES.has(state)) {
    stopHeartbeatLoop(agentId);
  }
}

/**
 * Periodic sync: check all agent statuses and reconcile tracked heartbeats.
 * Catches cases where Pub/Sub missed events (reconnect, etc.)
 */
async function periodicSync() {
  writeDaemonHeartbeat('lifecycle-daemon');
  try {
    // Dynamic agent list from schema (single source of truth)
    // Also discover agents from Redis that may not be in schema
    const schemaAgents = new Set(KNOWN_AGENTS);
    try {
      const keys = withRetry(() => redisRaw(['KEYS', 'openclaw:agents:status:*']));
      for (const line of keys.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && trimmed.startsWith('openclaw:agents:status:')) {
          schemaAgents.add(trimmed.replace('openclaw:agents:status:', ''));
        }
      }
    } catch { /* best effort */ }
    const agents = [...schemaAgents];

    for (const agentId of agents) {
      let status = {};
      try {
        const raw = withRetry(() => redisRaw(['HGETALL', KEYS.agentStatus(agentId)]));
        status = parseHgetall(raw);
      } catch { continue; }

      const state = status.state || 'idle';

      if (ACTIVE_STATES.has(state)) {
        if (!trackedAgents.has(agentId)) {
          log(`🔄 Sync: found active agent ${agentId} (${state}), starting heartbeat`);
          startHeartbeatLoop(agentId);
        }
        const entry = trackedAgents.get(agentId);
        if (entry) entry.state = state;
      } else if (TERMINAL_STATES.has(state)) {
        if (trackedAgents.has(agentId)) {
          log(`⏹️ Sync: agent ${agentId} is ${state}, stopping heartbeat`);
          stopHeartbeatLoop(agentId);
        }
      }
    }
  } catch (err) {
    log(`Periodic sync failed: ${err.message}`);
  }
}

async function main() {
  log('Lifecycle Daemon starting...');
  log(`Heartbeat interval: ${HEARTBEAT_MS}ms, TTL: ${HEARTBEAT_TTL}s`);

  // Subscribe to status change notifications
  const sub = subscribeStatusNotify(
    (payload) => {
      try {
        handleStatusNotify(payload);
      } catch (err) {
        log(`Notify handler error: ${err.message}`);
      }
    },
    (msg) => log(msg)
  );

  log('Subscribed to agent status notifications');

  // Periodic sync every 60s as safety net
  const syncTimer = setInterval(async () => {
    await periodicSync();
  }, 60_000);
  if (syncTimer.unref) syncTimer.unref();

  // Initial sync
  await periodicSync();

  log(`Tracking ${trackedAgents.size} active agent(s)`);

  // Report tracked agents every 5 min
  const reportTimer = setInterval(() => {
    if (trackedAgents.size > 0) {
      const list = [...trackedAgents.keys()].join(', ');
      log(`📊 Active heartbeats: ${list}`);
    }
  }, 300_000);
  if (reportTimer.unref) reportTimer.unref();

  // Graceful shutdown
  const shutdown = (signal) => {
    log(`Received ${signal}, shutting down...`);
    for (const [agentId, entry] of trackedAgents) {
      clearInterval(entry.timer);
    }
    trackedAgents.clear();
    clearInterval(syncTimer);
    clearInterval(reportTimer);
    sub.close();
    log('Stopped.');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});
