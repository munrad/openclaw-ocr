import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconcileAgentStatus } from '../lib/status-reconcile.mjs';

const staleStatus = (state) => ({
  state,
  updated_at: '1-0',
});

test('reconcile degrades queued/spawned/blocked without heartbeat to stale', () => {
  for (const state of ['queued', 'spawned', 'blocked']) {
    const decision = reconcileAgentStatus(`agent-${state}`, staleStatus(state), {
      nowMs: 10_000,
      heartbeatAlive: false,
      thresholds: { activeStaleGraceMs: 0 },
    });

    assert.equal(decision.changed, true, `${state} should be reconciled`);
    assert.equal(decision.previousState, state);
    assert.equal(decision.nextState, 'stale');
    assert.equal(decision.reason, 'missing_heartbeat_active_to_stale');
    assert.equal(decision.patch.state, 'stale');
  }
});
