#!/usr/bin/env bash
# auto-route.sh — wrapper for ocr route-task
# Usage: auto-route.sh "текст задачи" [source]
# Output: JSON with routing recommendation
# Exit codes: 0=routed, 1=needs_confirm, 2=error

set -euo pipefail

TEXT="${1:?Usage: auto-route.sh 'task text' [source]}"
SOURCE="${2:-manual}"

# Build JSON input
INPUT=$(jq -n --arg text "$TEXT" --arg source "$SOURCE" '{text: $text, source: $source}')

# Route
RESULT=$(ocr route-task "$INPUT" 2>/dev/null) || {
  echo '{"ok":false,"error":"routing_failed"}'
  exit 2
}

# Extract confidence
CONFIDENCE=$(echo "$RESULT" | jq -r '.route.confidence // 0')
NEEDS_RT=$(echo "$RESULT" | jq -r '.route.needs_roundtable // false')

# Decision logic:
# High confidence (>=0.80) → auto-dispatch
# Medium (0.55-0.79) → suggest with confirm
# Low (<0.55) → ask user
# Roundtable → always suggest

if [ "$NEEDS_RT" = "true" ]; then
  echo "$RESULT" | jq '. + {decision: "roundtable"}'
  exit 1
elif awk "BEGIN{exit(!($CONFIDENCE >= 0.80))}"; then
  echo "$RESULT" | jq '. + {decision: "auto"}'
  exit 0
elif awk "BEGIN{exit(!($CONFIDENCE >= 0.55))}"; then
  echo "$RESULT" | jq '. + {decision: "confirm"}'
  exit 1
else
  echo "$RESULT" | jq '. + {decision: "ask"}'
  exit 1
fi
