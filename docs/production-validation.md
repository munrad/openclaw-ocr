# Production Validation

Этот runbook нужен для финальной эксплуатационной валидации `openclaw-ocr` как
backend/coordinator runtime.

Scope:

- staging Telegram smoke
- burst/load validation для root orchestrations
- recovery drill для упавшего coordinator

## Preconditions

1. OCR установлен и доступен:

```bash
ocr --help
node scripts/install-openclaw-orchestrator.mjs --json
```

2. Runtime env настроен:

```bash
export REDIS_HOST=redis
export REDIS_PORT=6379
export OPENCLAW_COORDINATOR_ID=teamlead
export OPENCLAW_TELEGRAM_BOT_TOKEN="$(cat /run/secrets/telegram_bot_token)"
export OPENCLAW_TELEGRAM_CHAT_ID="$(cat /run/secrets/telegram_chat_id)"
export OPENCLAW_TELEGRAM_TOPIC_ID="$(cat /run/secrets/telegram_topic_id 2>/dev/null || printf 1)"
```

3. OCR bootstrapped:

```bash
ocr init
```

## 1. Staging Telegram Smoke

Цель: доказать, что root orchestration, tracker projection и inspect surface
работают с реальным Telegram bot/chat/topic.

### Create one tracked root

```bash
ts="$(date +%s)"
task_id="stage-root-$ts"

ocr orchestrate-fanout \
  --task-id "$task_id" \
  --goal "Staging smoke: tracked root orchestration" \
  --title "Staging Smoke $ts" \
  --agents coder,tester \
  --coordinator-id "$OPENCLAW_COORDINATOR_ID" \
  --owner-id "$OPENCLAW_COORDINATOR_ID" \
  --close-owner-id "$OPENCLAW_COORDINATOR_ID" \
  --creator-id "$OPENCLAW_COORDINATOR_ID" \
  --create-tracker true \
  --chat-id "$OPENCLAW_TELEGRAM_CHAT_ID" \
  --topic-id "$OPENCLAW_TELEGRAM_TOPIC_ID"
```

### Inspect it from OCR

```bash
ocr get-orchestration --task-id "$task_id"
ocr list-orchestrations --status active --limit 20
```

Expected:

- one root record exists in `openclaw:orchestration:<task_id>`
- tracker exists in `openclaw:task-status:<task_id>`
- Telegram message created in the target chat/topic
- `tracker.delivery_state` is `confirmed`

### Manual child lifecycle check

Use a dedicated test group so the commands do not interfere with normal workers.

```bash
ocr claim-task coder staging-smoke
ocr claim-task tester staging-smoke
```

Copy the returned `task_id` values and then:

```bash
ocr set-status coder '{"state":"working","step":"staging smoke implementation","progress":50}'
ocr set-status tester '{"state":"working","step":"staging smoke verification","progress":50}'

ocr complete-task <coder-child-task-id> '{"agent":"coder","summary":"staging smoke implementation done"}'
ocr complete-task <tester-child-task-id> '{"agent":"tester","summary":"staging smoke verification done"}'

ocr close-orchestration \
  --task-id "$task_id" \
  --actor-id "$OPENCLAW_COORDINATOR_ID" \
  --result success \
  --summary "staging smoke complete"
```

Expected:

- `close-orchestration` succeeds without `--force`
- root disappears from `list-orchestrations --status active`
- Telegram tracker is edited to a closed state

## 2. Burst / Load Validation

Цель: проверить guardrails и поведение root orchestration под burst fan-out.

### Guardrail validation

```bash
export OPENCLAW_MAX_ACTIVE_ORCHESTRATIONS=3
node scripts/orchestrator-burst-smoke.mjs \
  --roots 5 \
  --agents coder,tester \
  --coordinator-id "$OPENCLAW_COORDINATOR_ID" \
  --goal-prefix "Active limit validation" \
  --title-prefix "Active limit validation"
```

Expected:

- первые `3` roots создаются
- оставшиеся roots получают `active_orchestration_limit_exceeded`
- `ocr list-orchestrations --status active` показывает не больше `3` active roots

### Fan-out size validation

```bash
export OPENCLAW_MAX_FANOUT_CHILDREN=2
ocr orchestrate-fanout \
  --goal "Fan-out size validation" \
  --agents coder,tester,reviewer \
  --coordinator-id "$OPENCLAW_COORDINATOR_ID"
```

Expected:

- OCR returns `fanout_limit_exceeded`
- root record is not created

### Burst creation with cleanup

```bash
unset OPENCLAW_MAX_ACTIVE_ORCHESTRATIONS
unset OPENCLAW_MAX_FANOUT_CHILDREN

node scripts/orchestrator-burst-smoke.mjs \
  --roots 10 \
  --agents coder,tester \
  --coordinator-id "$OPENCLAW_COORDINATOR_ID" \
  --goal-prefix "Burst smoke" \
  --title-prefix "Burst smoke" \
  --cleanup true
```

Expected:

- script prints created/rejected counters
- cleanup force-closes the created roots
- `ocr list-orchestrations --status active` returns to baseline

## 3. Recovery Drill

Цель: доказать, что оператор может безопасно закрыть зависший root orchestration.

### Create a root and inspect it

```bash
ts="$(date +%s)"
task_id="recovery-root-$ts"

ocr orchestrate-fanout \
  --task-id "$task_id" \
  --goal "Recovery drill root orchestration" \
  --title "Recovery Drill $ts" \
  --agents coder,tester \
  --coordinator-id "$OPENCLAW_COORDINATOR_ID"

ocr get-orchestration --task-id "$task_id"
```

### Verify safe-close guard

```bash
ocr close-orchestration \
  --task-id "$task_id" \
  --actor-id "$OPENCLAW_COORDINATOR_ID" \
  --result success
```

Expected:

- OCR rejects the close with `children_incomplete`

### Force-close as an operator override

```bash
ocr close-orchestration \
  --task-id "$task_id" \
  --actor-id "$OPENCLAW_COORDINATOR_ID" \
  --result fail \
  --summary "manual recovery override" \
  --force true
```

Expected:

- root closes successfully
- response contains `forced: true`
- root disappears from `list-orchestrations --status active`

## 4. Success Criteria

Считать модуль эксплуатационно готовым можно, если выполняются все пункты:

- staging Telegram smoke проходит с реальным bot/chat/topic
- `close-orchestration` succeeds without `--force` after terminal children
- safety guards reject unsafe close paths
- burst helper reproduces active-limit and fan-out-limit behavior
- active roots return to baseline after cleanup/recovery
- no unexpected watcher edit storm or Telegram rate-limit cascade is seen during burst validation
