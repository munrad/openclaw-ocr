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
