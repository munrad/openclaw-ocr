---
name: openclaw-orchestrator
description: Coordinate large tasks through the OpenClaw OCR backend. Use when the main agent must decompose work into parallel child agents, keep the canonical live status locally, and project only aggregated status into OCR/Telegram without letting children mutate task trackers directly.
---

# OpenClaw Orchestrator

Use this skill when the main agent is the coordinator and OCR is the backend transport.

## Core rules

- Keep the canonical task state in the coordinator context, not in Redis.
- Create exactly one task tracker per user-visible task.
- Only the coordinator calls `ocr task-status-create`, `ocr task-status-update`, and `ocr task-status-close`.
- Child agents may call `ocr lifecycle ...`, `ocr set-status`, and `ocr emit`, but they must not create or close trackers.
- Treat Telegram as a projection sink. If delivery is `unconfirmed` or `suppressed`, keep the orchestration running and continue to aggregate status locally.

## Workflow

1. Build a coordinator-owned execution state:
   `task_id`, `goal`, `plan`, `child_runs[]`, `phase`, `summary`, `progress`, `errors[]`.
2. Decide whether the task should fan out. Prefer parallel child agents only for independent subtasks.
3. If chat projection is needed, create a tracker once with `ocr task-status-create`.
   When you already have a concrete decomposition, prefer `ocr orchestrate-fanout`
   to materialize the child tasks and shared run metadata in one step.
4. Use `ocr start-pipeline` or `ocr roundtable-create` only when the workflow is already pipeline/roundtable-shaped; otherwise keep the plan local and use `ocr orchestrate-fanout`.
5. Spawn child agents. Give each child:
   `child_run_id`, `parent_run_id`, `acceptance_criteria`, and one narrow responsibility.
6. Require children to emit only lifecycle/status events:
   `ocr lifecycle ...`, `ocr set-status ...`, `ocr emit ...`.
7. Aggregate child progress in the coordinator. Update OCR/Telegram only from the aggregated snapshot.
8. Close the tracker from the coordinator when the task reaches a terminal result.
9. When a root orchestration gets stuck, inspect it with `ocr get-orchestration` and close it with `ocr close-orchestration` from the coordinator path.

## Recommended usage pattern

- Keep decomposition, acceptance criteria, and stopping conditions in the coordinator context.
- Use `ocr orchestrate-fanout` when you want OCR to create the root orchestration record and child tasks in one step.
- Use `ocr list-orchestrations --status active` and `ocr get-orchestration --task-id <id>` as the operator view for root orchestration recovery.
- Use `ocr task-status-create/update/close` only from the coordinator path.
- Treat `ocr start-pipeline` and `ocr roundtable-create` as specialized helpers, not as the default orchestration surface for every task.

## Status contract

- Coordinator snapshot is the source of truth.
- OCR `agent_status` is a transport snapshot for each child.
- OCR `task-status` is a user-facing projection of the coordinator snapshot.
- Watcher updates should be idempotent. Do not rely on watcher side effects for orchestration decisions.

## Failure handling

- On stale child status, reconcile before reusing the child.
- On Telegram rate limiting, coalesce updates and continue local orchestration.
- On ambiguous Telegram delivery, mark the projection as degraded and continue; do not blindly resend from children.
- On backend OCR failure, keep the coordinator state in memory and retry the backend write from the coordinator path only.
- Respect OCR safety limits: if `orchestrate-fanout` rejects the plan on `OPENCLAW_MAX_FANOUT_CHILDREN` or `OPENCLAW_MAX_ACTIVE_ORCHESTRATIONS`, reduce fan-out or wait for active roots to close.
- Treat `ocr close-orchestration --force true` as a manual recovery override, not as a normal completion path.

## Anti-patterns

- Letting a child agent create, mutate, or close the shared tracker.
- Treating watcher auto-join or watcher refresh side effects as planner state.
- Using `ocr orchestrate-fanout` as if it were an intelligent decomposition engine.
- Using Redis as the canonical source of truth for the whole coordinator plan.

## When to read more

- Read [references/backend-contract.md](references/backend-contract.md) when you need the exact OCR command split, field ownership, and delivery semantics.
- Use `ocr orchestrate-fanout --spec <json>` when you want a concrete backend-side fan-out helper for the current plan instead of pushing child tasks manually one by one.
