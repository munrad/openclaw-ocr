/**
 * lib/pubsub.mjs — Optional Redis Pub/Sub for agent status fast-path
 *
 * Feature flag: STATUS_PUBSUB_ENABLED (env, default: on)
 *
 * Architecture rules:
 * - Pub/Sub is ONLY an optional fast-path fanout, NOT source of truth
 * - Source of truth remains: status hash + heartbeat TTL + events stream
 * - Publish ONLY AFTER successful write to hash + stream event
 * - Subscriber MUST do full resync from persisted state on reconnect/restart
 * - Publish errors MUST NOT break the main flow (fire-and-forget)
 */
import { spawn } from 'node:child_process';
import { CONFIG } from './config.mjs';

export const PUBSUB_CHANNEL = 'openclaw:agent-status:notify';

/**
 * Check if Pub/Sub feature flag is enabled.
 * Zero overhead when disabled — no Redis calls, no subscriptions.
 */
export function isPubSubEnabled() {
  const val = process.env.STATUS_PUBSUB_ENABLED ?? '1';
  return val !== '0' && val.toLowerCase() !== 'false';
}

/**
 * Fire-and-forget publish of agent status notification.
 * Only publishes if STATUS_PUBSUB_ENABLED is on.
 * Errors are silently caught — never breaks the caller.
 *
 * @param {object} payload - { agent, state, step, run_epoch, updated_at }
 * @param {function} [logger] - optional log function
 */
export function publishStatusNotify(payload, logger) {
  if (!isPubSubEnabled()) return;

  try {
    const json = JSON.stringify(payload);
    const args = [
      '-h', CONFIG.host,
      '-p', CONFIG.port,
      '--no-auth-warning',
    ];
    if (CONFIG.password) {
      args.push('-a', CONFIG.password);
    }
    args.push('PUBLISH', PUBSUB_CHANNEL, json);

    // Fire-and-forget: spawn redis-cli, don't wait for result
    const proc = spawn('redis-cli', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    proc.on('error', (err) => {
      if (logger) logger(`Pub/Sub publish error (ignored): ${err.message}`);
    });

    // Unref so it doesn't keep the parent process alive
    proc.unref();
  } catch (err) {
    // Fire-and-forget: never throw
    if (logger) logger(`Pub/Sub publish error (ignored): ${err.message}`);
  }
}

/**
 * Subscribe to agent status notifications via Redis SUBSCRIBE.
 * Returns an object with { process, on, close } for managing the subscription.
 *
 * Only call if isPubSubEnabled() is true.
 *
 * @param {function} onMessage - callback(payload: object) for each notification
 * @param {function} [logger] - optional log function
 * @returns {{ close: function }} subscription handle
 */
export function subscribeStatusNotify(onMessage, logger) {
  const log = logger || (() => {});

  const args = [
    '-h', CONFIG.host,
    '-p', CONFIG.port,
    '--no-auth-warning',
  ];
  if (CONFIG.password) {
    args.push('-a', CONFIG.password);
  }
  args.push('SUBSCRIBE', PUBSUB_CHANNEL);

  const proc = spawn('redis-cli', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';
  let closed = false;

  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    // redis-cli SUBSCRIBE output format:
    // 1) "subscribe"
    // 2) "channel-name"
    // 3) (integer) 1
    // Then for each message:
    // 1) "message"
    // 2) "channel-name"
    // 3) "json-payload"
    //
    // We look for "message" markers and extract the payload line after channel name.
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // keep incomplete last line

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim().replace(/^\d+\)\s*/, '').replace(/^"(.*)"$/, '$1');
      if (line === 'message') {
        // Next two lines: channel name, then payload
        // Channel is at i+1, payload at i+2
        const payloadIdx = i + 2;
        if (payloadIdx < lines.length) {
          const raw = lines[payloadIdx].trim().replace(/^\d+\)\s*/, '').replace(/^"(.*)"$/, '$1');
          try {
            const payload = JSON.parse(raw);
            onMessage(payload);
          } catch (err) {
            log(`Pub/Sub parse error (ignored): ${err.message}`);
          }
          i = payloadIdx; // skip processed lines
        }
      }
    }
  });

  proc.stderr.on('data', (chunk) => {
    const msg = chunk.toString().trim();
    if (msg) log(`Pub/Sub subscriber stderr: ${msg}`);
  });

  proc.on('close', (code) => {
    if (!closed) {
      log(`Pub/Sub subscriber exited with code ${code}`);
    }
  });

  proc.on('error', (err) => {
    log(`Pub/Sub subscriber error: ${err.message}`);
  });

  return {
    close() {
      closed = true;
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    },
    get pid() { return proc.pid; },
  };
}
