import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveLifecycleFinalAction } from '../lib/lifecycle.mjs';

test('resolveLifecycleFinalAction completes successful runs that are still active', () => {
  assert.equal(resolveLifecycleFinalAction({ stopped: false, error: null }), 'complete');
});

test('resolveLifecycleFinalAction fails active runs on error and noops stopped runs', () => {
  assert.equal(resolveLifecycleFinalAction({ stopped: false, error: new Error('boom') }), 'fail');
  assert.equal(resolveLifecycleFinalAction({ stopped: true, error: null }), 'noop');
  assert.equal(resolveLifecycleFinalAction({ stopped: true, error: new Error('boom') }), 'noop');
});
