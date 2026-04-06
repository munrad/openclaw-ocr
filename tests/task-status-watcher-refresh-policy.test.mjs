import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  resolveRefreshBackoffMs,
  shouldSchedulePeriodicTaskRefresh,
} from '../task-status-watcher.mjs';

test('resolveRefreshBackoffMs applies quiet windows only for noisy refresh outcomes', () => {
  assert.ok(resolveRefreshBackoffMs('no_change') > 0, 'no_change should open a quiet window');
  assert.equal(resolveRefreshBackoffMs('rate_limited', { retryAfterMs: 321 }), 321, 'rate_limited should reuse retry_after_ms');
  assert.ok(resolveRefreshBackoffMs('tg_error') > 0, 'telegram errors should back off periodic refresh');
  assert.ok(resolveRefreshBackoffMs('delivery_suppressed') > 0, 'suppressed delivery should back off periodic refresh');
  assert.equal(resolveRefreshBackoffMs('updated'), 0, 'successful updates must stay immediately refreshable');
});

test('shouldSchedulePeriodicTaskRefresh respects quietUntilMs boundaries', () => {
  const nowMs = 1_800_000_000_000;

  assert.equal(shouldSchedulePeriodicTaskRefresh({}, nowMs), true, 'missing quiet metadata should allow periodic refresh');
  assert.equal(shouldSchedulePeriodicTaskRefresh({ quietUntilMs: nowMs - 1 }, nowMs), true, 'expired quiet window should allow periodic refresh');
  assert.equal(shouldSchedulePeriodicTaskRefresh({ quietUntilMs: nowMs + 1_000 }, nowMs), false, 'active quiet window should suppress periodic refresh');
});
