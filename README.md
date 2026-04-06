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
tests/                 Test suite (19 files)
status-watchdog.mjs    Agent status reconciliation daemon
task-status-watcher.mjs  Task-scoped status tracking daemon
lifecycle-daemon.mjs   Automated heartbeat keeper
skills/openclaw-orchestrator/  Coordinator skill that uses OCR as backend
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

For the coordinator-facing skill contract, see
[`skills/openclaw-orchestrator/SKILL.md`](skills/openclaw-orchestrator/SKILL.md).
