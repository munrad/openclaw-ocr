import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifyTelegramFailure,
  planTaskStatusSync,
  taskStatusSignature,
} from '../lib/task-status-sync.mjs';

test('planTaskStatusSync skips unchanged text, rate limits changes, and allows force', () => {
  const nowMs = Date.parse('2026-04-06T10:00:00.000Z');
  const taskData = {
    message_id: '42',
    rendered_signature: taskStatusSignature('stable text'),
    last_telegram_edit_at: '2026-04-06T09:59:59.500Z',
    delivery_state: 'confirmed',
  };

  const unchanged = planTaskStatusSync(taskData, 'stable text', { nowMs, minIntervalMs: 2000 });
  assert.equal(unchanged.shouldSend, false);
  assert.equal(unchanged.reason, 'no_change');

  const changed = planTaskStatusSync(taskData, 'new text', { nowMs, minIntervalMs: 2000 });
  assert.equal(changed.shouldSend, false);
  assert.equal(changed.reason, 'rate_limited');
  assert.ok(changed.retry_after_ms > 0);

  const forced = planTaskStatusSync(taskData, 'new text', { nowMs, minIntervalMs: 2000, force: true });
  assert.equal(forced.shouldSend, true);
  assert.equal(forced.reason, 'forced');
});

test('classifyTelegramFailure distinguishes retryable, ambiguous, and suppressed delivery failures', () => {
  assert.equal(classifyTelegramFailure('wall-clock deadline exceeded (429 backoff)'), 'pending');
  assert.equal(classifyTelegramFailure('Telegram request timeout after 5000ms'), 'unconfirmed');
  assert.equal(classifyTelegramFailure('Bad Request: chat not found'), 'suppressed');
});
