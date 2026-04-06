import assert from 'node:assert/strict';
import {
  parseEventTimestampMs,
  shouldBootstrapSpawnFromStream,
} from '../task-status-watcher.mjs';

function withNow(fakeNowMs, fn) {
  const originalNow = Date.now;
  Date.now = () => fakeNowMs;
  try {
    return fn();
  } finally {
    Date.now = originalNow;
  }
}

async function main() {
  const nowMs = 1_800_000_000_000;
  const oldEntryId = `${nowMs - 180_000}-0`;
  const freshEntryId = `${nowMs - 1_000}-0`;

  const parsedOldMs = parseEventTimestampMs(
    { id: oldEntryId, timestamp: String(Math.floor(nowMs / 1000)) },
    { timestamp: String(Math.floor(nowMs / 1000)) },
  );
  assert.equal(parsedOldMs, nowMs - 180_000, 'stream entry id must win over coarse seconds timestamp');

  const historicalAllowed = withNow(nowMs, () => shouldBootstrapSpawnFromStream(
    { timestamp: String(Math.floor(nowMs / 1000)) },
    { id: oldEntryId, timestamp: String(Math.floor(nowMs / 1000)) },
  ));
  assert.equal(historicalAllowed, false, 'historical stream replay must not bootstrap tracker');

  const freshAllowed = withNow(nowMs, () => shouldBootstrapSpawnFromStream(
    { timestamp: String(Math.floor((nowMs - 1_000) / 1000)) },
    { id: freshEntryId, timestamp: String(Math.floor((nowMs - 1_000) / 1000)) },
  ));
  assert.equal(freshAllowed, true, 'fresh stream spawn must still bootstrap tracker');

  const missingTimestampAllowed = withNow(nowMs, () => shouldBootstrapSpawnFromStream({}, {}));
  assert.equal(missingTimestampAllowed, false, 'missing timestamp metadata must fail closed');

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'stream bootstrap freshness uses Redis entry id before coarse timestamp field',
      'historical agent_spawned replay is rejected for bootstrap',
      'fresh agent_spawned stream event remains allowed',
      'missing timestamp metadata fails closed',
    ],
  }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
