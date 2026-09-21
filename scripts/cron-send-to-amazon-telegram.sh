#!/bin/bash
set -euo pipefail

cd /Users/bbeaudoin/clawd/idgemz-openclaw
source /Users/bbeaudoin/clawd/idgemz-openclaw/scripts/cron-env.sh

mkdir -p /Users/bbeaudoin/clawd/idgemz-openclaw/logs
exec >> /Users/bbeaudoin/clawd/idgemz-openclaw/logs/send-to-amazon-telegram.log 2>&1

echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] starting send to amazon telegram"
if node send-to-amazon-daily-telegram.js; then
  EXIT=0
else
  EXIT=$?
fi
echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] finished send to amazon telegram (exit $EXIT)"
exit $EXIT
