/**
 * lib/coordinator-bindings.mjs — Resolve coordinator ownership fields consistently.
 */
import { validateAgentId } from './known-agents.mjs';

function normalize(value) {
  return String(value || '').trim();
}

export function getDefaultCoordinatorId() {
  return normalize(process.env.OPENCLAW_COORDINATOR_ID || 'system') || 'system';
}

export function resolveCoordinatorBindings(input = {}, defaults = {}) {
  const coordinatorId = normalize(
    input.coordinator_id
    || input.coordinator
    || defaults.coordinator_id
    || defaults.coordinator
    || getDefaultCoordinatorId(),
  ) || 'system';
  const ownerId = normalize(
    input.owner_id
    || input.owner
    || defaults.owner_id
    || defaults.owner
    || coordinatorId,
  ) || coordinatorId;
  const closeOwnerId = normalize(
    input.close_owner_id
    || input.close_owner
    || defaults.close_owner_id
    || defaults.close_owner
    || ownerId
    || coordinatorId,
  ) || coordinatorId;
  const creatorId = normalize(
    input.creator_id
    || input.creator
    || defaults.creator_id
    || defaults.creator
    || coordinatorId,
  ) || coordinatorId;

  for (const agentId of [coordinatorId, ownerId, closeOwnerId, creatorId]) {
    if (agentId && agentId !== 'system') validateAgentId(agentId, 'coordinator-bindings');
  }

  return {
    coordinator_id: coordinatorId,
    owner_id: ownerId,
    close_owner_id: closeOwnerId,
    creator_id: creatorId,
  };
}

export function requireExplicitCoordinator(input = {}, defaults = {}) {
  const explicit = normalize(
    input.coordinator_id
    || input.coordinator
    || defaults.coordinator_id
    || defaults.coordinator
    || process.env.OPENCLAW_COORDINATOR_ID,
  );
  if (!explicit) return null;
  return resolveCoordinatorBindings(input, defaults);
}
