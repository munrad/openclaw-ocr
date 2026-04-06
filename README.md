# openclaw-ocr

OpenClaw-Redis CLI (OCR) -- multi-agent coordination system via Redis Streams.

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
