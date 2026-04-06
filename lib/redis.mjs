/**
 * lib/redis.mjs — redis-cli execution + output parsers
 */
import { execSync } from 'node:child_process';
import { CONFIG } from './config.mjs';
import { infraError } from './errors.mjs';

/**
 * Run redis-cli with the given args array.
 * Returns raw stdout string.
 */
export function redisRaw(args) {
  const base = [
    'redis-cli',
    '-h', CONFIG.host,
    '-p', CONFIG.port,
    '-n', String(CONFIG.db || 0),
    '--no-auth-warning',
  ];
  if (CONFIG.password) {
    base.push('-a', CONFIG.password);
  }
  const fullArgs = [...base, ...args];
  // Shell-escape each arg
  const cmd = fullArgs.map(a => {
    const s = String(a);
    // Wrap in single quotes, escape existing single quotes
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }).join(' ');

  try {
    const out = execSync(cmd, {
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out;
  } catch (err) {
    const msg = String(err.stderr || err.stdout || err.message || '');

    // OOM — don't retry
    if (msg.includes('OOM') || msg.includes('out of memory')) {
      const e = infraError('oom', 'Redis out of memory. Check maxmemory config.');
      e.oom = true;
      throw e;
    }
    // AUTH error — don't retry
    if (msg.includes('WRONGPASS') || msg.includes('NOAUTH') || msg.includes('ERR AUTH')) {
      throw infraError('auth_error', `Redis auth failed: ${msg.trim()}`);
    }
    // Connection errors — retryable
    if (msg.includes('Connection refused') || msg.includes('ECONNREFUSED') || err.code === 'ECONNREFUSED') {
      throw infraError('ECONNREFUSED', `Could not connect to ${CONFIG.host}:${CONFIG.port}`);
    }
    if (msg.includes('timed out') || msg.includes('ETIMEDOUT')) {
      throw infraError('ETIMEDOUT', `Connection to ${CONFIG.host}:${CONFIG.port} timed out`);
    }
    if (msg.includes('LOADING')) {
      throw infraError('LOADING', 'Redis is loading dataset');
    }
    if (msg.includes('BUSY')) {
      throw infraError('BUSY', 'Redis is busy with a Lua script');
    }
    // Generic
    throw infraError('redis_error', `redis-cli error: ${msg.trim() || err.message}`);
  }
}

/**
 * Run a redis-cli command and return parsed output.
 * For simple scalar responses (OK, integer, bulk string).
 */
export function redis(...args) {
  return redisRaw(args).trim();
}

/**
 * Run redis-cli and parse multiline bulk reply as array of lines.
 */
export function redisLines(...args) {
  return redisRaw(args).split('\n').map(l => l.trim()).filter(Boolean);
}

// ─── Concurrency: Advisory Lock ──────────────────────────────────────────────

const UNLOCK_LUA = `if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`;

/**
 * Execute `fn` while holding an advisory lock on `lockKey`.
 * Uses SET NX EX for atomic acquire, Lua DEL for atomic release.
 * If lock cannot be acquired within `waitMs`, throws infraError.
 *
 * @param {string} lockKey  — Redis key for the lock
 * @param {Function} fn     — async function to execute under lock
 * @param {object} [opts]
 * @param {number} [opts.ttl=10]    — lock TTL in seconds
 * @param {number} [opts.waitMs=3000] — max time to wait for lock
 * @param {number} [opts.retryMs=50]  — retry interval
 * @returns {*} result of fn()
 */
export async function withLock(lockKey, fn, opts = {}) {
  const ttl = opts.ttl || 10;
  const waitMs = opts.waitMs || 3000;
  const retryMs = opts.retryMs || 50;
  const token = `${process.pid}-${Date.now()}`;

  const deadline = Date.now() + waitMs;
  let acquired = false;

  while (Date.now() < deadline) {
    const res = redis('SET', lockKey, token, 'NX', 'EX', String(ttl));
    if (res === 'OK') {
      acquired = true;
      break;
    }
    await new Promise(r => setTimeout(r, retryMs));
  }

  if (!acquired) {
    throw infraError('lock_timeout', `Could not acquire lock ${lockKey} within ${waitMs}ms`);
  }

  try {
    return await fn();
  } finally {
    try { redis('EVAL', UNLOCK_LUA, '1', lockKey, token); } catch { /* best effort */ }
  }
}

// ─── Parsers ─────────────────────────────────────────────────────────────────

export function parseJson(str, fallback = null) {
  try { return JSON.parse(str); } catch { return fallback; }
}

/**
 * Parse HGETALL output: flat list of key/value alternating lines.
 * redis-cli returns:
 *   1) "field1"
 *   2) "value1"
 *   3) "field2"
 *   4) "value2"
 */
export function parseHgetall(raw) {
  // redis-cli HGETALL outputs alternating key/value lines.
  // Empty string values appear as empty lines — we must preserve them.
  // Format varies:
  //   With numbers:  1) "key"\n2) "value"  (or 2) "" for empty)
  //   Without:       key\nvalue  (or empty line for empty value)
  //
  // Strategy: split by \n, detect numbered vs plain format,
  // strip decorations but keep empty values.
  const lines = raw.split('\n');
  const obj = {};

  // Detect numbered format (lines starting with "N) ")
  const numbered = lines.some(l => /^\d+\)\s/.test(l.trim()));

  if (numbered) {
    // Numbered format: every entry has "N) " prefix, even empty values show as N) ""
    const clean = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!/^\d+\)\s/.test(trimmed)) continue; // skip non-numbered lines
      const val = trimmed.replace(/^\d+\)\s*/, '').replace(/^"(.*)"$/, '$1');
      clean.push(val);
    }
    for (let i = 0; i < clean.length - 1; i += 2) {
      obj[clean[i]] = clean[i + 1];
    }
  } else {
    // Plain format: key and value on alternating lines.
    // Empty values = empty lines. Trailing newline produces one extra empty element.
    // Remove only the very last element if it's empty (trailing \n artifact).
    const trimmedLines = lines.map(l => l.trim());
    if (trimmedLines.length > 0 && trimmedLines[trimmedLines.length - 1] === '') {
      trimmedLines.pop();
    }
    // Now pair them up. We need even count.
    for (let i = 0; i < trimmedLines.length - 1; i += 2) {
      obj[trimmedLines[i]] = trimmedLines[i + 1];
    }
  }
  return obj;
}

/**
 * Parse XREAD / XREADGROUP / XRANGE output.
 * redis-cli raw output (non-JSON mode):
 *   1) "stream-name"
 *   2) 1) 1) "1234567890-0"
 *         2) 1) "field"
 *            2) "value"
 *            ...
 */
export function parseXread(raw) {
  const entries = [];
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);

  let i = 0;
  // Skip stream name line(s)
  while (i < lines.length) {
    const line = lines[i].replace(/^\d+\)\s*/, '').replace(/^"(.*)"$/, '$1');
    // Entry IDs look like timestamp-seq
    if (/^\d+-\d+$/.test(line)) {
      const id = line;
      const fields = {};
      i++;
      // Collect field-value pairs until next ID or end
      const fieldLines = [];
      while (i < lines.length) {
        const next = lines[i].replace(/^\d+\)\s*/, '').replace(/^"(.*)"$/, '$1');
        if (/^\d+-\d+$/.test(next)) break;
        fieldLines.push(next);
        i++;
      }
      for (let j = 0; j < fieldLines.length - 1; j += 2) {
        fields[fieldLines[j]] = fieldLines[j + 1];
      }
      // Reconstruct data
      const entry = { id, ...fields };
      if (entry.data) {
        entry.data = parseJson(entry.data, entry.data);
      }
      entries.push(entry);
    } else {
      i++;
    }
  }
  return entries;
}

/**
 * Parse XPENDING output.
 * Each entry is 4 logical items: msg_id, consumer, idle_ms, delivery_count
 * redis-cli formats:
 *   1) "msg-id"
 *   2) "consumer"
 *   3) (integer) idle_ms
 *   4) (integer) delivery_count
 */
export function parseXpending(raw) {
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const pending = [];
  const clean = lines.map(l => l.replace(/^\d+\)\s*/, '').replace(/^"(.*)"$/, '$1').replace(/^\(integer\)\s*/, ''));
  for (let i = 0; i + 3 < clean.length; i += 4) {
    pending.push({
      msg_id: clean[i],
      consumer: clean[i + 1],
      idle_ms: parseInt(clean[i + 2], 10) || 0,
      delivery_count: parseInt(clean[i + 3], 10) || 0,
    });
  }
  return pending;
}
