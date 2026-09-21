#!/bin/bash
set -euo pipefail

cd /Users/bbeaudoin/clawd/idgemz-openclaw
source /Users/bbeaudoin/clawd/idgemz-openclaw/scripts/cron-env.sh

mkdir -p /Users/bbeaudoin/clawd/idgemz-openclaw/logs
exec >> /Users/bbeaudoin/clawd/idgemz-openclaw/logs/daily-sales-report-telegram.log 2>&1

echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] starting daily sales report telegram"
if node send-daily-sales-report-telegram.js; then
  EXIT=0
else
  EXIT=$?
fi
echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] finished daily sales report telegram (exit $EXIT)"
exit $EXIT
