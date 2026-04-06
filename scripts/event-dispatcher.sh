#!/usr/bin/env bash
# event-dispatcher.sh — polling event dispatcher for openclaw:events stream
# Reads events via `ocr watch`, dispatches to agents via `openclaw system event --mode now`
# State: /root/.openclaw/state/dispatcher-last-id
# Cooldowns: /root/.openclaw/state/cooldowns/<event_type>
# Mappings: /root/.openclaw/scripts/event-mappings.json

set -euo pipefail

STATE_DIR="/root/.openclaw/state"
COOLDOWN_DIR="${STATE_DIR}/cooldowns"
LAST_ID_FILE="${STATE_DIR}/dispatcher-last-id"
MAPPINGS_FILE="/root/.openclaw/scripts/event-mappings.json"
LOG_TAG="event-dispatcher"

# Ensure dirs exist
mkdir -p "${COOLDOWN_DIR}"

# Load last-id (default to 0-0 = read all new events from now on first run)
if [[ -f "${LAST_ID_FILE}" ]]; then
  LAST_ID=$(cat "${LAST_ID_FILE}")
else
  LAST_ID="0-0"
fi

log() {
  echo "[$(date '+%Y-%m-%d %T')] [${LOG_TAG}] $*" >&2
}

# Emit heartbeat
emit_heartbeat() {
  ocr emit 'dispatcher:heartbeat' '{}' 2>/dev/null || true
}

# Check cooldown: returns 0 if OK to dispatch, 1 if in cooldown
check_cooldown() {
  local event_type="$1"
  local cooldown_sec="$2"
  local safe_type
  safe_type=$(echo "${event_type}" | tr ':/' '__')
  local cooldown_file="${COOLDOWN_DIR}/${safe_type}"

  if [[ -f "${cooldown_file}" ]]; then
    local now
    now=$(date +%s)
    local mtime
    mtime=$(stat -c %Y "${cooldown_file}" 2>/dev/null || echo 0)
    local elapsed=$(( now - mtime ))
    if (( elapsed < cooldown_sec )); then
      log "COOLDOWN: ${event_type} — ${elapsed}s elapsed, need ${cooldown_sec}s"
      return 1
    fi
  fi
  return 0
}

# Update cooldown mtime
touch_cooldown() {
  local event_type="$1"
  local safe_type
  safe_type=$(echo "${event_type}" | tr ':/' '__')
  touch "${COOLDOWN_DIR}/${safe_type}"
}

# Render message template: replace {key} with JSON field values
render_template() {
  local template="$1"
  local json_event="$2"
  local result="${template}"

  # Extract all {key} placeholders and replace with jq values
  while IFS= read -r key; do
    local val
    val=$(echo "${json_event}" | jq -r --arg k "${key}" '.[$k] // ""' 2>/dev/null || echo "")
    result="${result//\{${key}\}/${val}}"
  done < <(echo "${template}" | grep -oP '(?<=\{)[^}]+(?=\})' | sort -u)

  echo "${result}"
}

# Dispatch event to agent
dispatch_event() {
  local event_type="$1"
  local json_event="$2"

  # Check if mapping exists
  local mapping
  mapping=$(jq -r --arg t "${event_type}" '.[$t] // empty' "${MAPPINGS_FILE}" 2>/dev/null)
  if [[ -z "${mapping}" ]]; then
    log "SKIP: no mapping for ${event_type}"
    return 0
  fi

  local agent cooldown_sec template
  agent=$(echo "${mapping}" | jq -r '.agent')
  cooldown_sec=$(echo "${mapping}" | jq -r '.cooldown_sec')
  template=$(echo "${mapping}" | jq -r '.message_template')

  # Check cooldown
  if ! check_cooldown "${event_type}" "${cooldown_sec}"; then
    return 0
  fi

  # Render message
  local message
  message=$(render_template "${template}" "${json_event}")

  log "DISPATCH: ${event_type} → agent:${agent} | msg: ${message:0:80}..."

  # Dispatch via openclaw system event (routed through nerey who delegates to agent)
  openclaw system event --text "делегируй → ${agent}: ${message}" --mode now 2>/dev/null \
    && log "OK: dispatched ${event_type} → ${agent}" \
    || log "WARN: dispatch failed for ${event_type} → ${agent}"

  # Update cooldown
  touch_cooldown "${event_type}"
}

# Main loop: read one batch of events from stream since LAST_ID
main() {
  log "Starting. last-id=${LAST_ID}"

  # Emit heartbeat at start of each run
  emit_heartbeat

  # Read events since last-id (block=0 means non-blocking, just read available)
  # ocr watch reads from openclaw:events stream
  # We use ocr watch with --last-id if supported, otherwise fall back to redis XREAD via ocr
  local raw_events
  raw_events=$(ocr watch "${LAST_ID}" 2>/dev/null || echo "")

  if [[ -z "${raw_events}" ]]; then
    log "No new events"
    exit 0
  fi

  # Parse JSON array of events: [{id, type, ...fields}]
  local event_count
  # ocr watch returns {"ok":true,"events":[...]} — extract .events array
  raw_events=$(echo "${raw_events}" | jq -c '.events // []' 2>/dev/null || echo "[]")
  event_count=$(echo "${raw_events}" | jq 'length' 2>/dev/null || echo 0)

  if (( event_count == 0 )); then
    log "No new events (empty array)"
    exit 0
  fi

  log "Processing ${event_count} event(s)"

  local new_last_id="${LAST_ID}"

  # Process each event
  for i in $(seq 0 $(( event_count - 1 ))); do
    local event
    event=$(echo "${raw_events}" | jq --argjson i "${i}" '.[$i]' 2>/dev/null)
    if [[ -z "${event}" || "${event}" == "null" ]]; then
      continue
    fi

    local event_id event_type
    event_id=$(echo "${event}" | jq -r '.id // ""')
    event_type=$(echo "${event}" | jq -r '.type // ""')

    if [[ -z "${event_type}" ]]; then
      log "SKIP: event without type (id=${event_id})"
    else
      dispatch_event "${event_type}" "${event}"
    fi

    # Track latest id
    if [[ -n "${event_id}" ]]; then
      new_last_id="${event_id}"
    fi
  done

  # Save new last-id
  echo "${new_last_id}" > "${LAST_ID_FILE}"
  log "Done. new last-id=${new_last_id}"
}

main
