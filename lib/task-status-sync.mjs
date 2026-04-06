/**
 * lib/task-status-sync.mjs — shared task-status projection rules
 *
 * Keeps Telegram projection logic deterministic and reusable between the
 * task-status CLI commands and the background watcher.
 */
import { createHash } from 'node:crypto';

function parseTimestampMs(value) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) return null;
    return raw.length <= 10 ? numeric * 1000 : numeric;
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function taskStatusEditMinIntervalMs() {
  const raw = Number(process.env.OCR_TASK_STATUS_EDIT_MIN_INTERVAL_MS || 2000);
  return Number.isFinite(raw) ? Math.max(0, raw) : 2000;
}

export function taskStatusSignature(text = '') {
  return createHash('sha256').update(String(text)).digest('hex');
}

export function classifyTelegramFailure(resultOrDescription) {
  const description = typeof resultOrDescription === 'string'
    ? resultOrDescription
    : String(resultOrDescription?.description || '');
  const normalized = description.toLowerCase();

  if (
    normalized.includes('429')
    || normalized.includes('retry after')
    || normalized.includes('backoff')
  ) {
    return 'pending';
  }

  if (
    normalized.includes('timeout')
    || normalized.includes('deadline exceeded')
    || normalized.includes('socket hang up')
    || normalized.includes('econnreset')
    || normalized.includes('epipe')
    || normalized.includes('max retries exceeded')
    || normalized.includes('network')
  ) {
    return 'unconfirmed';
  }

  return 'suppressed';
}

export function planTaskStatusSync(taskData = {}, nextText = '', opts = {}) {
  const force = opts.force === true;
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const minIntervalMs = Number.isFinite(opts.minIntervalMs)
    ? Math.max(0, opts.minIntervalMs)
    : taskStatusEditMinIntervalMs();

  if (!taskData.message_id) {
    return { shouldSend: false, reason: 'task_not_found' };
  }

  if (taskData.delivery_state === 'suppressed' && !force) {
    return { shouldSend: false, reason: 'delivery_suppressed' };
  }

  const previousSignature = String(taskData.rendered_signature || '');
  const nextSignature = taskStatusSignature(nextText);
  if (!force && previousSignature && previousSignature === nextSignature) {
    return { shouldSend: false, reason: 'no_change' };
  }

  const lastEditMs = parseTimestampMs(taskData.last_telegram_edit_at);
  if (!force && Number.isFinite(lastEditMs)) {
    const elapsedMs = nowMs - lastEditMs;
    if (elapsedMs < minIntervalMs) {
      return {
        shouldSend: false,
        reason: 'rate_limited',
        retry_after_ms: Math.max(0, minIntervalMs - elapsedMs),
      };
    }
  }

  return {
    shouldSend: true,
    reason: force ? 'forced' : 'changed',
    nextSignature,
  };
}
