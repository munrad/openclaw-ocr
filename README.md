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

## End-To-End Flow

1. Install or refresh the skill with `node scripts/install-openclaw-orchestrator.mjs`.
2. Keep the canonical plan and live state in the coordinator skill, not in Redis.
3. Materialize the fan-out with `ocr orchestrate-fanout` once the decomposition is concrete.
4. Let child agents write only `ocr lifecycle ...`, `ocr set-status ...`, and `ocr emit ...`.
5. Let the coordinator aggregate child progress and own all `task-status-*` writes.
6. Close the tracker from the coordinator path when the user-visible task is done.

## Current Limits

- `ocr orchestrate-fanout` is a materializer for a ready plan, not a full adaptive planner.
- OCR is production-usable as a coordination backend and coordinator helper, but automatic decomposition/fan-out policy still lives above it in the skill/runtime layer.
- Telegram degraded modes (`pending`, `unconfirmed`, `suppressed`) are supported, but real bot/topic verification should still be done in the target staging or production environment.
