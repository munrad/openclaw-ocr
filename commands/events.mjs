/**
 * commands/events.mjs — Event stream commands
 */
import { withRetry } from '../lib/retry.mjs';
import { redis, redisRaw, parseJson, parseXread } from '../lib/redis.mjs';
import { KEYS, now } from '../lib/schema.mjs';
import { output, argError } from '../lib/errors.mjs';

export async function cmdEmit(eventType, jsonArg) {
  if (!eventType) throw argError('emit requires <event-type>');
  if (!jsonArg)   throw argError('emit requires <json>');
  const data = parseJson(jsonArg);
  if (!data) throw argError('emit: invalid JSON');

  const eventId = await withRetry(() => {
    const id = redis('XADD', KEYS.eventsStream, 'MAXLEN', '~', '10000', '*',
      'type', eventType,
      'timestamp', now(),
      'agent', data.agent || 'unknown',
      'data', JSON.stringify(data),
    );
    return id;
  });

  output({ ok: true, event_type: eventType, event_id: eventId });
}

export async function cmdWatch(lastId) {
  // No argument or '$' with no explicit intent → read last N events (non-blocking)
  // Explicit '$' via flag → only new events (blocking)
  // Specific ID → read from that ID (blocking)
  // '0' → read from beginning (blocking)

  if (!lastId || lastId === '$') {
    // Default: show last 10 events via XREVRANGE (non-blocking), then output in chronological order
    const raw = await withRetry(() => {
      return redisRaw(['XREVRANGE', KEYS.eventsStream, '+', '-', 'COUNT', '10']);
    });

    if (!raw || raw.trim() === '' || raw.trim() === '(nil)' || raw.trim() === 'nil') {
      output({ ok: true, events: [] });
      return;
    }

    const entries = parseXread(raw);
    // XREVRANGE returns newest-first, reverse to chronological order
    entries.reverse();
    output({ ok: true, events: entries });
    return;
  }

  // Explicit ID provided: blocking read from that point
  const fromId = lastId === 'new' ? '$' : lastId;

  const raw = await withRetry(() => {
    return redisRaw([
      'XREAD',
      'COUNT', '10',
      'BLOCK', '10000',
      'STREAMS', KEYS.eventsStream,
      fromId,
    ]);
  });

  if (!raw || raw.trim() === '' || raw.trim() === '(nil)' || raw.trim() === 'nil') {
    output({ ok: true, events: [] });
    return;
  }

  const entries = parseXread(raw);
  output({ ok: true, events: entries });
}
