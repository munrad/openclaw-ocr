/**
 * commands/mailbox.mjs — Restart mailbox commands (queue/drain/list)
 */
import { withRetry } from '../lib/retry.mjs';
import { redis, redisRaw, parseJson } from '../lib/redis.mjs';
import { KEYS } from '../lib/schema.mjs';
import { output, argError } from '../lib/errors.mjs';

/**
 * Lua script for atomic drain: LRANGE + DEL in one transaction.
 * Returns the list contents before deletion.
 */
const DRAIN_SCRIPT = `
local msgs = redis.call("LRANGE", KEYS[1], 0, -1)
if #msgs > 0 then
  redis.call("DEL", KEYS[1])
end
return msgs
`.trim();

/**
 * Parse raw LRANGE / EVAL list output into array of JSON objects.
 */
function parseListOutput(raw) {
  const trimmed = raw.trim();
  const messages = [];

  if (trimmed && trimmed !== '(empty array)' && trimmed !== '(nil)' && trimmed !== 'nil') {
    const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);
    const clean = lines.map(l => l.replace(/^\d+\)\s*/, '').replace(/^"(.*)"$/, '$1'));
    for (const item of clean) {
      if (!item || item === '(empty array)') continue;
      // Unescape \" inside the JSON string (redis-cli escapes quotes)
      const unescaped = item.replace(/\\"/g, '"');
      const parsed = parseJson(unescaped);
      if (parsed) messages.push(parsed);
    }
  }

  return messages;
}

export async function cmdQueueMessage(jsonArg) {
  if (!jsonArg) throw argError('queue-message requires <json>');
  const payload = parseJson(jsonArg);
  if (!payload) throw argError('queue-message: invalid JSON');
  if (!payload.text) throw argError('queue-message: "text" field is required');

  const message = {
    text: payload.text,
    target: payload.target || 'current',
    priority: payload.priority || 'normal',
    timestamp: new Date().toISOString(),
  };

  const position = await withRetry(() => {
    return redis('RPUSH', KEYS.restartMessages, JSON.stringify(message));
  });

  output({ ok: true, queued: true, position: parseInt(position, 10) });
}

export async function cmdDrainMessages() {
  const raw = await withRetry(() => {
    return redisRaw(['EVAL', DRAIN_SCRIPT, '1', KEYS.restartMessages]);
  });

  const messages = parseListOutput(raw);
  output({ ok: true, messages, count: messages.length });
}

export async function cmdListMessages() {
  const raw = await withRetry(() => {
    return redisRaw(['LRANGE', KEYS.restartMessages, '0', '-1']);
  });

  const messages = parseListOutput(raw);
  output({ ok: true, messages, count: messages.length });
}
