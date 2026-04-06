# OCR Backend Contract

Use OCR as a backend coordination layer, not as the main orchestrator.

## Ownership

- Coordinator-only commands:
  - `ocr task-status-create`
  - `ocr task-status-update`
  - `ocr task-status-close`
- Child-safe commands:
  - `ocr lifecycle start|update|stop|run|beat`
  - `ocr set-status`
  - `ocr emit`

## Required identifiers

- `task_id`: stable coordinator task identifier
- `parent_run_id`: coordinator run that owns child fan-out
- `run_id`: child run identifier for a worker
- `coordinator_id`: actor allowed to own the tracker

## Recommended write pattern

1. Coordinator creates `task_id`.
2. Coordinator creates tracker once.
3. Each child writes only its own `agent_status`.
4. Coordinator aggregates child statuses into one user-facing summary.
5. Watcher may refresh Telegram, but orchestration decisions come from the coordinator state.

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
