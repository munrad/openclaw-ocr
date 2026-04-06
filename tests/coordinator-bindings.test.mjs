import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  getDefaultCoordinatorId,
  resolveCoordinatorBindings,
  requireExplicitCoordinator,
} from '../lib/coordinator-bindings.mjs';

test('resolveCoordinatorBindings prefers explicit values and fills ownership defaults', () => {
  const bindings = resolveCoordinatorBindings({
    coordinator_id: 'teamlead',
    owner_id: 'planner',
  });

  assert.deepEqual(bindings, {
    coordinator_id: 'teamlead',
    owner_id: 'planner',
    close_owner_id: 'planner',
    creator_id: 'teamlead',
  });
});

test('resolveCoordinatorBindings falls back to system without explicit values', () => {
  const original = process.env.OPENCLAW_COORDINATOR_ID;
  delete process.env.OPENCLAW_COORDINATOR_ID;
  try {
    assert.equal(getDefaultCoordinatorId(), 'system');
    assert.deepEqual(resolveCoordinatorBindings({}), {
      coordinator_id: 'system',
      owner_id: 'system',
      close_owner_id: 'system',
      creator_id: 'system',
    });
  } finally {
    if (original === undefined) delete process.env.OPENCLAW_COORDINATOR_ID;
    else process.env.OPENCLAW_COORDINATOR_ID = original;
  }
});

test('requireExplicitCoordinator accepts env-based coordinator but rejects fully implicit system fallback', () => {
  const original = process.env.OPENCLAW_COORDINATOR_ID;
  delete process.env.OPENCLAW_COORDINATOR_ID;
  try {
    assert.equal(requireExplicitCoordinator({}), null);
    process.env.OPENCLAW_COORDINATOR_ID = 'teamlead';
    assert.deepEqual(requireExplicitCoordinator({}), {
      coordinator_id: 'teamlead',
      owner_id: 'teamlead',
      close_owner_id: 'teamlead',
      creator_id: 'teamlead',
    });
  } finally {
    if (original === undefined) delete process.env.OPENCLAW_COORDINATOR_ID;
    else process.env.OPENCLAW_COORDINATOR_ID = original;
  }
});
