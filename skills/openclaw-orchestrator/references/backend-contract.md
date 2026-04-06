# OCR Backend Contract

Use OCR as a backend coordination layer, not as the main orchestrator.

## Ownership

- Coordinator-only commands:
  - `ocr orchestrate-fanout`
  - `ocr task-status-create`
  - `ocr task-status-update`
  - `ocr task-status-close`
- Child-safe commands:
  - `ocr lifecycle start|update|stop|run|beat`
  - `ocr set-status`
  - `ocr emit`

## Required identifiers

- `task_id`: stable coordinator task identifier
- `openclaw:orchestration:<task_id>`: durable root orchestration record in Redis
- `parent_run_id`: coordinator run that owns child fan-out
- `run_id`: child run identifier for a worker
- `coordinator_id`: actor allowed to own the tracker

## Recommended write pattern

1. Coordinator creates `task_id` and local execution state.
2. Coordinator may materialize child tasks via `ocr orchestrate-fanout`.
3. Coordinator creates tracker once when chat projection is needed.
4. Each child writes only its own `agent_status`.
5. Coordinator aggregates child statuses into one user-facing summary.
6. Watcher may refresh Telegram, but orchestration decisions come from the coordinator state.

## Delivery semantics

- `delivery_state=confirmed`: Telegram projection succeeded.
- `delivery_state=pending`: retryable projection failure; bounded retry is allowed.
- `delivery_state=unconfirmed`: network/timeout ambiguity; do not blindly resend from child paths.
- `delivery_state=suppressed`: non-retryable projection failure; keep orchestration alive without Telegram.

## Recovery rules

- Pub/Sub is only a wake-up signal.
- Redis stream is the durable signal source.
- Reconcile stale child runs before accepting late writes.
- Never let a child update another child’s tracker membership or terminal status.
- Treat `OPENCLAW_COORDINATOR_ID` only as a default binding source, not as a substitute for canonical coordinator state.
