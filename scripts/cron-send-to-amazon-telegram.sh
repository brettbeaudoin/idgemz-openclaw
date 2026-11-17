#!/bin/bash
set -euo pipefail

cd /Users/bbeaudoin/clawd/idgemz-openclaw
source /Users/bbeaudoin/clawd/idgemz-openclaw/scripts/cron-env.sh

mkdir -p /Users/bbeaudoin/clawd/idgemz-openclaw/logs
exec >> /Users/bbeaudoin/clawd/idgemz-openclaw/logs/send-to-amazon-telegram.log 2>&1

echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] starting send to amazon telegram"
NODE_HEAP_LIMIT_MB="${SEND_TO_AMAZON_NODE_HEAP_MB:-1536}"
MAX_RUNTIME_SECONDS="${SEND_TO_AMAZON_MAX_RUNTIME_SECONDS:-900}"

is_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

if ! is_positive_integer "$NODE_HEAP_LIMIT_MB" || ! is_positive_integer "$MAX_RUNTIME_SECONDS"; then
  echo "SEND_TO_AMAZON_NODE_HEAP_MB and SEND_TO_AMAZON_MAX_RUNTIME_SECONDS must be positive integers"
  exit 64
fi

# Bound a stalled Amazon SDK call. This is deliberately a guardrail, not a
# substitute for the JavaScript preflight/timeouts: a network outage should
# fail cleanly without allowing the report process to destabilize the gateway.
node --max-old-space-size="$NODE_HEAP_LIMIT_MB" send-to-amazon-daily-telegram.js "$@" &
NODE_PID=$!
(
  sleep "$MAX_RUNTIME_SECONDS"
  if kill -0 "$NODE_PID" 2>/dev/null; then
    echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] send to amazon exceeded ${MAX_RUNTIME_SECONDS}s; terminating pid $NODE_PID"
    # openclaw is a direct child of Node during document delivery. Stop it
    # first so a timed-out parent cannot leave a late/duplicate send behind.
    pkill -TERM -P "$NODE_PID" 2>/dev/null || true
    kill -TERM "$NODE_PID" 2>/dev/null || true
    sleep 10
    if kill -0 "$NODE_PID" 2>/dev/null; then
      pkill -KILL -P "$NODE_PID" 2>/dev/null || true
      kill -KILL "$NODE_PID" 2>/dev/null || true
    fi
  fi
) &
WATCHDOG_PID=$!

wait "$NODE_PID" || EXIT=$?
EXIT="${EXIT:-0}"
kill "$WATCHDOG_PID" 2>/dev/null || true
wait "$WATCHDOG_PID" 2>/dev/null || true
echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] finished send to amazon telegram (exit $EXIT)"
exit $EXIT
