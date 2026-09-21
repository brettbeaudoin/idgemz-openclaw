#!/bin/bash
set -euo pipefail

cd /Users/bbeaudoin/clawd/idgemz-openclaw
source /Users/bbeaudoin/clawd/idgemz-openclaw/scripts/cron-env.sh

mkdir -p /Users/bbeaudoin/clawd/idgemz-openclaw/logs
exec >> /Users/bbeaudoin/clawd/idgemz-openclaw/logs/send-to-walmart-telegram.log 2>&1

echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] starting send to walmart telegram"
if node send-to-walmart-daily-telegram.js; then
  EXIT=0
else
  EXIT=$?
fi
echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] finished send to walmart telegram (exit $EXIT)"
exit $EXIT
