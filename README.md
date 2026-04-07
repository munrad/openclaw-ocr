# openclaw-ocr

OpenClaw-Redis CLI (OCR) -- multi-agent coordination backend via Redis Streams.

The repository now treats OCR as a backend transport/recovery layer. The main
orchestration flow is intended to live in a coordinator skill, with OCR keeping
agent snapshots, events, task trackers, and optional Telegram projection.

Archived from [munrad/agent](https://github.com/munrad/agent) (`services/openclaw/scripts/multiagent/ocr/`).

## Structure

```
index.mjs              CLI entry point
commands/              Command implementations (tasks, agents, pipelines, roundtable, etc.)
lib/                   Supporting libraries (Redis, config, retry, circuit-breaker, schemas)
tests/                 Test suite
status-watchdog.mjs    Agent status reconciliation daemon
task-status-watcher.mjs  Task-scoped status tracking daemon
lifecycle-daemon.mjs   Automated heartbeat keeper
skills/openclaw-orchestrator/  Coordinator skill + UI metadata for OCR-backed orchestration
scripts/               Event dispatcher, auto-router, event mappings
docs/                  CLI reference and test cases
```

## Dependencies

- Node.js 20+
- Redis 7+ (uses Streams, Pub/Sub, hashes)
- Zero npm dependencies (pure Node.js, calls redis-cli via child_process)

## Usage

```bash
npm install -g .
ocr --help
```

## Runtime Env

- `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_DB`
- `OPENCLAW_TELEGRAM_BOT_TOKEN`, `OPENCLAW_TELEGRAM_CHAT_ID`, `OPENCLAW_TELEGRAM_TOPIC_ID`
- `OPENCLAW_COORDINATOR_ID` for a default coordinator/ownership binding when a coordinator command does not pass `--coordinator-id`
- `OPENCLAW_MAX_FANOUT_CHILDREN` to cap one `orchestrate-fanout` root before OCR rejects it
- `OPENCLAW_MAX_ACTIVE_ORCHESTRATIONS` to cap concurrently active root orchestrations in `openclaw:orchestrations:active`

## Install The Coordinator Skill

Initial bootstrap from this repository:

```bash
node scripts/install-openclaw-orchestrator.mjs
```

What it does:

- syncs `skills/openclaw-orchestrator/` into `${CODEX_HOME:-~/.codex}/skills/openclaw-orchestrator`
- runs `npm install -g <repo-root>` to refresh the `ocr` CLI from this checkout
- verifies that `ocr --help` works after install

For later refreshes, the package also exposes:

```bash
openclaw-orchestrator-install
```

Useful flags:

- `--skill-only`
- `--ocr-only`
- `--target <path>`
- `--dry-run`
- `--json`

Restart Codex/OpenClaw after installation so the new skill is discovered.

For the coordinator-facing skill contract, see
[`skills/openclaw-orchestrator/SKILL.md`](skills/openclaw-orchestrator/SKILL.md).

For isolated Redis-backed integration runs, use:

```bash
node scripts/run-redis-tests-sequential.mjs
```

The runner assigns a separate `REDIS_DB` to each test file, runs them sequentially,
checks Redis hygiene on the same DB, and flushes that DB after each file.

For final staging/load/recovery validation, use:

- [production-validation.md](/mnt/repos/openclaw-ocr/docs/production-validation.md)
- `node scripts/orchestrator-burst-smoke.mjs --help`

## Coordinator Runtime

OCR now includes a coordinator-owned fan-out command for the skill/runtime layer:

```bash
ocr orchestrate-fanout \
  --goal "Fix the parser bug and verify the patch" \
  --agents coder,tester \
  --coordinator-id teamlead \
  --title "Parser bug hotfix"
```

This creates a root orchestration record, fans out child tasks with shared
`run_id` / `parent_run_id` metadata, and can optionally create one
coordinator-owned task-status tracker for the whole task.

Enable the tracker explicitly with `--create-tracker true`, or pass explicit
chat/topic runtime inputs through the command/spec.

Operator surfaces:

```bash
ocr get-orchestration --task-id <root-task-id>
ocr list-orchestrations --status active
ocr orchestration-health --status all
ocr status-hygiene
ocr close-orchestration --task-id <root-task-id> --actor-id teamlead --result fail --summary "manual recovery close"
```

`get-orchestration` returns the root record, tracker snapshot, child task
results, child agent statuses, and `child_status_issues` for `run_id`
mismatches. `orchestration-health` aggregates operator-facing metrics for active
roots, forced closes, degraded tracker delivery, bootstrap recovery, and child
status integration errors. `status-hygiene` reports or removes suspicious
legacy mirrored fields from agent status hashes. `close-orchestration`
finalizes the root record, removes it from the active index, and attempts a
degraded-safe tracker close without making Telegram availability part of the
orchestration shutdown contract. By default it refuses to close while child
tasks are still pending or unknown, and it also refuses a `success` close while
child failures are still present. Use `--force true` only for explicit manual
recovery.

## End-To-End Flow

1. Install or refresh the skill with `node scripts/install-openclaw-orchestrator.mjs`.
2. Keep the canonical plan and live state in the coordinator skill, not in Redis.
3. Materialize the fan-out with `ocr orchestrate-fanout` once the decomposition is concrete.
4. Let child agents write only `ocr lifecycle ...`, `ocr set-status ...`, and `ocr emit ...`.
   Child `set-status` updates must include the root `run_id`; otherwise OCR
   intentionally renders a queued fallback and counts it as an integration issue.
5. Let the coordinator aggregate child progress and own all `task-status-*` writes.
6. Close the tracker from the coordinator path when the user-visible task is done.

## Recovery Runbook

1. Inspect active roots with `ocr list-orchestrations --status active`.
2. Inspect one root with `ocr get-orchestration --task-id <id>`.
3. Check aggregate health with `ocr orchestration-health --status all`.
4. If agent status hashes look corrupt from old mirrored fields, dry-run `ocr status-hygiene` first, then rerun with `--apply true`.
5. If the coordinator died or the plan is terminal, close the root with `ocr close-orchestration --task-id <id> --actor-id <coordinator> --result success|fail`.
6. If OCR reports `children_incomplete` or `child_failures_present`, inspect first and use `--force true` only for an intentional manual override.
7. Use `--skip-tracker-close true` only when you explicitly do not want OCR to touch the shared tracker during manual recovery.

## Current Limits

- `ocr orchestrate-fanout` is a materializer for a ready plan, not a full adaptive planner.
- Root orchestration limits are intentionally conservative by default: `OPENCLAW_MAX_FANOUT_CHILDREN=8`, `OPENCLAW_MAX_ACTIVE_ORCHESTRATIONS=10`.
- OCR is production-usable as a coordination backend and coordinator helper, but automatic decomposition/fan-out policy still lives above it in the skill/runtime layer.
- Telegram degraded modes (`pending`, `unconfirmed`, `suppressed`) are supported, but real bot/topic verification should still be done in the target staging or production environment.
