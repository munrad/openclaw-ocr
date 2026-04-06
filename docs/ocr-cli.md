# ocr — CLI-справочник

> `ocr` (openclaw-redis) — CLI/backend для координации мультиагентной системы через Redis Streams.

`ocr` теперь предполагается как backend-слой для coordinator skill: skill хранит
канонический live-status у себя, а OCR держит durable events, agent snapshots,
task trackers и Telegram projection.

```
ocr <command> [args...]
```

**Exit codes:** `0` — ok, `1` — business error, `2` — infra error (Redis недоступен), `3` — arg error (неверные аргументы).

**Env:** `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_DB` или файл `/run/secrets/redis_password`.

**Install model:** OCR source baked into `openclaw` image из `services/openclaw/scripts/multiagent/ocr/`, но `npm install -g` вызывается только в `entrypoint`. Reinstall происходит только если hash image-baked source изменился.

**Coordinator skill install:** для standalone checkout этого репозитория используйте:

```bash
node scripts/install-openclaw-orchestrator.mjs
```

Installer:

- синхронизирует `skills/openclaw-orchestrator/` в `${CODEX_HOME:-~/.codex}/skills/openclaw-orchestrator`
- обновляет `ocr` через `npm install -g <repo-root>`
- проверяет `ocr --help`

После первой установки доступна и bin-команда:

```bash
openclaw-orchestrator-install
```

---

## Оглавление

1. [Task Lifecycle](#task-lifecycle)
2. [Agent State](#agent-state)
3. [Locks](#locks)
4. [Branch Locks](#branch-locks)
5. [Events](#events)
6. [Task Routing](#task-routing)
7. [Pipelines](#pipelines)
8. [Feedback Loops](#feedback-loops)
9. [Roundtable](#roundtable)
10. [Insight Staging](#insight-staging)
11. [Messaging](#messaging)
12. [Recovery](#recovery)
13. [Queries](#queries)
14. [Bug Tracker](#bug-tracker)
15. [Task-Status v3](#task-status-v3)
16. [Cost Tracking](#cost-tracking)
17. [Garbage Collection](#garbage-collection)
18. [Daemons](#daemons)
19. [Reconcile Statuses](#reconcile-statuses)
20. [Redis Key Schema](#redis-key-schema)
21. [Architecture Notes](#architecture-notes)
22. [Тестирование](#тестирование)

---

## Task Lifecycle

### `init`

Создаёт consumer groups в Redis (идемпотентно).

```bash
ocr init
# {"ok":true,"message":"Consumer groups initialized","groups":["workers","watchers"]}
```

### `push-task <json>`

Создаёт задачу в потоке задач.

```bash
ocr push-task '{"type":"code","text":"Добавить валидацию","agent":"coder"}'
# {"ok":true,"task_id":"task_1711191234567_abc1","message":"Task queued"}
```

Поля JSON: `type` (по умолчанию `"general"`), `text`, `agent`, любые дополнительные.

### `claim-task <agent-id> [group]`

Атомарно забирает следующую задачу из очереди (XREADGROUP).

```bash
ocr claim-task coder
# {"ok":true,"task":{"id":"...","type":"code","text":"..."},"message":"Task claimed"}

# Нет задач:
ocr claim-task coder
# {"ok":true,"task":null,"message":"No pending tasks"}
```

### `complete-task <task-id> <json>`

Помечает задачу выполненной с результатом.

```bash
ocr complete-task task_1711191234567_abc1 '{"result":"done","files_changed":3}'
# {"ok":true,"message":"Task completed"}
```

### `fail-task <task-id> <reason>`

Помечает задачу проваленной.

```bash
ocr fail-task task_1711191234567_abc1 "Redis connection lost"
# {"ok":true,"message":"Task failed"}
```

### `list-pending [group]`

Список незавершённых задач в очереди.

```bash
ocr list-pending
# {"ok":true,"pending":[{"id":"...","consumer":"coder","idle_ms":12345}],"count":1}
```

---

## Agent State

### `set-status <agent-id> <json>`

Обновляет статус агента. Автоматически эмитит событие `agent_status_changed`.

```bash
ocr set-status coder '{"state":"working","step":"implementing auth","progress":40,"run_id":"task-123","branch":"feature/auth"}'
# {"ok":true}
```

**Допустимые `state`:** `idle`, `starting`, `working`, `blocked`, `waiting`, `reviewing`, `testing`, `completed`, `failed`, `stale`.

Если передан неизвестный `state`, команда вернёт `ok:true` с warning в stderr.

Если `agent-id` неизвестен — подсказка "Did you mean" (fuzzy match).

### `get-status <agent-id>`

Текущий статус агента.

```bash
ocr get-status coder
# {"ok":true,"agent":"coder","status":{"state":"working","step":"implementing auth","progress":"40","branch":"feature/auth","updated_at":"1711191234"}}
```

### `heartbeat <agent-id>`

Обновляет heartbeat (TTL 60 секунд). Используется для определения stale-агентов.

```bash
ocr heartbeat coder
# {"ok":true,"agent":"coder","ttl":60}
```

Если `agent-id` неизвестен — подсказка "Did you mean".

---

## Locks

### `lock <resource> <agent-id> [ttl]`

Захватывает блокировку ресурса (TTL по умолчанию 300 секунд).

```bash
ocr lock database-migration coder 600
# {"ok":true,"resource":"database-migration","owner":"coder","ttl":600}

# Если занято:
ocr lock database-migration tester
# {"ok":false,"error":"lock_held","owner":"coder"}  # exit code 1
```

### `unlock <resource> <agent-id>`

Освобождает блокировку (проверяет владельца).

```bash
ocr unlock database-migration coder
# {"ok":true,"released":"database-migration"}

# Если не владелец:
ocr unlock database-migration tester
# {"ok":false,"error":"not_owner"}  # exit code 1
```

---

## Branch Locks

### `lock-branch <branch> <agent-id> [ttl]`

Блокирует git-ветку (TTL по умолчанию 1800 секунд). Эмитит событие `branch_locked`. При конфликте — `branch_lock_conflict`.

```bash
ocr lock-branch feature/auth coder
# {"ok":true,"branch":"feature/auth","owner":"coder","ttl":1800}

# Конфликт:
ocr lock-branch feature/auth tester
# {"ok":false,"error":"branch_locked","owner":"coder","branch":"feature/auth"}  # exit code 1
```

### `unlock-branch <branch> <agent-id>`

Освобождает ветку. Эмитит `branch_unlocked`.

```bash
ocr unlock-branch feature/auth coder
# {"ok":true,"branch":"feature/auth","released":true}
```

### `renew-branch-lock <branch> <agent-id> [ttl]`

Продлевает TTL блокировки ветки. Вызывать каждые 15–20 минут при долгой работе.

```bash
ocr renew-branch-lock feature/auth coder 1800
# {"ok":true,"branch":"feature/auth","ttl":1800}
```

### `list-locks [--kind branch]`

Список активных блокировок.

```bash
ocr list-locks
# {"ok":true,"locks":[{"resource":"database-migration","owner":"coder","ttl":245}],"count":1}

ocr list-locks --kind branch
# {"ok":true,"locks":[{"branch":"feature/auth","owner":"coder","ttl":1650}],"count":1}
```

---

## Events

### `emit <event-type> <json>`

Записывает событие в поток `openclaw:events`.

```bash
ocr emit 'git:commit' '{"repo":"agent","branch":"main","message":"fix auth"}'
# {"ok":true,"id":"1711191234567-0"}
```

Типы событий, используемые системой:
- `agent_status_changed` — автоматически при `set-status`
- `branch_locked`, `branch_unlocked`, `branch_lock_conflict` — при операциях с ветками
- `pipeline_started`, `pipeline_completed`, `pipeline_escalated`, `pipeline_step_completed`
- `feedback_loop_started`, `feedback_loop_completed`, `feedback_loop_escalated`, `feedback_loop_iteration`
- `roundtable:synthesized`
- `git:commit`, `monitor:alert`, `monitor:trend` — пользовательские

### `watch [last-id]`

Читает события из потока (блокирующее чтение, timeout 10 секунд).

```bash
ocr watch
# {"ok":true,"events":[{"id":"1711191234567-0","type":"git:commit","data":{...}}]}

# С определённого ID:
ocr watch "1711191234567-0"
# {"ok":true,"events":[...]}  # только новые после указанного ID
```

---

## Task Routing

### `route-task <json>`

Детерминистический роутинг задачи к агенту и pipeline по ключевым словам и метаданным.

**Input JSON:**
```json
{
  "text": "Добавить авторизацию через OAuth",
  "source": "telegram",
  "metadata": { "type": "feature" }
}
```

**Поля:**
- `text` (обязательно) — текст задачи
- `source` — `telegram`, `cron`, `event`, `manual`
- `metadata.type` — подсказка типа: `feature`, `incident`, `security`, `research`, `docs`, `digest`, `health`, `lookup`, `code_review`

**Уровни confidence:**
- `≥ 0.80` — `decision: "auto"` (делегировать без вопросов)
- `0.55–0.79` — `decision: "confirm"` (запросить подтверждение)
- `< 0.55` — `decision: "ask"` (спросить пользователя)
- Если задача сложная / multi-domain — `decision: "roundtable"`

```bash
ocr route-task '{"text":"упал nginx, 502 ошибки","source":"telegram"}'
# {"ok":true,"route":{"primary_agent":"monitor","pipeline":"incident_response","type":"incident","confidence":0.7,"complexity":"low","model":"Haiku","selection_reason":"primary_available","reasons":["keyword: упал","keyword: ошибка","keyword: 502"],"needs_roundtable":false},"text":"🟢 → monitor [Haiku] (incident, 70%, low) via incident_response"}
```

**Типы маршрутов:**

| type | primary_agent | pipeline | keywords |
|------|---------------|----------|----------|
| feature | planner | feature_delivery | фича, feature, добавить, реализовать |
| incident | monitor | incident_response | упал, error, 502, crash, timeout |
| security | devops | security_fix | security, уязвимость, exploit |
| research | ai-researcher | research_to_build | исследовать, модель, AI, ML |
| docs | writer | documentation | документация, README, описать |
| digest | flash | digest | дайджест, сводка, summary |
| health | health | health_check | еда, калории, КБЖУ, питание |
| lookup | flash | — | найди, поищи, quick |
| code_review | reviewer | code_review | review, ревью, проверь код |

---

## Pipelines

### `start-pipeline --task-id <id> --template <name> [--context <json>]`

Запускает pipeline (последовательность шагов агентов). Эмитит `pipeline_started`.

```bash
ocr start-pipeline --task-id task-123 --template feature_delivery --context '{"branch":"feature/auth"}'
# {"ok":true,"pipeline_id":"pipe_...","template":"feature_delivery","steps":["planner","coder","tester","reviewer"],"current_step":0,"current_agent":"planner"}
```

**8 шаблонов:**

| template | steps | loop |
|----------|-------|------|
| `feature_delivery` | planner → coder → tester → reviewer | — |
| `incident_response` | monitor → devops → tester | — |
| `security_fix` | devops → coder → tester → reviewer | — |
| `research_to_build` | ai-researcher → coder → tester | — |
| `documentation` | writer → fact-checker → reviewer | — |
| `digest` | flash → writer | — |
| `health_check` | health → fact-checker | — |
| `code_review` | coder → reviewer | coder ↔ reviewer (макс 2) |

### `advance-pipeline --pipeline-id <id> --result <json>`

Продвигает pipeline на следующий шаг. Эмитит `pipeline_step_completed`. На последнем шаге — `pipeline_completed`.

```bash
ocr advance-pipeline --pipeline-id pipe_abc --result '{"status":"ok","output":"plan ready"}'
# {"ok":true,"pipeline_id":"pipe_abc","step_completed":0,"next_step":1,"next_agent":"coder"}

# Последний шаг:
# {"ok":true,"pipeline_id":"pipe_abc","status":"completed","total_steps":4}
```

### `get-pipeline --pipeline-id <id>`

Детальная информация о pipeline.

```bash
ocr get-pipeline --pipeline-id pipe_abc
# {"ok":true,"pipeline":{"id":"pipe_abc","template":"feature_delivery","status":"active","current_step":1,"current_agent":"coder","steps":[...],"context":{...},"created_at":"..."}}
```

### `list-pipelines [--status active|completed|escalated] [--limit N]`

Список pipeline'ов с фильтрацией.

```bash
ocr list-pipelines --status active --limit 5
# {"ok":true,"pipelines":[...],"count":2}
```

---

## Feedback Loops

Автономные итерационные циклы между парами агентов. Максимум 2 автоматических итерации, затем эскалация.

### `start-loop --type <type> --task-id <id> --initiator <agent> --target <agent> [--context <json>]`

**3 типа:**
- `code-test` — coder ↔ tester
- `code-review` — coder ↔ reviewer
- `test-devops` — tester ↔ devops

```bash
ocr start-loop --type code-test --task-id task-123 --initiator coder --target tester --context '{"branch":"feature/auth"}'
# {"ok":true,"loop_id":"loop_...","type":"code-test","initiator":"coder","target":"tester","iteration":1}
```

Ограничения: `initiator` и `target` должны быть разными агентами (иначе exit code 3).

### `loop-result --loop-id <id> --agent <agent> --verdict <pass|fail|fix> [--details <json>]`

Результат итерации. Эмитит событие.

**3 verdict:**
- `pass` — тесты/ревью пройдены → цикл завершён
- `fail` — найдены баги/проблемы → следующая итерация
- `fix` — исправление применено → возврат к проверке

```bash
ocr loop-result --loop-id loop_abc --agent tester --verdict fail --details '{"bugs":["NPE in auth.js"]}'
# {"ok":true,"loop_id":"loop_abc","iteration":2,"next_agent":"coder","status":"active"}

ocr loop-result --loop-id loop_abc --agent tester --verdict pass
# {"ok":true,"loop_id":"loop_abc","status":"completed","iterations":2}
```

При превышении максимума итераций — автоматическая эскалация (`pipeline_escalated`).

### `loop-status --loop-id <id>` / `loop-status --active`

```bash
ocr loop-status --loop-id loop_abc
# {"ok":true,"loop":{"id":"loop_abc","type":"code-test","status":"active","iteration":2,...}}

ocr loop-status --active
# {"ok":true,"active_loops":[...],"count":1}
```

### `loop-list [--status active|completed|escalated] [--limit N]`

```bash
ocr loop-list --status completed --limit 10
# {"ok":true,"loops":[...],"count":3}
```

---

## Roundtable

Мультиагентное совещание через Redis blackboard. Каждый агент читает предыдущих и добавляет своё.

### `roundtable-create --topic <text> {--participants <csv> | --template <name>} [--context <text>] [--constraints <text>]`

Создаёт roundtable. Участники — через CSV-список или шаблон.

**4 шаблона:**
- `architecture` — planner, ai-researcher, coder, tester
- `incident` — monitor, devops, coder, tester
- `feature` — planner, coder, tester, reviewer
- `documentation` — writer, ai-researcher, fact-checker, reviewer

```bash
ocr roundtable-create --topic "Выбор между PostgreSQL и SQLite" --template architecture --constraints "Должно работать на VPS с 2GB RAM"
# {"ok":true,"rt_id":"rt_...","topic":"Выбор между PostgreSQL и SQLite","participants":["planner","ai-researcher","coder","tester"],"round":1}

ocr roundtable-create --topic "API design review" --participants "coder,reviewer,tester"
# {"ok":true,"rt_id":"rt_...","topic":"API design review","participants":["coder","reviewer","tester"],"round":1}
```

Дедупликация участников: `"coder,coder,tester"` → `["coder","tester"]`.

### `roundtable-contribute <rt_id> --agent <id> --round <N> --summary <text> [--findings <text>] [--recommendations <text>] [--agrees_with <text>] [--disagrees_with <text>] [--questions <text>]`

Добавляет вклад агента в раунд.

```bash
ocr roundtable-contribute rt_abc --agent ai-researcher --round 1 \
  --summary "SQLite подходит для нашего масштаба" \
  --findings "До 100k запросов/день SQLite справляется" \
  --recommendations "Начать с SQLite, мигрировать при необходимости" \
  --agrees_with "planner: минимум зависимостей"
# {"ok":true,"rt_id":"rt_abc","agent":"ai-researcher","round":1}
```

Валидация: `--round` должен быть положительным целым числом (иначе exit code 3). Если `--agent` не в списке участников — warning в stderr, но contribute проходит.

### `roundtable-read <rt_id> [--round <N>]`

Читает все вклады (или конкретный раунд).

```bash
ocr roundtable-read rt_abc
# {"ok":true,"rt_id":"rt_abc","topic":"...","contributions":[{"agent":"planner","round":1,"summary":"..."},...],"status":"active"}

ocr roundtable-read rt_abc --round 1
# (только вклады из раунда 1)
```

### `roundtable-synthesize <rt_id> --synthesis <text>`

Завершает roundtable с финальным синтезом. Эмитит `roundtable:synthesized`. Автоматически сохраняет историю в `workspace/roundtable/history/YYYY-MM-DD.md`.

```bash
ocr roundtable-synthesize rt_abc --synthesis "Решение: начинаем с SQLite. Критерии миграции: >50k записей или >10 конкурентных писателей."
# {"ok":true,"rt_id":"rt_abc","status":"completed"}
```

Повторный вызов для уже завершённого roundtable возвращает `"already completed"` (exit code 3).

### `roundtable-tally <rt_id> [--round <N>]`

Подсчёт голосов agree/disagree и определение консенсуса.

```bash
ocr roundtable-tally rt_abc
# {"ok":true,"rt_id":"rt_abc","tally":{...},"has_consensus":true}
```

Логика консенсуса: `has_consensus = true` если нет агентов, у которых disagree > agree.

### `roundtable-list [--status active|completed] [--limit N]`

```bash
ocr roundtable-list --status active
# {"ok":true,"roundtables":[...],"count":1}
```

---

## Insight Staging

Промежуточный буфер для идей/инсайтов перед записью в mem0.

### `queue-insight <json>`

```bash
ocr queue-insight '{"text":"FastAPI лучше для нашего use-case","source":"ai-researcher","confidence":0.85,"tags":["architecture","python"]}'
# {"ok":true,"insight_id":"...","message":"Insight queued"}
```

Обязательные поля: `text`, `source`. Опциональные: `confidence`, `tags`.

### `list-insights [--limit N] [--source S] [--confidence C] [--promoted]`

```bash
ocr list-insights --limit 5
# {"ok":true,"insights":[{"id":"...","text":"...","source":"ai-researcher","confidence":0.85}],"count":3}

ocr list-insights --promoted
# (только промотированные — готовые для mem0)
```

### `promote-insight <insight-id>`

Перемещает инсайт в promoted set (готов для записи в mem0).

```bash
ocr promote-insight insight_abc
# {"ok":true,"promoted":"insight_abc"}
```

### `dismiss-insight <insight-id>`

Удаляет инсайт (шум).

```bash
ocr dismiss-insight insight_abc
# {"ok":true,"dismissed":"insight_abc"}
```

---

## Messaging

Mailbox для сообщений, которые нужно доставить после рестарта.

### `queue-message <json>`

```bash
ocr queue-message '{"text":"Deploy завершён, проверь staging","priority":"high"}'
# {"ok":true,"message":"Message queued"}
```

Обязательное поле: `text`. Остальные произвольные.

### `drain-messages`

Читает и удаляет все сообщения (атомарно). Используется при старте.

```bash
ocr drain-messages
# {"ok":true,"messages":[{"text":"Deploy завершён...","priority":"high"}],"count":1}
```

### `list-messages`

Читает сообщения без удаления.

```bash
ocr list-messages
# {"ok":true,"messages":[...],"count":1}
```

---

## Recovery

### `recover-tasks [--idle-ms 300000] [--agent cleanup]`

Восстанавливает orphaned-задачи (XCLAIM). Задачи, idle дольше порога, перехватываются указанным агентом.

```bash
ocr recover-tasks --idle-ms 300000 --agent cleanup
# {"ok":true,"recovered":3,"tasks":[...]}

# Без orphaned:
ocr recover-tasks
# {"ok":true,"recovered":0,"tasks":[]}
```

### `watchdog [--idle-ms 300000] [--dry-run]`

Автоматическая очистка orphaned-задач. Предназначен для cron (каждые 30–60 секунд).

```bash
ocr watchdog --dry-run
# {"ok":true,"orphaned":2,"recovered":0,"dry_run":true,"tasks":[...]}

ocr watchdog
# {"ok":true,"orphaned":2,"recovered":2,"tasks":[...]}
```

---

## Queries

### `status-query [filter]`

Сводка статусов агентов. Фильтры: `active`, `blocked`, `<agent-id>`, `branch <name>`.

```bash
ocr status-query
# (все агенты — таблица статусов)

ocr status-query active
# (только активные)

ocr status-query blocked
# (только заблокированные)

ocr status-query coder
# (статус конкретного агента)

ocr status-query branch feature/auth
# (кто работает с веткой)
```

### `locks-query [--kind branch]`

Аналог `list-locks`, оптимизирован для Telegram-команды `/locks`.

```bash
ocr locks-query
# {"ok":true,"locks":[...],"count":1}

ocr locks-query --kind branch
# (только branch-локи)
```

### `dashboard`

Единая сводка системы: агенты, задачи, инсайты, сообщения.

```bash
ocr dashboard
# {"ok":true,"agents":{...},"pending_tasks":2,"active_pipelines":1,"active_loops":0,"queued_insights":5,"pending_messages":0}
```

---

## Известные агенты

```
// Core (13 агентов из openclaw.json5):
nerey, coder, devops, tester, ai-researcher, flash, health,
fact-checker, writer, planner, monitor, reviewer, codex

// Orchestration:
teamlead

// Specialist profiles (.claude/agents/):
backup-manager, cicd-engineer, database-optimizer,
frontend-developer, openclaw-engineer, product-manager, pr-reviewer,
security-auditor, server-admin, software-architect, technical-writer,
telegram-bot-developer, ui-designer, ux-architect

// Probes:
e2e-probe
```

Fuzzy-match подсказки работают для `set-status`, `get-status`, `heartbeat` — при опечатке покажет "Did you mean: ...".

---

## Bug Tracker

Redis-based баг-трекер. Любой агент может репортить, coder/nerey — триажить.

**Redis-ключи:** `openclaw:bugs:<id>` (hash), `openclaw:bugs:open/fixed/wontfix` (sorted sets), `openclaw:bugs:counter` (auto-increment).

### `bug-report <severity> '<description>' [--reporter <agent>]`

```bash
ocr bug-report P2 'Roundtable cleanup не удаляет :rounds stream' --reporter tester
# {"ok":true,"bug_id":"BUG-7","severity":"P2","status":"open"}
```

Severity: `P0` (critical), `P1` (high), `P2` (medium), `P3` (low).

### `bug-list [--status open|fixed|wontfix|all] [--severity P0-P3] [--reporter <agent>]`

```bash
ocr bug-list
ocr bug-list --status fixed --severity P2
# {"ok":true,"bugs":[...],"count":3}
```

### `bug-fix <bug-id> [--comment '<text>']`

```bash
ocr bug-fix BUG-7 --comment 'Fixed in commit abc123'
# {"ok":true,"bug_id":"BUG-7","status":"fixed"}
```

### `bug-wontfix <bug-id> [--comment '<text>']`

```bash
ocr bug-wontfix BUG-3 --comment 'By design'
# {"ok":true,"bug_id":"BUG-3","status":"wontfix"}
```

### `bug-assign <bug-id> <agent>`

```bash
ocr bug-assign BUG-7 coder
# {"ok":true,"bug_id":"BUG-7","assignee":"coder"}
```

### `bug-detail <bug-id>`

```bash
ocr bug-detail BUG-7
# {"ok":true,"bug":{...}}
```

---

## Task-Status v3

Scoped status messages в Telegram — привязка задач к агентам с live-обновлениями.

**Контракт v3 (strict-only):**
- Только coordinator создаёт через `task-status-create`
- Только coordinator/owner закрывают через `task-status-close`
- Watcher daemon **обычно** не создаёт и не закрывает — только обновляет и auto-join'ит агентов по `run_id`
- **Исключение:** watcher может bootstrap/create tracker при событии `agent_spawned` с OCR/task-status context (через `ensureTaskStatusTracker(...)`)

### `task-status-create --task-id <id> --topic-id <id> --title "..." --agents <csv> --coordinator-id <id> [--owner-id <id>] [--chat-id <id>] [--run-id <id>]`

Создаёт Telegram-сообщение со статусом задачи. Идемпотентно — повторный вызов с тем же `task-id` возвращает существующий `message_id`.

В coordinator-skill режиме только главный координатор должен вызывать `task-status-create/update/close`. Дочерние агенты должны ограничиваться `lifecycle`, `set-status` и `emit`.

```bash
ocr task-status-create --task-id ts-feature-123 --topic-id 1 --title "Новая фича" --agents coder,tester --coordinator-id teamlead
# {"ok":true,"message_id":12345,"task_id":"ts-feature-123"}
```

### `task-status-join --task-id <id> --agent-id <agent>`

Добавляет агента в список участников задачи. Идемпотентно, не дублирует. Отклоняет join для закрытых задач.

```bash
ocr task-status-join --task-id ts-feature-123 --agent-id reviewer
# {"ok":true,"agents":["coder","tester","reviewer"]}
```

### `task-status-update --task-id <id> [--force]`

Принудительно обновляет Telegram-сообщение с текущими статусами агентов.
По умолчанию OCR пропускает no-op и слишком частые edits; `--force` обходит этот локальный guard.

```bash
ocr task-status-update --task-id ts-feature-123
# {"ok":true}
```

### `task-status-close --task-id <id> --result success|fail --actor-id <id>`

Закрывает задачу. Только coordinator или owner могут закрыть. `--actor-id` обязателен.

```bash
ocr task-status-close --task-id ts-feature-123 --result success --actor-id teamlead
# {"ok":true,"status":"completed","closed_by":"teamlead"}
```

---

## Cost Tracking

Per-agent cost tracking через Redis streams и daily aggregates.

### `cost-log <json>`

Записывает cost event от agent run. Вызывается lifecycle hooks или agent wrappers.

```bash
ocr cost-log '{"agent":"coder","model":"claude-opus-4-6","inputTokens":50000,"outputTokens":2000,"cacheReadTokens":30000}'
# {"ok":true,"agent":"coder","model":"claude-opus-4-6","costUsd":0.065,"date":"2026-04-04"}
```

**Поля input JSON:**

| Поле | Обязательное | Описание |
|------|-------------|----------|
| `agent` | ✅ | ID агента (coder, flash, nerey...) |
| `model` | ✅ | ID модели (claude-opus-4-6, gpt-5.4...) |
| `inputTokens` | — | Входные токены (default 0) |
| `outputTokens` | — | Выходные токены (default 0) |
| `cacheReadTokens` | — | KV cache hit токены (default 0) |
| `runId` | — | ID run для трейсинга |

**Redis keys:**
- `openclaw:costs:stream` — raw events (MAXLEN ~50000)
- `openclaw:costs:daily:YYYY-MM-DD` — daily aggregates (TTL 30 дней)

### `cost-report [--today|--days N|--agent ID]`

Агрегированный отчёт по стоимости.

```bash
ocr cost-report --today
# {"ok":true,"period":{"days":1,"from":"2026-04-04","to":"2026-04-04"},"totalUsd":1.23,"totalRequests":45,"byAgent":{"coder":0.85,"flash":0.02,...},"byModel":{...},"byDay":[...]}

ocr cost-report --days 7 --agent coder
# {"ok":true,"period":{"days":7,...},"totalUsd":5.67,"byAgent":{"coder":5.67},"byDay":[...]}
```

**Флаги:**

| Флаг | Описание |
|------|----------|
| `--today` | Только сегодня (default) |
| `--days N` | Последние N дней |
| `--agent ID` | Фильтр по агенту |

---

## Garbage Collection

Fallback cleanup для ключей, переживших свой нормальный lifecycle.

### `gc [--dry-run]`

```bash
ocr gc --dry-run
# {"ok":true,"dry_run":true,"deleted":{"pipelines":0,"feedback_loops":0,...},"total_cleaned":0}

ocr gc
# {"ok":true,"dry_run":false,"deleted":{...},"total_cleaned":19,"message":"Cleaned 19 keys/entries"}
```

**Что чистит:**

| Тип | Max age | Условие |
|-----|---------|---------|
| `openclaw:pipeline:*` | 24h | не в active set |
| `openclaw:pipeline:by-task:*` | 7d | orphaned (нет TTL) |
| `openclaw:feedback-loop:*` | 12h | не в active set |
| `openclaw:tasks:result:*` | 24h | нет активного TTL |
| `openclaw:roundtable:*` | 48h | — |
| `openclaw:task-status:*` | 24h | не в active set |
| `openclaw:bugs:*` (fixed/wontfix) | 30d | — |
| consumer groups (qa-/wdg-/test-) | — | тестовые паттерны |
| `openclaw:events:stream` | — | trim до 500 |
| `openclaw:tasks:stream` | — | trim до 100 |

---

## Daemons

Фоновые сервисы, запускаемые через `ocr daemon <name>`.

### `daemon status-watchdog`

Агент для reconcile статусов — периодически проверяет heartbeats и переводит stale агентов в `idle`.

### `daemon task-status`

Watcher для task-status messages. Pub/Sub используется только как wake-up fast-path, durable source of truth остаётся `openclaw:events:stream`. Watcher обновляет Telegram-сообщения с прогрессом задач и делает auto-join агентов по `run_id` match.

**Контракт:** append-only. Обычно не создаёт и не закрывает задачи — только обновляет и join'ит. **Исключение:** может bootstrap/create tracker при событии `agent_spawned` с OCR/task-status context (через `ensureTaskStatusTracker(...)`).

**Checkpoint:** сохраняет `openclaw:task-status-watcher:last_event_id`, чтобы после рестарта дочитать пропущенные события без дублей.

---

## Reconcile Statuses

### `reconcile-statuses [--dry-run] [--agents a,b] [--auto-idle-ms N] [--active-stale-grace-ms N] [--stale-to-idle-ms N]`

One-shot reconciliation статусов агентов. Переводит агентов в `idle` если:
- Статус `completed`/`failed` и нет активного heartbeat
- Статус `working` но heartbeat протух (stale)

```bash
ocr reconcile-statuses --dry-run
# {"ok":true,"dry_run":true,"reconciled":[...],"count":0}

ocr reconcile-statuses --auto-idle-ms 60000
# {"ok":true,"reconciled":[{"agent":"coder","from":"completed","to":"idle"}],"count":1}
```

---

## Redis Key Schema

| Ключ | Тип | TTL | Описание |
|------|-----|-----|----------|
| `openclaw:tasks:stream` | Stream | trim ~100 | Очередь задач |
| `openclaw:tasks:priority` | Sorted Set | — | Индекс приоритетов задач |
| `openclaw:tasks:result:<id>` | Hash | 24h | Результат выполнения задачи |
| `openclaw:agents:status:<id>` | Hash | — | Статус агента (state, step, progress) |
| `openclaw:heartbeat:<id>` | String | 60s | Heartbeat агента |
| `openclaw:locks:res:<resource>` | String | 300s | Resource lock (value = owner) |
| `openclaw:locks:res:branch:<name>` | String | 1800s | Branch lock |
| `openclaw:locks:task:<id>` | String | — | Task claim lock |
| `openclaw:events:stream` | Stream | trim ~500 | Event log |
| `openclaw:restart:messages` | List | drain on start | Restart mailbox |
| `openclaw:insights` | Sorted Set | — | Insight staging |
| `openclaw:insights:promoted` | Sorted Set | — | Promoted insights |
| `openclaw:roundtable:<id>` | Hash | 48h/auto | Roundtable session |
| `openclaw:roundtable:<id>:rounds` | Stream | auto | Roundtable contributions |
| `openclaw:feedback-loop:<id>` | Hash | 12h | Feedback loop state |
| `openclaw:feedback-loops:active` | Set | — | Active loops index |
| `openclaw:pipeline:<id>` | Hash | 24h | Pipeline state |
| `openclaw:pipelines:active` | Set | — | Active pipelines index |
| `openclaw:pipeline:by-task:<id>` | String | 7d | Task → pipeline mapping |
| `openclaw:task-status:<id>` | Hash | 24h | Task-scoped status |
| `openclaw:task-status:active` | Set | — | Active task-statuses index |
| `openclaw:task-status-watcher:last_event_id` | String | — | Checkpoint XREAD fallback для watcher |
| `openclaw:bugs:<id>` | Hash | 30d (closed) | Bug report |
| `openclaw:bugs:open/fixed/wontfix` | Sorted Set | — | Bug indices |
| `openclaw:bugs:counter` | String | — | Auto-increment bug ID |

---

## Architecture Notes

### Transport

Все Redis-операции выполняются через `redis-cli` (child_process.execSync). Zero npm dependencies. Каждая команда — fork процесса `redis-cli`. Timeout: 20 секунд.

### Circuit Breaker

Файл `/tmp/ocr-circuit.json`. После 5 последовательных ошибок Redis — circuit открывается на 30 секунд. Все операции возвращают `exit code 2` (infra error) пока circuit открыт.

### Retry

3 попытки с exponential backoff для retryable ошибок (ECONNREFUSED, ETIMEDOUT, LOADING, BUSY). Не ретраит: OOM, AUTH errors, business errors.

### Roundtable Auto-Cleanup

Когда последний участник отправляет contribution — roundtable hash и :rounds stream автоматически удаляются. Это значит `roundtable-read` и `roundtable-tally` нужно вызывать **до** последнего contribute, либо использовать `roundtable-synthesize`.

### Consumer Groups

- `openclaw-workers` — для task stream (распределение задач)
- `openclaw-watchers` — для event stream (мониторинг)

GC автоматически удаляет тестовые consumer groups с паттернами `qa-*`, `wdg-*`, `test-*`.

---

## Тестирование

### Запуск тестов

Тесты запускаются внутри OpenClaw контейнера:

```bash
docker exec -it $(docker ps -q -f name=agent_openclaw) sh -c \
  'export OPENCLAW_TELEGRAM_BOT_TOKEN=$(cat /run/secrets/telegram_bot_token) && \
   export OPENCLAW_TELEGRAM_CHAT_ID=$(cat /run/secrets/telegram_chat_id) && \
   export OPENCLAW_TELEGRAM_TOPIC_ID=$(cat /run/secrets/telegram_topic_id 2>/dev/null || printf 1) && \
   node /app/scripts/multiagent/ocr/tests/<test-file>.mjs'
```

Для `task-status` и watcher дефолтный Telegram runtime-config теперь задаётся через env/secrets:

- `OPENCLAW_TELEGRAM_BOT_TOKEN` или `/run/secrets/telegram_bot_token`
- `OPENCLAW_TELEGRAM_CHAT_ID` или `/run/secrets/telegram_chat_id`
- `OPENCLAW_TELEGRAM_TOPIC_ID` или `/run/secrets/telegram_topic_id`

Если `chat_id` не передан в команду и не задан в runtime-config, `task-status-create` и watcher теперь падают явно, а не используют зашитый chat id.

### Набор тестов

| Файл | Покрытие |
|------|----------|
| `integration-smoke.test.mjs` | Tasks, pipelines, loops, roundtables, bugs, task-status v3, GC, watcher |
| `lifecycle-hygiene.test.mjs` | Watchdog requeue, pipeline/loop retention after completion |
| `roundtable-auto-cleanup.test.mjs` | Auto-cleanup при последнем contribute |
| `locks-events.test.mjs` | Locks, branch locks, emit/watch events |
| `mailbox-insights.test.mjs` | Mailbox queue/drain, insight staging/promote/dismiss |
| `routing-dashboard.test.mjs` | Route-task, set/get-status, heartbeat, dashboard |
| `routing-status-guards.test.mjs` | Busy-primary fallback, roundtable recommendation, stale resurrection guard, epoch fence |
| `task-status-watcher-fallback-resume.test.mjs` | Task-status watcher restart, XREAD fallback, resume from last_event_id, no duplicate Telegram message |
| `teamlead-fanout-e2e.test.mjs` | Root task on teamlead, fan-out to coder/tester/reviewer/writer, shared run_id, watcher auto-join, root close |
| `redis-hygiene.test.mjs` | Meta-тест: проверка отсутствия артефактов после тестов |

Дополнительная матрица сценариев и acceptance-кейсов:
[docs/multiagent/ocr-test-cases.md](/mnt/repos/agent/docs/multiagent/ocr-test-cases.md)

### Redis hygiene

Все тесты имеют `finally` блоки для очистки созданных ключей. `redis-hygiene.test.mjs` запускается последним для верификации.

Проверка чистоты вручную:
```bash
redis-cli --scan --pattern 'openclaw:*' | sort > /tmp/before.txt
# ... run tests ...
redis-cli --scan --pattern 'openclaw:*' | sort > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt
```
